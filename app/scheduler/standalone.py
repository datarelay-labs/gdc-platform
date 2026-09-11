"""Dedicated scheduler process entry (no uvicorn / API)."""

from __future__ import annotations

import logging
import signal
import threading
import time

from app.config import settings
from app.production_security import ensure_production_security_settings
from app.db.partition_maintenance_scheduler import (
    PartitionMaintenanceScheduler,
    register_partition_maintenance_scheduler,
)
from app.platform_admin.alert_monitor import PlatformAlertMonitor, register_alert_monitor
from app.retention.scheduler import OperationalRetentionScheduler, register_operational_retention_scheduler
from app.runtime.runtime_analytics_bucket_scheduler import (
    RuntimeAnalyticsBucketScheduler,
    register_runtime_analytics_bucket_scheduler,
)
from app.runtime.runtime_snapshot_scheduler import RuntimeSnapshotScheduler, register_runtime_snapshot_scheduler
from app.scheduler.enabled_streams import load_enabled_stream_contexts
from app.scheduler.runtime_state import register_scheduler_instance
from app.scheduler.scheduler import Scheduler
from app.startup_readiness import evaluate_startup_readiness, log_startup_readiness_summary
from app.validation.periodic_scheduler import ContinuousValidationScheduler, set_validation_scheduler

logger = logging.getLogger(__name__)


def run_standalone_scheduler() -> None:
    """Start stream scheduler and background updaters; block until SIGTERM/SIGINT."""

    ensure_production_security_settings(settings)
    startup_snapshot = evaluate_startup_readiness()
    if not startup_snapshot.scheduler_active:
        logger.error("%s", {"stage": "standalone_scheduler_not_ready", "reason": "schema_or_db_unavailable"})
        raise SystemExit(1)

    from app.governance_notifications.email_sender import SmtpEmailSender, set_email_sender

    set_email_sender(SmtpEmailSender())

    stop = threading.Event()

    def _handle_stop(*_: object) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

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

    scheduler.start()
    validation_scheduler.start()
    operational_retention_scheduler.start()
    partition_maintenance_scheduler.start()
    runtime_snapshot_scheduler.start()
    runtime_analytics_bucket_scheduler.start()
    alert_monitor.start()
    log_startup_readiness_summary(startup_snapshot, scheduler_started=True)
    logger.info("%s", {"stage": "standalone_scheduler_started"})

    try:
        while not stop.is_set():
            stop.wait(5.0)
    finally:
        alert_monitor.stop()
        runtime_analytics_bucket_scheduler.stop()
        runtime_snapshot_scheduler.stop()
        partition_maintenance_scheduler.stop()
        operational_retention_scheduler.stop()
        validation_scheduler.stop()
        scheduler.stop()
        logger.info("%s", {"stage": "standalone_scheduler_stopped"})


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_standalone_scheduler()
