# M13 Migration Audit

**Status:** SUPERSEDED (historical migration snapshot)  
**Superseded By:** [`source-of-truth-index.md`](source-of-truth-index.md), Alembic history

**Date:** 2026-06-17  
**Scope:** Alembic revisions `20260614_0054` – `20260616_0057`

---

## 1. Summary

| Migration file | Revision ID | Milestone | Git tracked |
|----------------|-------------|-----------|-------------|
| `20260614_0054_route_transform_tables.py` | `20260614_0054_route_transform` | M13.2 Transform | **No** (`??`) |
| `20260615_0055_route_protection_rules.py` | `20260615_0055_route_protection` | M13.3 Protection | **No** (`??`) |
| `20260616_0056_route_classification_rules.py` | `20260616_0056_route_class` | M13.4 Classification | **No** (`??`) |
| `20260616_0057_route_policy_rules.py` | `20260616_0057_route_policy` | M13.5 Policy | **No** (`??`) |

All four files exist on disk and form a **valid linear Alembic chain**. They are **untracked** in git — deployment state across environments is unknown until committed and applied.

---

## 2. Revision Chain

```text
20260609_0053_product_group
  └─ 20260614_0054_route_transform      (M13.2 — route_mappings, route_enrichments)
       └─ 20260615_0055_route_protection (M13.3 — route_protection_rules)
            └─ 20260616_0056_route_class  (M13.4 — route_classification_rules)
                 └─ 20260616_0057_route_policy (M13.5 — route_policy_rules + quarantine.route_id) [HEAD]
```

Verified via:

```bash
python3 -m alembic heads
# 20260616_0057_route_policy (head)

python3 -m alembic history -r 20260609_0053_product_group:20260616_0057_route_policy
# Linear chain — no branches
```

---

## 3. Per-Migration Detail

### 20260614_0054 — route_transform_tables

| Item | Detail |
|------|--------|
| Tables | `route_mappings`, `route_enrichments` |
| UNIQUE | `route_id` on both |
| FK | `route_id → routes.id` **without ON DELETE** |
| Upgrade | Creates both tables + indexes |
| Downgrade | Drops indexes + tables (enrichments first, then mappings) |

**Note:** Missing CASCADE on FK is known debt (TD-M1); not a blocker for this audit.

### 20260615_0055 — route_protection_rules

| Item | Detail |
|------|--------|
| Table | `route_protection_rules` |
| UNIQUE | `(route_id, field_path)` |
| FK | `route_id → routes.id ON DELETE CASCADE`; `source_finding_id → stream_sensitive_findings.id ON DELETE SET NULL` |
| Upgrade | Creates table + indexes |
| Downgrade | Drops indexes + table |

### 20260616_0056 — route_classification_rules

| Item | Detail |
|------|--------|
| Table | `route_classification_rules` |
| Index | `(route_id, enabled)` |
| FK | `route_id → routes.id ON DELETE CASCADE` |
| Upgrade | Creates table + indexes |
| Downgrade | Drops indexes + table |

### 20260616_0057 — route_policy_rules

| Item | Detail |
|------|--------|
| Table | `route_policy_rules` |
| Column add | `stream_quarantine_events.route_id` (nullable) |
| FK | `route_id → routes.id ON DELETE CASCADE` (policy rules); quarantine `route_id → routes.id ON DELETE SET NULL` |
| Upgrade | Creates policy table; adds nullable `route_id` to quarantine |
| Downgrade | Drops quarantine column/FK/index first; then policy table |

Downgrade order is correct (dependent column removed before parent table drops).

---

## 4. Upgrade / Downgrade Path Validation

| Check | Result |
|-------|--------|
| Single head | ✅ `20260616_0057_route_policy` |
| No branch labels | ✅ |
| `down_revision` links consistent | ✅ |
| Each file has `upgrade()` + `downgrade()` | ✅ |
| Downgrade reverses upgrade objects | ✅ (manual review) |
| Alembic script parses | ✅ `alembic heads` succeeds |
| Applied in test DB during M13 pytest | ✅ (conftest runs `alembic upgrade head`; 75 tests passed) |

### Upgrade path

```bash
alembic upgrade 20260614_0054_route_transform   # M13.2 only
alembic upgrade 20260615_0055_route_protection  # through M13.3
alembic upgrade 20260616_0056_route_class       # through M13.4
alembic upgrade 20260616_0057_route_policy      # through M13.5 (head)
# or: alembic upgrade head
```

### Downgrade path

```bash
alembic downgrade 20260616_0056_route_class   # drops policy + quarantine.route_id
alembic downgrade 20260615_0055_route_protection
alembic downgrade 20260614_0054_route_transform
alembic downgrade 20260609_0053_product_group  # pre-M13 schema
```

---

## 5. Findings

| Finding | Severity | Blocker? |
|---------|----------|----------|
| Migrations untracked in git | HIGH (TD-H3) | **Yes for deploy** — must commit before production |
| `route_mappings` / `route_enrichments` FK without CASCADE | MEDIUM (TD-M1) | No — runtime blocker fix scope |
| Chain integrity | OK | — |
| Additive-only (no stream table drops) | OK | Aligns with constitution |

---

## 6. Recommendation

1. **Commit** all four migration files to version control.
2. Run `alembic upgrade head` on staging/production with standard backup.
3. Optionally add follow-up migration for `ON DELETE CASCADE` on transform tables (TD-M1, post-blocker).

---

*Audit performed 2026-06-17. Schema validation inferred from migration source + successful M13 test suite (pytest applies head).*
