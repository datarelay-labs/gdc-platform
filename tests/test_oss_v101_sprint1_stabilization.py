"""OSS v1.0.1 Sprint 1 — rate limit lifecycle, AI config resolve unification."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.ai_providers.models import AiProvider
from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.destinations.models import Destination
from app.dynamic_routing.dynamic_routing_engine import evaluate_batch
from app.dynamic_routing.operator_workflow import create_dynamic_route
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.rate_limit.destination_limiter import DestinationRateLimiter
from app.routes.models import Route
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.runtime import replay_service
from app.sources.models import Source
from app.streams.models import Stream
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _add_enabled_route_for_destination,
    _build_runner,
    _seed_stream_runtime,
)


def test_scheduler_rate_limit_persists_across_poll_cycles(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: scheduler poll loop must not reset DestinationRateLimiter each cycle."""

    from app.scheduler import scheduler as sched_mod
    from app.scheduler.enabled_state import EnabledStateCache, StreamSchedulerGate

    db = db_session
    seeded = _seed_stream_runtime(
        db,
        route_rate_limit_jsons=[{"max_events": 1, "per_seconds": 3600}],
    )
    stream_id = seeded["stream_id"]
    sender = _FakeWebhookSender()
    run_calls: list[int] = []

    def _loader() -> dict[int, StreamSchedulerGate]:
        # Stay enabled until two successful run() invocations complete.
        enabled = len(run_calls) < 2
        return {
            int(stream_id): StreamSchedulerGate(
                stream_id=int(stream_id),
                enabled=enabled,
                polling_interval=0.01,
                name=f"pytest-scheduler-rate-limit-{stream_id}",
            )
        }

    injected = _build_runner(
        poller=_FakePoller(
            response={"items": [{"id": "rl-sched-1", "message": "m", "vendor": "V"}]}
        ),
        webhook_sender=sender,
        destination_limiter=DestinationRateLimiter(),
    )
    original_run = injected.run

    def _counting_run(*args: Any, **kwargs: Any) -> Any:
        result = original_run(*args, **kwargs)
        run_calls.append(1)
        return result

    injected.run = _counting_run  # type: ignore[method-assign]

    monkeypatch.setattr(sched_mod, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(
        sched_mod,
        "enabled_state_cache",
        EnabledStateCache(ttl_sec=0.01, loader=_loader),
    )

    sched = sched_mod.Scheduler(runner=injected)
    sched._loop_stream(stream_id)

    assert len(run_calls) == 2
    assert len(sender.calls) == 1


def test_delivery_log_replay_ai_provider_resolves_runtime_config(db_session: Session) -> None:
    """Delivery log replay must resolve AI_PROVIDER_POST config like M11 replay engine."""

    provider = AiProvider(
        name="dl-replay-openai",
        provider_type="OPENAI",
        enabled=True,
        endpoint_url="https://api.openai.com",
        auth_json={"api_key": "sk-dl-replay"},
        default_model="gpt-4o",
        timeout_seconds=30,
    )
    connector = Connector(name="dl-replay-connector", description="", status="RUNNING")
    db_session.add_all([provider, connector])
    db_session.flush()

    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db_session.add(source)
    db_session.flush()

    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="dl-replay-stream",
        stream_type="HTTP_API_POLLING",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db_session.add(stream)
    db_session.flush()

    mapping = Mapping(
        stream_id=stream.id,
        event_array_path=None,
        field_mappings_json={"provider_request": "$.provider_request"},
        raw_payload_mode="JSON",
    )
    enrichment = Enrichment(
        stream_id=stream.id,
        enrichment_json={},
        override_policy="KEEP_EXISTING",
        enabled=True,
    )
    destination = Destination(
        name="dl-replay-ai-dest",
        destination_type="AI_PROVIDER_POST",
        config_json={"provider_id": int(provider.id), "retry_count": 0},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add_all([mapping, enrichment, destination])
    db_session.flush()

    route = Route(
        stream_id=stream.id,
        destination_id=destination.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db_session.add(route)
    db_session.add(
        Checkpoint(
            stream_id=stream.id,
            checkpoint_type="EVENT_ID",
            checkpoint_value_json={"last_success_event": {"event_id": "seed-0"}},
        )
    )
    db_session.flush()

    events = [
        {
            "provider_request": {
                "model": "gpt-4o",
                "messages": [{"role": "user", "content": "replay via delivery log"}],
            }
        }
    ]
    log_row = DeliveryLog(
        connector_id=None,
        stream_id=int(stream.id),
        route_id=int(route.id),
        destination_id=int(destination.id),
        stage="route_send_failed",
        level="ERROR",
        status="FAILED",
        message="ai provider send failed",
        payload_sample={"replay_events": events},
        retry_count=0,
        error_code="RuntimeError",
        run_id="run-dl-ai-replay",
    )
    db_session.add(log_row)
    db_session.commit()

    captured: dict[str, Any] = {}

    class _CapturingAdapter:
        def send(
            self,
            events_arg: list[dict[str, Any]],
            destination_config: dict[str, Any],
            formatter_override: dict[str, Any] | None = None,
            *,
            prefix_context: dict[str, Any] | None = None,
        ) -> None:
            _ = events_arg, formatter_override, prefix_context
            captured["config"] = destination_config

    class _CapturingRegistry(DestinationAdapterRegistry):
        def get(self, destination_type: str) -> _CapturingAdapter:
            _ = destination_type
            return _CapturingAdapter()

    result = replay_service.replay_delivery_log(
        db_session,
        int(log_row.id),
        dry_run=False,
        destination_registry=_CapturingRegistry(),
    )
    db_session.commit()

    assert result.outcome == "delivered"
    assert "_provider" in captured["config"]
    assert captured["config"]["_provider"]["provider_type"] == "OPENAI"
    assert captured["config"]["_provider"]["endpoint_url"] == "https://api.openai.com"


def test_dynamic_routing_ai_provider_resolves_runtime_config(db_session: Session) -> None:
    """Dynamic route matches must include resolved AI_PROVIDER_POST runtime config."""

    provider = AiProvider(
        name="dyn-openai",
        provider_type="OPENAI",
        enabled=True,
        endpoint_url="https://api.openai.com",
        auth_json={"api_key": "sk-dyn"},
        default_model="gpt-4o",
        timeout_seconds=30,
    )
    db_session.add(provider)
    db_session.flush()

    ai_dest = Destination(
        name="dyn-ai-dest",
        destination_type="AI_PROVIDER_POST",
        config_json={"provider_id": int(provider.id), "retry_count": 0},
        rate_limit_json={},
        enabled=True,
    )
    db_session.add(ai_dest)
    db_session.flush()

    seeded = _seed_stream_runtime(db_session)
    _add_enabled_route_for_destination(db_session, int(seeded["stream_id"]), int(ai_dest.id))
    create_dynamic_route(
        db_session,
        stream_id=int(seeded["stream_id"]),
        name="pii-to-ai",
        enabled=True,
        condition_json={"sensitivity_class": "pii"},
        destination_id=int(ai_dest.id),
    )
    db_session.commit()

    events = [
        {
            "message": "contact user@example.com",
            "sensitive_findings": [{"sensitivity_class": "pii", "field": "message"}],
        }
    ]
    result = evaluate_batch(
        db_session,
        stream_id=int(seeded["stream_id"]),
        events=events,
        findings=[{"sensitivity_class": "pii", "field": "message"}],
    )

    assert len(result.matches) == 1
    match = result.matches[0]
    assert match.destination_type == "AI_PROVIDER_POST"
    assert "_provider" in match.destination_config
    assert match.destination_config["_provider"]["provider_type"] == "OPENAI"
    assert match.destination_config["_provider"]["default_model"] == "gpt-4o"


def test_resolve_destination_runtime_config_unit() -> None:
    """Unit: shared helper resolves AI_PROVIDER_POST and passes through other types."""

    from app.ai_providers.runtime_config import resolve_destination_runtime_config

    db = MagicMock()
    with patch(
        "app.ai_providers.runtime_config.resolve_ai_provider_destination_config",
        return_value={"provider_id": 1, "_provider": {"provider_type": "OPENAI"}},
    ) as mock_resolve:
        resolved = resolve_destination_runtime_config(
            db,
            "AI_PROVIDER_POST",
            {"provider_id": 1},
        )
        mock_resolve.assert_called_once_with(db, {"provider_id": 1})
        assert resolved["_provider"]["provider_type"] == "OPENAI"

    webhook_cfg = resolve_destination_runtime_config(db, "WEBHOOK_POST", {"url": "https://example.com"})
    assert webhook_cfg == {"url": "https://example.com"}
