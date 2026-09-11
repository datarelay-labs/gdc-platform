# Production Checklist — Data Relay OSS v1.0.2 GA

Use this checklist before exposing Data Relay to production traffic.

---

## Security & transport

- [ ] **HTTPS enabled** — terminate TLS at reverse proxy or platform nginx (`docs/deployment/https-reverse-proxy.md`)
- [ ] **Reverse proxy** configured with trusted headers (`GDC_TRUST_PROXY_HEADERS=true`)
- [ ] Default **admin password changed** on first login
- [ ] **JWT_SECRET_KEY** (JWT signing secret) set to a strong random value (≥ 32 bytes)
- [ ] **SECRET_KEY** and **ENCRYPTION_KEY** set to unique production values
- [ ] **POSTGRES_PASSWORD** changed from default `gdc`
- [ ] **GDC_PROXY_RELOAD_TOKEN** set if using dynamic nginx reload

---

## Database

- [ ] **PostgreSQL recommended** — bundled compose Postgres is suitable for evaluation; use managed PostgreSQL for production
- [ ] **Backup schedule** defined (`scripts/release/backup.sh`, `docs/deployment/backup-restore.md`)
- [ ] **Restore tested** on a non-production instance
- [ ] Host pytest catalog **`gdc_pytest`** never used as production `DATABASE_URL`

---

## Email & notifications

- [ ] **SMTP_ENABLED** / **SMTP_HOST** set when email notifications are required (`false` or empty host skips send; does not affect Stream runtime)
- [ ] **SMTP_FROM** and recipients verified under **Governance → Notifications** (and Administration alert `email_to` if used)
- [ ] Email send verified in non-production first; Slack notifications remain planned

---

## Webhook delivery

- [ ] **WEBHOOK_TIMEOUT** tuned for your network (default `10` seconds)
- [ ] Destination webhook URLs use HTTPS where possible
- [ ] Receiver endpoints accept platform payload format
- [ ] Credential rotation schedule for webhook auth headers / API keys

---

## Credential rotation

- [ ] Platform admin passwords rotated on schedule
- [ ] Connector source credentials stored encrypted; rotate per vendor policy
- [ ] Destination authentication tokens reviewed quarterly
- [ ] JWT secret rotation procedure documented (requires re-login for all sessions)

---

## Runtime & operations

- [ ] **ENABLE_DEV_VALIDATION_LAB=false** in production `.env`
- [ ] **APP_ENV=production**
- [ ] Log retention and partition maintenance reviewed (`GDC_DELIVERY_LOG_RETENTION_DAYS`)
- [ ] Monitoring access restricted via RBAC
- [ ] Support bundle procedure documented (`docs/admin/support-bundle.md`)

---

## OSS release surface

- [ ] Frontend built with **VITE_OSS_RELEASE_MODE=true** (default in `docker-compose.platform.yml`)
- [ ] Internal validation lab and connector catalog URLs not linked from operator docs

---

## Sign-off

| Role | Name | Date |
|------|------|------|
| Platform operator | | |
| Security review | | |
