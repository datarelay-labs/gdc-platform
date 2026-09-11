"""P1 responsibility boundary: shared route delivery primitive (no new runtime engine)."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from app.route_delivery.config import RouteSendOutcome
from app.runners.route_context import (
    RouteEffectiveConfig,
    RouteRuntimeContext,
    RouteTransformConfig,
)
from app.runners.stream_runner import StreamRunner


def _route(
    *,
    route_id: int,
    destination_id: int,
    failure_policy: str = "LOG_AND_CONTINUE",
    enabled: bool = True,
    dest_enabled: bool = True,
) -> dict[str, Any]:
    return {
        "id": route_id,
        "enabled": enabled,
        "failure_policy": failure_policy,
        "formatter_config_json": {},
        "destination": {
            "id": destination_id,
            "enabled": dest_enabled,
            "destination_type": "WEBHOOK_POST",
            "config": {"url": f"http://example.invalid/{destination_id}"},
            "name": f"dest-{destination_id}",
        },
    }


def _stream(*routes: dict[str, Any]) -> dict[str, Any]:
    return {"id": 10, "name": "s", "routes": list(routes)}


def _route_ctx(route_id: int, destination_id: int) -> RouteRuntimeContext:
    return RouteRuntimeContext(
        route_id=route_id,
        stream_id=10,
        destination_id=destination_id,
        route_name=f"r{route_id}",
        route_type="WEBHOOK_POST",
        formatter={},
        delivery_policy="LOG_AND_CONTINUE",
        rate_limit={},
        metadata={},
        effective_config=RouteEffectiveConfig(
            transform=RouteTransformConfig(
                field_mappings={},
                enrichment={},
                override_policy="KEEP_EXISTING",
                mapping_source="stream",
                enrichment_source="stream",
            )
        ),
    )


@pytest.fixture
def runner() -> StreamRunner:
    r = StreamRunner(
        poller=MagicMock(),
        webhook_sender=MagicMock(),
        syslog_sender=MagicMock(),
    )
    r._db_read = MagicMock(return_value={})  # type: ignore[method-assign]
    r._db_write = MagicMock()  # type: ignore[method-assign]
    r._log = MagicMock()  # type: ignore[method-assign]
    r._emit_obs = MagicMock()  # type: ignore[method-assign]
    r._set_stream_status = MagicMock()  # type: ignore[method-assign]
    r._maybe_record_replay_event = MagicMock()  # type: ignore[method-assign]
    r._attempt_failover_send = MagicMock(  # type: ignore[method-assign]
        return_value=MagicMock(
            attempted=False,
            succeeded=False,
            secondary_send_attempted=False,
            secondary_error=None,
        )
    )
    return r


def test_send_route_events_does_not_fetch_source_or_checkpoint(runner: StreamRunner) -> None:
    """Delivery boundary owns send only — not source acquisition or checkpoint."""

    runner._collect_and_transform_events = MagicMock()  # type: ignore[method-assign]
    runner._update_checkpoint_after_success = MagicMock()  # type: ignore[method-assign]
    runner._send_to_destination = MagicMock()  # type: ignore[method-assign]

    stream = _stream(_route(route_id=1, destination_id=20))
    outcome = runner._send_route_events(stream, stream["routes"][0], [{"message": "a"}])

    assert outcome.success is True
    runner._send_to_destination.assert_called_once()
    runner._collect_and_transform_events.assert_not_called()
    runner._update_checkpoint_after_success.assert_not_called()


def test_fan_out_delegates_each_route_to_shared_send_primitive(runner: StreamRunner) -> None:
    """OFF fan-out iterates routes at Stream scope but uses one delivery primitive per route."""

    calls: list[int] = []

    def _capture(stream: Any, route: Any, events: list[dict[str, Any]], **kwargs: Any) -> RouteSendOutcome:
        calls.append(int(route["id"]))
        assert kwargs.get("record_replay_on_failure") is True
        assert "failover_bindings" in kwargs
        return RouteSendOutcome(success=True, latency_ms=1, adapter_stage="route_send_success")

    runner._send_route_events = _capture  # type: ignore[method-assign]
    stream = _stream(
        _route(route_id=1, destination_id=20),
        _route(route_id=2, destination_id=21),
    )
    outcome = runner._fan_out(stream, [{"id": 1}])
    assert calls == [1, 2]
    assert len(outcome.successful_events) == 1


def test_deliver_single_route_delegates_to_shared_send_primitive(runner: StreamRunner) -> None:
    seen: list[int] = []

    def _capture(stream: Any, route: Any, events: list[dict[str, Any]], **kwargs: Any) -> RouteSendOutcome:
        seen.append(int(route["id"]))
        assert kwargs.get("record_replay_on_failure") is True
        return RouteSendOutcome(success=True, latency_ms=2, adapter_stage="route_send_success")

    runner._send_route_events = _capture  # type: ignore[method-assign]
    stream = _stream(_route(route_id=7, destination_id=70))
    out = runner._deliver_single_route(stream, _route_ctx(7, 70), [{"x": 1}])
    assert out.success is True
    assert seen == [7]


def test_fan_out_log_and_continue_absorbs_failure_without_checkpoint_eligibility(runner: StreamRunner) -> None:
    def _fail(stream: Any, route: Any, events: list[dict[str, Any]], **kwargs: Any) -> RouteSendOutcome:
        return RouteSendOutcome(
            success=False,
            latency_ms=3,
            adapter_stage="route_send_failed",
            error="boom",
            failure_absorbed=True,
            primary_send_failed=True,
        )

    runner._send_route_events = _fail  # type: ignore[method-assign]
    stream = _stream(_route(route_id=1, destination_id=20, failure_policy="LOG_AND_CONTINUE"))
    outcome = runner._fan_out(stream, [{"id": 1}])
    assert outcome.successful_events == []
    assert outcome.log_continue_failed_route_ids == (1,)


def test_fan_out_pause_policy_blocks_checkpoint_eligibility(runner: StreamRunner) -> None:
    def _fail(stream: Any, route: Any, events: list[dict[str, Any]], **kwargs: Any) -> RouteSendOutcome:
        return RouteSendOutcome(
            success=False,
            latency_ms=3,
            adapter_stage="route_send_failed",
            error="boom",
            primary_send_failed=True,
        )

    runner._send_route_events = _fail  # type: ignore[method-assign]
    stream = _stream(_route(route_id=1, destination_id=20, failure_policy="PAUSE_STREAM_ON_FAILURE"))
    outcome = runner._fan_out(stream, [{"id": 1}])
    assert outcome.successful_events == []


def test_fan_out_single_route_success_keeps_events(runner: StreamRunner) -> None:
    runner._send_route_events = MagicMock(  # type: ignore[method-assign]
        return_value=RouteSendOutcome(success=True, latency_ms=1, adapter_stage="route_send_success")
    )
    stream = _stream(_route(route_id=1, destination_id=20))
    outcome = runner._fan_out(stream, [{"id": "e1"}])
    assert len(outcome.successful_events) == 1


def test_fan_out_multi_route_all_success_keeps_events(runner: StreamRunner) -> None:
    runner._send_route_events = MagicMock(  # type: ignore[method-assign]
        return_value=RouteSendOutcome(success=True, latency_ms=1, adapter_stage="route_send_success")
    )
    stream = _stream(
        _route(route_id=1, destination_id=20),
        _route(route_id=2, destination_id=21),
    )
    outcome = runner._fan_out(stream, [{"id": "e1"}])
    assert len(outcome.successful_events) == 1


def test_fan_out_multi_route_all_failure_no_checkpoint(runner: StreamRunner) -> None:
    def _fail(stream: Any, route: Any, events: list[dict[str, Any]], **kwargs: Any) -> RouteSendOutcome:
        return RouteSendOutcome(
            success=False,
            latency_ms=1,
            failure_absorbed=True,
            primary_send_failed=True,
            adapter_stage="route_send_failed",
            error="fail",
        )

    runner._send_route_events = _fail  # type: ignore[method-assign]
    stream = _stream(
        _route(route_id=1, destination_id=20),
        _route(route_id=2, destination_id=21),
    )
    outcome = runner._fan_out(stream, [{"id": "e1"}])
    assert outcome.successful_events == []
    assert set(outcome.log_continue_failed_route_ids) == {1, 2}


def test_fan_out_failover_primary_fail_secondary_success_keeps_events(runner: StreamRunner) -> None:
    runner._send_route_events = MagicMock(  # type: ignore[method-assign]
        return_value=RouteSendOutcome(
            success=True,
            latency_ms=1,
            adapter_stage="route_send_success",
            primary_send_failed=True,
            failover_attempted=True,
            failover_succeeded=True,
        )
    )
    stream = _stream(_route(route_id=1, destination_id=20, failure_policy="LOG_AND_CONTINUE"))
    outcome = runner._fan_out(stream, [{"id": "e1"}])
    assert len(outcome.successful_events) == 1
    assert outcome.log_continue_failed_route_ids == (1,)
    assert outcome.failover_success_count == 1


def test_fan_out_failover_both_fail_no_checkpoint(runner: StreamRunner) -> None:
    runner._send_route_events = MagicMock(  # type: ignore[method-assign]
        return_value=RouteSendOutcome(
            success=False,
            latency_ms=1,
            adapter_stage="route_send_failed",
            error="failover exhausted",
            primary_send_failed=True,
            failure_absorbed=True,
            failover_attempted=True,
            failover_succeeded=False,
        )
    )
    stream = _stream(_route(route_id=1, destination_id=20, failure_policy="LOG_AND_CONTINUE"))
    outcome = runner._fan_out(stream, [{"id": "e1"}])
    assert outcome.successful_events == []
    assert outcome.log_continue_failed_route_ids == (1,)
    assert outcome.failover_failure_count == 1


def test_multi_route_one_absorbed_one_success_keeps_events(runner: StreamRunner) -> None:
    def _mixed(stream: Any, route: Any, events: list[dict[str, Any]], **kwargs: Any) -> RouteSendOutcome:
        rid = int(route["id"])
        if rid == 1:
            return RouteSendOutcome(
                success=False,
                latency_ms=1,
                failure_absorbed=True,
                primary_send_failed=True,
                adapter_stage="route_send_failed",
                error="fail",
            )
        return RouteSendOutcome(success=True, latency_ms=1, adapter_stage="route_send_success")

    runner._send_route_events = _mixed  # type: ignore[method-assign]
    stream = _stream(
        _route(route_id=1, destination_id=20),
        _route(route_id=2, destination_id=21),
    )
    outcome = runner._fan_out(stream, [{"id": "e1"}])
    assert len(outcome.successful_events) == 1
    assert outcome.log_continue_failed_route_ids == (1,)


def test_send_route_events_does_not_invoke_source_or_checkpoint_owners(runner: StreamRunner) -> None:
    """N routes share Stream-owned fetch; delivery primitive must not re-acquire source or checkpoint."""

    runner._collect_and_transform_events = MagicMock()  # type: ignore[method-assign]
    runner._resolve_checkpoint = MagicMock()  # type: ignore[method-assign]
    runner._update_checkpoint_after_success = MagicMock()  # type: ignore[method-assign]
    runner._send_to_destination = MagicMock()  # type: ignore[method-assign]

    stream = _stream(
        _route(route_id=1, destination_id=20),
        _route(route_id=2, destination_id=21),
    )
    for route in stream["routes"]:
        out = runner._send_route_events(stream, route, [{"m": 1}])
        assert out.success is True

    assert runner._send_to_destination.call_count == 2
    runner._collect_and_transform_events.assert_not_called()
    runner._resolve_checkpoint.assert_not_called()
    runner._update_checkpoint_after_success.assert_not_called()


def test_route_send_outcome_defaults_preserve_public_contract() -> None:
    out = RouteSendOutcome(success=True, latency_ms=0)
    assert out.failure_absorbed is False
    assert out.primary_send_failed is False
    assert out.failover_attempted is False


def test_route_delivery_result_defaults_include_failover_flags() -> None:
    from datetime import datetime, timezone

    from app.route_delivery.config import RouteDeliveryResult

    result = RouteDeliveryResult(
        route_id=1,
        stream_id=10,
        destination_id=20,
        batch_id="b1",
        run_id="r1",
        delivery_allowed=True,
        delivery_disposition="delivered",
        delivery_success=True,
        delivery_error=None,
        delivery_timestamp=datetime.now(timezone.utc),
        policy_action="allow",
        decision_reason="ok",
        skip_reason=None,
        event_count=1,
        latency_ms=1,
        adapter_stage="route_send_success",
        quarantine_event_id=None,
        delivery_log_id=None,
    )
    assert result.failover_attempted is False
    assert result.failover_succeeded is False
