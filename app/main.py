"""FastAPI application entry — Generic Data Connector Platform API."""

from contextlib import asynccontextmanager
import logging
from pathlib import Path

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.auth.role_guard import role_guard_middleware
from app.auth.router import router as auth_router
from app.middleware.read_api_timing import ReadApiTimingMiddleware
from app.middleware.slow_query_context import SlowQueryRequestContextMiddleware
from app.platform_admin.alert_monitor import PlatformAlertMonitor, register_alert_monitor
from app.platform_admin.router import router as platform_admin_router
from app.retention.router import router as retention_router
from app.db.partition_maintenance_scheduler import (
    PartitionMaintenanceScheduler,
    register_partition_maintenance_scheduler,
)
from app.runtime.runtime_analytics_bucket_scheduler import (
    RuntimeAnalyticsBucketScheduler,
    register_runtime_analytics_bucket_scheduler,
)
from app.runtime.runtime_snapshot_scheduler import (
    RuntimeSnapshotScheduler,
    register_runtime_snapshot_scheduler,
)
from app.retention.scheduler import (
    OperationalRetentionScheduler,
    register_operational_retention_scheduler,
)
from app.audit.router import router as audit_router
from app.backup.router import router as backup_router
from app.backfill.router import router as backfill_router
from app.config import settings
from app.production_security import ensure_production_security_settings
from app.connectors.router import router as connectors_router
from app.delivery.router import router as delivery_router
from app.destinations.router import router as destinations_router
from app.enrichments.router import router as enrichments_router
from app.ingest.router import router as ingest_router
from app.logs.router import router as logs_router
from app.mappings.router import router as mappings_router
from app.routes.router import router as routes_router
from app.runtime.router import router as runtime_router
from app.scheduler.enabled_streams import load_enabled_stream_contexts
from app.scheduler.runtime_state import register_scheduler_instance
from app.scheduler.scheduler import Scheduler
from app.sources.router import router as sources_router
from app.database import engine
from app.startup_readiness import evaluate_startup_readiness, log_startup_readiness_summary
from app.streams.router import router as streams_router
from app.templates.router import router as templates_router
from app.connectors_registry import bootstrap_registry
from app.connectors_registry.router import router as connectors_registry_router
from app.connector_templates.router import router as connector_templates_router
from app.validation.periodic_scheduler import ContinuousValidationScheduler, set_validation_scheduler
from app.validation.router import router as validation_router
from app.governance.router import router as governance_router
from app.platform_admin.delivery_logs_index_probe import probe_delivery_logs_indexes

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_production_security_settings(settings)
    startup_snapshot = evaluate_startup_readiness()
    try:
        bootstrap_registry()
    except Exception as exc:  # pragma: no cover - fail-open boot guard
        logger.warning(
            "%s",
            {
                "stage": "connector_registry_startup_failed",
                "error_type": type(exc).__name__,
                "message": str(exc),
            },
        )
    from app.governance_notifications.email_sender import SmtpEmailSender, set_email_sender

    set_email_sender(SmtpEmailSender())
    if settings.APP_ENV.lower() in {"production", "prod"}:
        from app.governance_notifications.webhook_sender import HttpWebhookSender, set_webhook_sender

        set_webhook_sender(HttpWebhookSender(timeout_seconds=float(settings.WEBHOOK_TIMEOUT)))
    scheduler = Scheduler(streams_provider=load_enabled_stream_contexts)
    register_scheduler_instance(scheduler)
    validation_scheduler = ContinuousValidationScheduler()
    set_validation_scheduler(validation_scheduler)
    operational_retention_scheduler = OperationalRetentionScheduler()
    register_operational_retention_scheduler(operational_retention_scheduler)
    partition_maintenance_scheduler = PartitionMaintenanceScheduler(
        tick_seconds=float(settings.GDC_PARTITION_MAINTENANCE_TICK_SECONDS),
    )
    register_partition_maintenance_scheduler(partition_maintenance_scheduler)
    runtime_snapshot_scheduler = RuntimeSnapshotScheduler()
    register_runtime_snapshot_scheduler(runtime_snapshot_scheduler)
    runtime_analytics_bucket_scheduler = RuntimeAnalyticsBucketScheduler()
    register_runtime_analytics_bucket_scheduler(runtime_analytics_bucket_scheduler)
    alert_monitor = PlatformAlertMonitor()
    register_alert_monitor(alert_monitor)
    scheduler_started = False
    try:
        try:
            from app.dev_validation_lab.startup_checks import log_dev_validation_runtime_startup_checks

            log_dev_validation_runtime_startup_checks()
        except Exception as exc:  # pragma: no cover - fail-open boot guard
            logger.warning(
                "%s",
                {
                    "stage": "dev_validation_runtime_startup_checks_failed",
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                },
            )
        if startup_snapshot.schema_ready:
            try:
                from app.db.partition_maintenance import run_partition_maintenance_gracefully

                run_partition_maintenance_gracefully(
                    months_ahead=max(1, int(settings.GDC_PARTITION_MAINTENANCE_MONTHS_AHEAD)),
                )
            except Exception as exc:  # pragma: no cover - fail-open boot guard
                logger.warning(
                    "%s",
                    {
                        "stage": "partition_maintenance_startup_failed",
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                    },
                )
        if startup_snapshot.scheduler_active and bool(settings.GDC_ENABLE_IN_PROCESS_SCHEDULER):
            try:
                from app.dev_validation_lab.runtime import run_dev_validation_lab_startup

                run_dev_validation_lab_startup()
            except Exception as exc:  # pragma: no cover - fail-open boot guard
                logger.warning(
                    "%s",
                    {
                        "stage": "dev_validation_lab_startup_failed",
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                    },
                )
            scheduler.start()
            validation_scheduler.start()
            operational_retention_scheduler.start()
            partition_maintenance_scheduler.start()
            runtime_snapshot_scheduler.start()
            runtime_analytics_bucket_scheduler.start()
            alert_monitor.start()
            scheduler_started = True
            logger.info("%s", {"stage": "scheduler_started_from_lifespan"})
        # Schema not ready: evaluate_startup_readiness already emitted structured startup_database_not_ready;
        # do not start supervisor (avoids scheduler_supervisor_error spam).
    except Exception as exc:  # pragma: no cover - startup guard
        logger.error(
            "%s",
            {
                "stage": "scheduler_start_failed",
                "error_type": type(exc).__name__,
                "message": str(exc),
            },
        )
    log_startup_readiness_summary(startup_snapshot, scheduler_started=scheduler_started)
    try:
        yield
    finally:
        alert_monitor.stop()
        register_alert_monitor(None)
        runtime_snapshot_scheduler.stop()
        register_runtime_snapshot_scheduler(None)
        runtime_analytics_bucket_scheduler.stop()
        register_runtime_analytics_bucket_scheduler(None)
        partition_maintenance_scheduler.stop()
        register_partition_maintenance_scheduler(None)
        operational_retention_scheduler.stop()
        register_operational_retention_scheduler(None)
        validation_scheduler.stop()
        set_validation_scheduler(None)
        scheduler.stop()
        try:
            from app.dev_validation_lab.runtime import stop_dev_validation_lab_runtime

            stop_dev_validation_lab_runtime()
        except Exception:  # pragma: no cover - shutdown guard
            pass


app = FastAPI(
    title="Generic Data Connector Platform API",
    version="0.1.0",
    lifespan=lifespan,
)

if settings.GDC_TRUST_PROXY_HEADERS:
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    _th = (settings.GDC_PROXY_FORWARD_TRUSTED_HOSTS or "*").strip()
    if "," in _th:
        _hosts = [h.strip() for h in _th.split(",") if h.strip()]
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=_hosts)
    else:
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=_th)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(SlowQueryRequestContextMiddleware)
app.add_middleware(ReadApiTimingMiddleware)

app.middleware("http")(role_guard_middleware)

_prefix = settings.API_PREFIX

app.include_router(auth_router, prefix=f"{_prefix}/auth", tags=["auth"])
# Operator/admin HTTP surface: HTTPS, users, retention, maintenance, and lab diagnostics
# (e.g. GET {API_PREFIX}/admin/dev-validation/status — see app.platform_admin.router).
app.include_router(platform_admin_router, prefix=f"{_prefix}/admin", tags=["admin"])
app.include_router(connectors_router, prefix=f"{_prefix}/connectors", tags=["connectors"])
app.include_router(sources_router, prefix=f"{_prefix}/sources", tags=["sources"])
app.include_router(streams_router, prefix=f"{_prefix}/streams", tags=["streams"])
app.include_router(templates_router, prefix=f"{_prefix}/templates", tags=["templates"])
app.include_router(
    connectors_registry_router,
    prefix=f"{_prefix}/connectors-registry",
    tags=["connectors-registry"],
)
app.include_router(
    connector_templates_router,
    prefix=f"{_prefix}/connector-templates",
    tags=["connector-templates"],
)
app.include_router(audit_router, prefix=f"{_prefix}/audit-logs", tags=["audit-logs"])
app.include_router(backup_router, prefix=f"{_prefix}/backup", tags=["backup"])
app.include_router(backfill_router, prefix=f"{_prefix}/backfill", tags=["backfill"])
app.include_router(mappings_router, prefix=f"{_prefix}/mappings", tags=["mappings"])
app.include_router(enrichments_router, prefix=f"{_prefix}/enrichments", tags=["enrichments"])
app.include_router(destinations_router, prefix=f"{_prefix}/destinations", tags=["destinations"])
app.include_router(routes_router, prefix=f"{_prefix}/routes", tags=["routes"])
app.include_router(logs_router, prefix=f"{_prefix}/logs", tags=["logs"])
app.include_router(runtime_router, prefix=f"{_prefix}/runtime", tags=["runtime"])
app.include_router(ingest_router, prefix=f"{_prefix}/ingest", tags=["ingest"])
app.include_router(retention_router, prefix=f"{_prefix}/retention", tags=["retention"])
app.include_router(delivery_router, prefix=f"{_prefix}/delivery", tags=["delivery"])
app.include_router(validation_router, prefix=f"{_prefix}/validation", tags=["validation"])
# AI Gateway HTTP routers are not part of Data Relay OSS product scope.
# Historical modules remain in-tree; do not mount them here.
app.include_router(governance_router, prefix=f"{_prefix}/governance", tags=["governance"])


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness/readiness probe; includes ``delivery_logs`` index catalog when PostgreSQL is reachable."""

    body: dict[str, Any] = {"status": "ok"}
    try:
        with engine.connect() as conn:
            probe = probe_delivery_logs_indexes(conn)
        body["delivery_logs_indexes"] = {
            "ok": probe.get("error") is None and not bool(probe.get("reindex_suggested")),
            "checked": bool(probe.get("checked")),
            "invalid_indexes": list(probe.get("invalid_indexes") or []),
            "reindex_suggested": bool(probe.get("reindex_suggested")),
            "error": probe.get("error"),
        }
        if bool(probe.get("reindex_suggested")):
            body["status"] = "degraded"
    except Exception as exc:
        body["delivery_logs_indexes"] = {
            "ok": None,
            "checked": False,
            "invalid_indexes": [],
            "reindex_suggested": False,
            "error": f"{type(exc).__name__}: {str(exc)[:160]}",
        }
    return body


_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
_FRONTEND_INDEX = _FRONTEND_DIST / "index.html"
_FRONTEND_ASSETS = _FRONTEND_DIST / "assets"
_FRONTEND_LOGO = _FRONTEND_DIST / "logo"


@app.get("/", include_in_schema=False, response_model=None)
async def ui_root():
    """Serve the React shell when built; otherwise show how to run the Vite dev server."""

    if _FRONTEND_INDEX.is_file():
        return FileResponse(_FRONTEND_INDEX)
    return HTMLResponse(
        content="""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GDC Platform — UI</title>
</head>
<body style="font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.55;color:#1e293b">
  <h1 style="font-size:1.25rem">GDC Platform 웹 UI</h1>
  <p>이 주소(<code>http://서버:8000/</code>)에서 UI를 보려면 아래 중 하나가 필요합니다.</p>
  <h2 style="font-size:1rem;margin-top:1.5rem">1) 개발 서버 (권장)</h2>
  <pre style="background:#f1f5f9;padding:0.75rem;border-radius:0.5rem;overflow:auto">cd frontend
npm install
npm run dev</pre>
  <p>브라우저에서 <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a> (또는 터미널에 표시된 URL)로 접속하세요.</p>
  <h2 style="font-size:1rem;margin-top:1.5rem">2) 이 API 서버에서 정적 UI 제공</h2>
  <pre style="background:#f1f5f9;padding:0.75rem;border-radius:0.5rem;overflow:auto">cd frontend
npm install
npm run build</pre>
  <p>빌드 후 다시 <code>/</code>를 열면 대시보드가 표시됩니다. API는 그대로 <code>/api/v1</code> 를 사용합니다.</p>
</body>
</html>""",
        status_code=200,
    )


if _FRONTEND_ASSETS.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_FRONTEND_ASSETS)), name="ui-assets")

if _FRONTEND_LOGO.is_dir():
    app.mount("/logo", StaticFiles(directory=str(_FRONTEND_LOGO)), name="ui-logo")


@app.get("/favicon.svg", include_in_schema=False)
async def ui_favicon() -> FileResponse:
    """Vite build emits favicon at repo root of dist."""

    path = _FRONTEND_DIST / "favicon.svg"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="favicon not built")
    return FileResponse(path)


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    """Serve the SPA shell for client-side routes (React Router).

    Without this, paths like ``/streams`` hit no FastAPI route and return 404.
    API remains under ``settings.API_PREFIX`` (default ``/api/v1``).
    """

    head = full_path.split("/", maxsplit=1)[0]
    if head in {"docs", "redoc", "openapi.json"} or full_path.startswith("openapi"):
        raise HTTPException(status_code=404, detail="Not Found")

    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not Found")

    if _FRONTEND_INDEX.is_file():
        return FileResponse(_FRONTEND_INDEX)

    raise HTTPException(status_code=404, detail="UI not built — run `npm run build` in frontend/")
