"""Application configuration via environment variables."""

from typing import Any

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings loaded from environment / .env."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "Generic Data Connector Platform API"
    APP_ENV: str = "development"
    API_PREFIX: str = "/api/v1"
    DATABASE_URL: str = "postgresql://gdc:gdc@postgres:5432/gdc"

    # SQLAlchemy pool (moderate defaults; tune per host RAM / expected concurrency).
    GDC_DB_POOL_SIZE: int = 5
    GDC_DB_MAX_OVERFLOW: int = 8
    GDC_DB_POOL_TIMEOUT: int = 30
    GDC_DB_POOL_RECYCLE_SEC: int = 3600
    # Isolated pool for lightweight catalog reads (GET /connectors/) — avoids analytics pool starvation.
    GDC_CATALOG_DB_POOL_SIZE: int = 2
    GDC_CATALOG_DB_MAX_OVERFLOW: int = 2
    GDC_CATALOG_DB_POOL_TIMEOUT: int = 5
    # Process-local TTL for connectors catalog list; stale last-success payload kept on refresh failure.
    GDC_CONNECTORS_LIST_CACHE_TTL_SEC: float = 30.0
    # Log individual statement timings over thresholds (see app/observability/slow_query.py).
    GDC_SLOW_QUERY_LOG: bool = True
    SECRET_KEY: str = "change-me-in-production"
    JWT_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    JWT_ISSUER: str = "gdc-platform"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_MINUTES: int = 60 * 24
    REQUIRE_AUTH: bool = False
    AUTH_DEV_HEADER_TRUST: bool = False
    ENCRYPTION_KEY: str = "replace-with-fernet-or-aes-key-placeholder"
    DEFAULT_COLLECTOR_NAME: str = "generic-connector-01"

    # Optional WEBHOOK_POST echo for continuous validation (`/api/v1/validation/echo?key=...`).
    VALIDATION_ECHO_QUERY_KEY: str | None = None
    VALIDATION_ECHO_HEADER_VALUE: str | None = None
    # Background supervisor interval for continuous validation scheduler (seconds).
    VALIDATION_SUPERVISOR_INTERVAL_SEC: float = 20.0

    # Optional absolute UI base for validation deep links in outbound notifications (no trailing slash).
    PLATFORM_PUBLIC_UI_BASE_URL: str = ""
    # Comma-separated outbound notification targets (fail-open; never blocks StreamRunner).
    VALIDATION_ALERT_NOTIFY_GENERIC_URLS: str = ""
    VALIDATION_ALERT_NOTIFY_SLACK_URLS: str = ""
    VALIDATION_ALERT_NOTIFY_PAGERDUTY_ROUTING_KEYS: str = ""

    # Development validation lab (additive WireMock-backed entities; never enable in production).
    ENABLE_DEV_VALIDATION_LAB: bool = False
    DEV_VALIDATION_AUTO_START: bool = False
    DEV_VALIDATION_WIREMOCK_BASE_URL: str = "http://127.0.0.1:18080"
    DEV_VALIDATION_WEBHOOK_BASE_URL: str = "http://127.0.0.1:18091"
    DEV_VALIDATION_SYSLOG_HOST: str = "127.0.0.1"
    DEV_VALIDATION_SYSLOG_PORT: int = 15514

    # Optional MinIO S3 lab slice (requires credentials; never enable in production).
    ENABLE_DEV_VALIDATION_S3: bool = False
    MINIO_ENDPOINT: str = "http://127.0.0.1:9000"
    MINIO_ACCESS_KEY: str = ""
    MINIO_SECRET_KEY: str = ""
    MINIO_BUCKET: str = "gdc-test-logs"

    # Optional lab slices for DATABASE_QUERY / REMOTE_FILE_POLLING / perf snapshots (never enable in production).
    ENABLE_DEV_VALIDATION_DATABASE_QUERY: bool = False
    ENABLE_DEV_VALIDATION_REMOTE_FILE: bool = False
    ENABLE_DEV_VALIDATION_PERFORMANCE: bool = False

    # Isolated fixture DB / SSH endpoints (customer DB simulation — not the platform catalog).
    DEV_VALIDATION_PG_QUERY_HOST: str = "127.0.0.1"
    DEV_VALIDATION_PG_QUERY_PORT: int = 55433
    DEV_VALIDATION_MYSQL_QUERY_HOST: str = "127.0.0.1"
    DEV_VALIDATION_MYSQL_QUERY_PORT: int = 33306
    DEV_VALIDATION_MARIADB_QUERY_HOST: str = "127.0.0.1"
    DEV_VALIDATION_MARIADB_QUERY_PORT: int = 33307
    DEV_VALIDATION_SFTP_HOST: str = "127.0.0.1"
    DEV_VALIDATION_SFTP_PORT: int = 22222
    DEV_VALIDATION_SFTP_USER: str = "gdc"
    DEV_VALIDATION_SFTP_PASSWORD: str = ""
    DEV_VALIDATION_SSH_SCP_HOST: str = "127.0.0.1"
    DEV_VALIDATION_SSH_SCP_PORT: int = 22223
    DEV_VALIDATION_SSH_SCP_USER: str = "gdc2"
    DEV_VALIDATION_SSH_SCP_PASSWORD: str = ""
    ENABLE_LAB_THROUGHPUT_FEEDER: bool = True

    # Self-signed TLS material paths (relative paths resolve from process working directory).
    GDC_TLS_CERT_PATH: str = "data/tls/server.crt"
    GDC_TLS_KEY_PATH: str = "data/tls/server.key"

    # PEM paths as seen by the reverse proxy container (for generated nginx config).
    GDC_NGINX_TLS_CERT_CONTAINER_PATH: str = "/var/gdc/tls/server.crt"
    GDC_NGINX_TLS_KEY_CONTAINER_PATH: str = "/var/gdc/tls/server.key"

    # Operator-written nginx site config (bind-mount this path into the proxy conf.d directory).
    GDC_NGINX_CONF_PATH: str = "data/nginx/default.conf"
    # Upstream API hostname:port used inside generated nginx config (Docker DNS name is typical).
    GDC_UPSTREAM_API_HOST: str = "127.0.0.1"
    GDC_UPSTREAM_API_PORT: int = 8000
    # Static UI (Vite build) served by the optional ``frontend`` compose service.
    GDC_UPSTREAM_UI_HOST: str = "frontend"
    GDC_UPSTREAM_UI_PORT: int = 80

    # Optional: POST target to trigger ``nginx -t`` + ``nginx -s reload`` inside the proxy container.
    GDC_PROXY_RELOAD_URL: str = ""
    GDC_PROXY_RELOAD_TOKEN: str = ""

    # Published reverse-proxy browser ports used by docker-compose.platform.yml.
    GDC_HTTP_PORT: int = 18080
    GDC_HTTPS_PORT: int = 18443
    # Host project paths mounted into the API container for the controlled reverse-proxy apply action.
    GDC_PLATFORM_ENV_PATH: str = ""
    GDC_PLATFORM_COMPOSE_ROOT: str = ""

    # Published browser ports (for Admin Settings URL hints when behind port-mapped compose).
    GDC_PUBLIC_HTTP_PORT: int = 0
    GDC_PUBLIC_HTTPS_PORT: int = 0

    # Optional: HTTP GET health URL for the reverse proxy (e.g. http://reverse-proxy/health).
    GDC_PROXY_INTERNAL_HEALTH_URL: str = ""

    # Operational retention overrides (PostgreSQL batch cleanup). None = use built-in defaults.
    GDC_DELIVERY_LOG_RETENTION_DAYS: int | None = None
    GDC_CHECKPOINT_HISTORY_RETENTION_DAYS: int | None = None
    GDC_RETENTION_BACKFILL_JOBS_DAYS: int | None = None
    GDC_RETENTION_BACKFILL_PROGRESS_EVENTS_DAYS: int | None = None
    GDC_RETENTION_VALIDATION_SNAPSHOTS_DAYS: int | None = None
    # Monthly partition ensure (delivery_logs). Fail-open on errors.
    GDC_PARTITION_MAINTENANCE_ENABLED: bool = True
    GDC_PARTITION_MAINTENANCE_MONTHS_AHEAD: int = 2
    GDC_PARTITION_MAINTENANCE_TICK_SECONDS: float = 3600.0
    # Physical operational snapshot read model (Phase 4): incremental updater + API read path.
    GDC_RUNTIME_OPERATIONAL_SNAPSHOT_READ_MODEL_ENABLED: bool = True
    GDC_RUNTIME_OPERATIONAL_SNAPSHOT_UPDATER_ENABLED: bool = True
    GDC_RUNTIME_OPERATIONAL_SNAPSHOT_UPDATER_INTERVAL_SECONDS: float = 30.0
    GDC_RUNTIME_OPERATIONAL_SNAPSHOT_SCAN_MINUTES: int = 15
    # Historical analytics bucket read model (Phase 6): incremental updater + API read path.
    GDC_RUNTIME_ANALYTICS_BUCKET_READ_ENABLED: bool = True
    GDC_RUNTIME_ANALYTICS_BUCKET_UPDATER_ENABLED: bool = True
    GDC_RUNTIME_ANALYTICS_BUCKET_UPDATER_INTERVAL_SECONDS: float = 30.0
    GDC_RUNTIME_ANALYTICS_BUCKET_BATCH_LIMIT: int = 50_000
    GDC_RUNTIME_ANALYTICS_BUCKET_BOOTSTRAP_MINUTES: int = 60
    GDC_RUNTIME_ANALYTICS_BUCKET_1M_RETENTION_DAYS: int = 30
    GDC_RUNTIME_ANALYTICS_BUCKET_5M_RETENTION_DAYS: int = 90
    GDC_RUNTIME_ANALYTICS_BUCKET_RETENTION_CLEANUP_ENABLED: bool = True
    GDC_RUNTIME_ANALYTICS_BUCKET_RETENTION_BATCH_SIZE: int = 10_000
    # Runtime aggregate snapshot materialization TTL in seconds.
    GDC_RUNTIME_AGGREGATE_SNAPSHOT_TTL_SECONDS: int = 20
    # Expired snapshot cleanup is disabled by default; dry-run/count paths remain available.
    GDC_RUNTIME_AGGREGATE_SNAPSHOT_CLEANUP_ENABLED: bool = False
    # Retention deletes are opt-in. Dry-runs and previews do not require these flags.
    GDC_RETENTION_DESTRUCTIVE_ACTIONS_ENABLED: bool = False
    GDC_RETENTION_PRODUCTION_DELETES_ENABLED: bool = False
    GDC_RETENTION_AUTOMATIC_DELETES_ENABLED: bool = False
    GDC_RETENTION_DELIVERY_LOG_PARTITION_DROP_ENABLED: bool = False
    # Dedicated supplement scheduler tick (backfill + validation snapshots); default daily.
    GDC_OPERATIONAL_RETENTION_INTERVAL_SEC: float = 86400.0
    # Background thread for supplement bundle (no Celery). Disable in constrained tests.
    GDC_OPERATIONAL_RETENTION_SUPPLEMENT_ENABLED: bool = True

    # When False, API process skips in-process stream scheduler (use dedicated scheduler service).
    GDC_ENABLE_IN_PROCESS_SCHEDULER: bool = True
    # Uvicorn worker count for API process (1 = default single worker).
    GDC_UVICORN_WORKERS: int = 1
    # Prefer runtime snapshot tables for health overview (avoids delivery_logs GROUP BY).
    GDC_HEALTH_SNAPSHOT_READ_ENABLED: bool = True

    # Schema observation (Milestone 1): record field paths/types from extracted events.
    GDC_SCHEMA_OBSERVATION_ENABLED: bool = True
    GDC_SCHEMA_OBSERVATION_MAX_DEPTH: int = 64
    GDC_SCHEMA_OBSERVATION_MAX_PATHS: int = 5000
    GDC_SCHEMA_OBSERVATION_MAX_EVENTS_PER_RUN: int = 500
    # Schema drift (Milestone 2): field added/removed vs baseline; read-only, non-blocking.
    GDC_SCHEMA_DRIFT_DETECTION_ENABLED: bool = True
    GDC_SCHEMA_BASELINE_MIN_RUNS: int = 2
    GDC_SCHEMA_BASELINE_MIN_EVENTS: int = 1
    GDC_SCHEMA_DRIFT_ADDED_CONFIRM_RUNS: int = 2
    GDC_SCHEMA_DRIFT_REMOVED_ABSENT_RUNS: int = 3
    # Schema drift (Milestone 3a): primitive type change vs baseline; consecutive run gate.
    GDC_SCHEMA_DRIFT_TYPE_CHANGE_CONFIRM_RUNS: int = 3
    # Schema drift policy runtime (Wizard → Deploy → StreamRunner orchestrator).
    GDC_SCHEMA_DRIFT_POLICY_ENABLED: bool = True

    # Sensitive detection (M5): enriched-event field signals; detection-only, non-blocking.
    GDC_SENSITIVE_DETECTION_ENABLED: bool = True
    GDC_SENSITIVE_DETECTION_MAX_DEPTH: int = 64
    GDC_SENSITIVE_DETECTION_MAX_PATHS: int = 5000
    GDC_SENSITIVE_DETECTION_MAX_EVENTS_PER_RUN: int = 500
    GDC_SENSITIVE_DETECTION_CONFIRM_RUNS: int = 2

    # Protection engine (M6): outbound masking after sensitive detection, before fan-out.
    GDC_PROTECTION_ENABLED: bool = True
    GDC_PROTECTION_HASH_SALT: str = "change-me-protection-salt"

    # M13 rule-based classification (after sensitive detection, before protection).
    GDC_CLASSIFICATION_ENABLED: bool = True
    GDC_IDENTITY_VAULT_HASH_SALT: str = ""

    # Route Processing runtime — Transform → Protection → Classification → Policy → Delivery.
    # Default ON. Set false to use the legacy stream-scoped path (rollback / compatibility).
    GDC_ROUTE_PROCESSING_ENABLED: bool = True

    # Governance / operational notifications (M20.2) — platform-level SMTP.
    SMTP_ENABLED: bool = False
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""
    SMTP_STARTTLS: bool = True
    SMTP_SSL: bool = False
    SMTP_TIMEOUT: float = 10.0
    WEBHOOK_TIMEOUT: float = 10.0

    # When True, trust ``X-Forwarded-Proto`` / ``X-Forwarded-For`` from ``GDC_PROXY_FORWARD_TRUSTED_HOSTS``.
    # Enable behind the bundled nginx reverse proxy; keep False for direct local API exposure.
    GDC_TRUST_PROXY_HEADERS: bool = False
    GDC_PROXY_FORWARD_TRUSTED_HOSTS: str = "*"

    @model_validator(mode="after")
    def _apply_dev_validation_lab_defaults(self) -> "Settings":
        from app.dev_validation_lab.env_defaults import apply_dev_validation_lab_env_defaults

        meta = apply_dev_validation_lab_env_defaults(self)
        object.__setattr__(self, "_dev_validation_lab_defaults_meta", meta)
        return self

    @model_validator(mode="after")
    def _fail_closed_production_security(self) -> "Settings":
        from app.production_security import validate_production_security_settings

        validate_production_security_settings(self)
        return self

    @property
    def dev_validation_lab_defaults_meta(self) -> dict[str, Any]:
        return dict(getattr(self, "_dev_validation_lab_defaults_meta", None) or {})


settings = Settings()
