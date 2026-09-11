# M13 Circular Import — Root Cause Analysis

**Status:** SUPERSEDED (historical incident record; fix already applied)  
**Superseded By:** [`source-of-truth-index.md`](source-of-truth-index.md)

**Date:** 2026-06-17  
**Blocker ID:** TD-H1 (from `m13-route-architecture-completion-audit.md`)  
**Status:** Fixed

---

## 1. Import Graph

```text
app.runners.stream_runner
  └─ app.runners.route_context                    [module load starts]
       └─ app.route_policy.config                 [package __init__ runs first]
            └─ app.route_policy.__init__
                 └─ app.route_policy.stage         [eager re-export]
                      └─ app.runners.route_context  [CYCLE — partially initialized]
                           ✗ ImportError: cannot import name 'RouteRuntimeContext'
```

### Detailed chain

| Step | Module | Import statement |
|------|--------|------------------|
| 1 | `app/runners/stream_runner.py` | `from app.runners.route_context import RoutePipelineResult, RouteRuntimeContext` |
| 2 | `app/runners/route_context.py` | `from app.route_policy.config import RoutePolicyConfig, RoutePolicyResult` |
| 3 | `app/route_policy/__init__.py` | `from app.route_policy.stage import route_policy_stage` |
| 4 | `app/route_policy/stage.py` | `from app.runners.route_context import RouteRuntimeContext, SharedBatchContext` |
| 5 | **Cycle** | `route_context` still loading (line 10 not finished) → `ImportError` |

### Reproduction (before fix)

```bash
python3 -c "from app.runners.stream_runner import StreamRunner"
```

```text
ImportError: cannot import name 'RouteRuntimeContext' from partially initialized module
'app.runners.route_context' (most likely due to a circular import)
```

### Verification (after fix)

```bash
python3 -c "from app.runners.stream_runner import StreamRunner; print('StreamRunner OK')"
# StreamRunner OK
```

---

## 2. Root Cause

`app/route_policy/__init__.py` eagerly imported `route_policy_stage` from `app.route_policy.stage` as a package-level re-export.

Importing **any** submodule under `app.route_policy` (including `app.route_policy.config`, which `route_context.py` needs for type definitions) executes `__init__.py` first. That pulls in `stage.py`, which depends on `RouteRuntimeContext` from `route_context.py` while that module is still initializing.

The cycle is **not** inherent to M13 architecture — it is an **init-module re-export anti-pattern**. `route_classification/__init__.py` already follows the correct pattern (config + resolver only; no stage import).

---

## 3. Files Involved

| File | Role |
|------|------|
| `app/runners/stream_runner.py` | Entry point that triggers `route_context` load |
| `app/runners/route_context.py` | Dataclass contracts; imports `RoutePolicyConfig` from `route_policy.config` |
| `app/route_policy/__init__.py` | **Trigger** — eager `stage` import |
| `app/route_policy/stage.py` | Route policy stage; legitimately needs `RouteRuntimeContext` |
| `app/route_policy/config.py` | Typed config (safe leaf module) |
| `app/runners/route_stage.py` | Correct consumer: `from app.route_policy.stage import route_policy_stage` |

No other file imported `route_policy_stage` from the package namespace (`from app.route_policy import route_policy_stage`).

---

## 4. Minimal Fix Strategy

**Remove `route_policy_stage` from `app/route_policy/__init__.py`.**

Keep package `__init__` limited to config and resolver exports (mirror `route_classification/__init__.py`). Callers that need the stage already import directly:

```python
from app.route_policy.stage import route_policy_stage
```

### Change applied

```diff
- from app.route_policy.stage import route_policy_stage
  __all__ = [
      "RoutePolicyConfig",
      "RoutePolicyResult",
      "resolve_route_policy_config",
-     "route_policy_stage",
  ]
```

No lazy-import machinery required. No changes to `route_context.py`, `stage.py`, or runtime orchestration.

---

## 5. Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| Break callers of `from app.route_policy import route_policy_stage` | **None** | Grep confirmed zero such imports |
| Break `__all__` public API consumers | **Low** | Only config/resolver remain exported; matches sibling packages |
| Hide stage from discoverability | **Low** | Document in module docstring; `route_stage.py` imports stage directly |
| Regression in flag ON/OFF paths | **Low** | 75 M13 tests pass post-fix |
| Reintroduction via future re-export | **Medium** | Follow `route_classification` pattern in code review |

**Overall risk:** Minimal — single-line deletion in `__init__.py`, no behavioral change.

---

*Fix applied 2026-06-17. See `m13-flag-off-parity-report.md` and `m13-flag-on-runtime-validation.md` for runtime verification.*
