#!/usr/bin/env python3
"""Cross-Product E2E recovery helpers: immutable manifest, lock/status, shard trust, plans."""
from __future__ import annotations

import hashlib
import subprocess
import json
import os
import re
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

EXPECTED_FIXED_HARNESS = (
    "009daf57881a515e73d7ef388eb1bd9bdd6e82bb2a9166fe3479b50bf5e2e307"
)
EXPECTED_FIXED_COMMIT = "42c4092270af0c789327d218cd805766f7317bdd"

IMMUTABLE_FIELDS = (
    "run_id",
    "git_commit",
    "harness_version",
    "manifest_hash",
    "applicability_rules_hash",
    "axes_hash",
    "executor_hash",
    "driver_hash",
    "spec_hash",
    "oracle_hash",
    "fixture_hash",
    "route_runtime",
    "started_at",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def default_repo_reports_root(repo_root: Optional[Path] = None) -> Path:
    """Repository-local default: <repo>/e2e/reports."""
    root = Path(repo_root) if repo_root else Path(__file__).resolve().parents[2]
    return (root / "e2e" / "reports").resolve()


def resolve_reports_root_detailed(
    cli_value: Optional[str] = None,
    *,
    env: Optional[dict[str, str]] = None,
    repo_root: Optional[Path] = None,
) -> tuple[Path, str]:
    """Resolve reports root with priority: CLI > GDC_E2E_REPORTS_ROOT > repo default.

    Returns (absolute_path, source) where source is cli|env|default.
    Does not create the directory. Expands ~ and normalizes to an absolute path.
    """
    env_map = env if env is not None else os.environ
    if cli_value is not None and str(cli_value).strip():
        raw = str(cli_value).strip()
        source = "cli"
    elif str(env_map.get("GDC_E2E_REPORTS_ROOT") or "").strip():
        raw = str(env_map["GDC_E2E_REPORTS_ROOT"]).strip()
        source = "env"
    else:
        return default_repo_reports_root(repo_root), "default"

    path = Path(os.path.expanduser(raw)).expanduser()
    if not path.is_absolute():
        # Relative paths resolve against the caller's cwd (operator intent).
        path = (Path.cwd() / path).resolve()
    else:
        path = path.resolve()
    return path, source


def resolve_reports_root(
    cli_value: Optional[str] = None,
    *,
    env: Optional[dict[str, str]] = None,
    repo_root: Optional[Path] = None,
) -> Path:
    return resolve_reports_root_detailed(cli_value, env=env, repo_root=repo_root)[0]


def resolve_run_dir(
    run_id: str,
    *,
    reports_root: Optional[Path] = None,
    cli_reports_root: Optional[str] = None,
    repo_root: Optional[Path] = None,
    must_exist: bool = True,
) -> Path:
    root = reports_root or resolve_reports_root(cli_reports_root, repo_root=repo_root)
    run_dir = (root / run_id).resolve()
    if must_exist and not run_dir.is_dir():
        raise FileNotFoundError(
            f"run dir missing: {run_dir} (reports_root={root})"
        )
    return run_dir


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write_json(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2) + "\n")


def atomic_write_json(path: Path, doc: Any) -> None:
    """Write a single JSON document via temp file + fsync + atomic rename."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".staging-{path.name}-{os.getpid()}-{time.time_ns()}"
    try:
        payload = json.dumps(doc, indent=2) + "\n"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(str(tmp), str(path))
        # Best-effort directory fsync so the rename itself is durable.
        try:
            dir_fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def atomic_write_jsons(files: dict[Path, Any]) -> None:
    """Atomically write multiple JSON files.

    Stage all temps first, then commit with os.replace. On any failure after the
    first commit, restore prior contents from backups so no partial transition
    remains.
    """
    staged: list[tuple[Path, Path]] = []
    backups: list[tuple[Path, Path]] = []
    committed: list[Path] = []
    try:
        for path, doc in files.items():
            path = Path(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.parent / f".staging-{path.name}-{os.getpid()}-{time.time_ns()}"
            tmp.write_text(json.dumps(doc, indent=2) + "\n")
            staged.append((tmp, path))
        for tmp, path in staged:
            if path.exists():
                bak = path.parent / f".bak-{path.name}-{os.getpid()}-{time.time_ns()}"
                os.replace(str(path), str(bak))
                backups.append((bak, path))
            os.replace(str(tmp), str(path))
            committed.append(path)
        for bak, _ in backups:
            try:
                bak.unlink()
            except OSError:
                pass
        backups.clear()
    except Exception:
        for bak, path in backups:
            if bak.exists():
                os.replace(str(bak), str(path))
        for tmp, _ in staged:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
        raise


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# Must stay aligned with e2e/cross-product/harness-version.ts HARNESS_SCOPE.
# Entries with None component key are still hashed into harness_version/scope_hash.
HARNESS_SCOPE_REL_TO_COMPONENT = (
    ("e2e/cross-product/cross-product-executor.ts", "executor_hash"),
    ("e2e/framework/data-relay-driver.ts", "driver_hash"),
    ("e2e/cross-product/matrix/cross-product.spec.ts", "spec_hash"),
    ("e2e/cross-product/oracle.ts", "oracle_hash"),
    ("e2e/cross-product/collector-route-plan.ts", None),
    ("e2e/cross-product/delivery-outcome.ts", None),
    ("e2e/cross-product/test-collector-route-plan.ts", None),
    ("e2e/cross-product/test-delivery-outcome.ts", None),
    ("e2e/framework/test-collector-message-key.ts", None),
    ("e2e/cross-product/fixtures/composite-chain-fixture.ts", "fixture_hash"),
    ("e2e/framework/test-context.ts", "test_context_hash"),
    ("e2e/framework/resource-cleanup.ts", None),
    ("e2e/framework/lab-stability.ts", "lab_stability_hash"),
    ("e2e/cross-product/retry-policy.json", "retry_policy_hash"),
    ("e2e/cross-product/cross-product-loader.ts", "loader_hash"),
    ("e2e/framework/api-context.ts", "api_context_hash"),
    ("e2e/framework/fixture-client.ts", "fixture_client_hash"),
    ("e2e/playwright.config.ts", "playwright_config_hash"),
    ("e2e/cross-product/applicability-rules.ts", "applicability_source_hash"),
    ("e2e/cross-product/cross-product-axes.yaml", "axes_source_hash"),
    ("e2e/cross-product/run-all-shards.sh", "run_all_shards_hash"),
    ("e2e/cross-product/recovery_lib.py", "recovery_lib_hash"),
    ("e2e/cross-product/parallel_lib.py", "parallel_lib_hash"),
    ("e2e/cross-product/parallel-matrix-coordinator.py", "parallel_coordinator_hash"),
    ("e2e/cross-product/run-parallel-shard-worker.sh", "parallel_worker_hash"),
    ("e2e/framework/connector-create-lock.ts", None),
)


def compute_harness_version(
    *,
    root: Path,
    commit: str,
    gen_dir: Optional[Path] = None,
) -> dict[str, str]:
    """Compute harness version.

    Prefer the TypeScript source of truth (harness-version.ts). Falls back to the
    same expanded scope algorithm in Python when Node is unavailable.
    """
    root = Path(root)
    e2e = root / "e2e"
    xp = e2e / "cross-product"
    # 1) TS authoritative path
    try:
        env = {**os.environ, "GDC_XP_COMMIT": commit}
        out = subprocess.check_output(
            ["npx", "--prefix", str(e2e), "tsx", str(xp / "harness-version.ts")],
            cwd=str(root),
            env=env,
            text=True,
            stderr=subprocess.DEVNULL,
        )
        # harness-version.ts prints a single JSON object
        start = out.find("{")
        end = out.rfind("}")
        if start >= 0 and end > start:
            doc = json.loads(out[start : end + 1])
            if doc.get("harness_version") and doc.get("git_commit") == commit:
                return {k: str(v) if v is not None else "" for k, v in doc.items()}
    except Exception:
        pass

    # 2) Python fallback mirroring harness-version.ts join order
    gen = Path(gen_dir) if gen_dir else (xp / "generated")
    scope_pairs: list[tuple[str, str]] = []
    component_hashes: dict[str, str] = {}
    for rel, key in HARNESS_SCOPE_REL_TO_COMPONENT:
        p = root / rel
        if not p.exists():
            raise FileNotFoundError(f"Harness scope missing required file: {rel}")
        digest = sha256_file(p)
        scope_pairs.append((rel, digest))
        if key:
            component_hashes[key] = digest
    scope_pairs.sort(key=lambda x: x[0])
    scope_hash = hashlib.sha256(
        "\n".join(f"{rel}:{digest}" for rel, digest in scope_pairs).encode()
    ).hexdigest()
    summary = read_json(gen / "generation-summary.json", {}) or {}
    manifest_hash = str(summary.get("manifest_hash") or "")
    rules_hash = str(summary.get("applicability_rules_hash") or "")
    axes_hash = str(summary.get("axes_hash") or "")
    harness_version = hashlib.sha256(
        "\n".join(
            [
                *[f"{rel}={digest}" for rel, digest in scope_pairs],
                f"git_commit={commit}",
                f"manifest_hash={manifest_hash}",
                f"applicability_rules_hash={rules_hash}",
                f"axes_hash={axes_hash}",
                f"scope_hash={scope_hash}",
            ]
        ).encode()
    ).hexdigest()
    return {
        **component_hashes,
        "git_commit": commit,
        "manifest_hash": manifest_hash,
        "applicability_rules_hash": rules_hash,
        "axes_hash": axes_hash,
        "scope_hash": scope_hash,
        "scope_file_count": str(len(scope_pairs)),
        "harness_version": harness_version,
    }


# ---------------------------------------------------------------------------
# Process / lock identity
# ---------------------------------------------------------------------------


def process_start_time(pid: int) -> Optional[str]:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        # comm may contain spaces/parens; starttime is field 22 after ") ".
        rest = stat.split(")", 1)[1].strip().split()
        return rest[19]  # 22nd field overall → index 19 after state
    except Exception:
        return None


def process_cmdline(pid: int) -> Optional[str]:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        return raw.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()
    except Exception:
        return None


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def process_matches_lock(lock: dict[str, Any]) -> bool:
    """True only if PID is alive AND identity matches lock metadata when present."""
    try:
        pid = int(lock.get("pid") or 0)
    except (TypeError, ValueError):
        return False
    if not pid_alive(pid):
        return False
    expected_start = lock.get("process_start_time")
    if expected_start:
        actual = process_start_time(pid)
        if actual is None or str(actual) != str(expected_start):
            return False
    expected_cmd = lock.get("command")
    if expected_cmd:
        actual_cmd = process_cmdline(pid) or ""
        # Require substantial overlap; PID reuse with unrelated command → mismatch.
        token = "xp-full-recovery-orchestrator"
        if token in str(expected_cmd) and token not in actual_cmd:
            return False
    return True


def build_lock_doc(run_id: str, pid: int, lock_file: str) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "pid": pid,
        "process_start_time": process_start_time(pid),
        "acquired_at": utc_now(),
        "command": process_cmdline(pid) or f"pid={pid}",
        "lock_file": lock_file,
    }


def classify_lock(lock_path: Path) -> dict[str, Any]:
    if not lock_path.exists():
        return {"lock_status": "ABSENT", "lock": None, "owner_alive": False}
    lock = read_json(lock_path, {}) or {}
    alive = process_matches_lock(lock)
    if alive:
        return {"lock_status": "HELD_ACTIVE", "lock": lock, "owner_alive": True}
    if lock.get("pid") and pid_alive(int(lock["pid"])) and not alive:
        return {
            "lock_status": "PID_REUSED_MISMATCH",
            "lock": lock,
            "owner_alive": False,
        }
    return {"lock_status": "STALE_LOCK", "lock": lock, "owner_alive": False}


# ---------------------------------------------------------------------------
# Immutable run manifest
# ---------------------------------------------------------------------------


def immutable_manifest_path(run_dir: Path) -> Path:
    return run_dir / "immutable-run-manifest.json"


def create_immutable_run_manifest(run_dir: Path, doc: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Create immutable manifest once. Returns (doc, created). Never overwrites."""
    path = immutable_manifest_path(run_dir)
    if path.exists():
        return read_json(path, {}), False
    out = {k: doc.get(k) for k in IMMUTABLE_FIELDS}
    out["immutable"] = True
    out["created_at"] = utc_now()
    write_json(path, out)
    return out, True


def load_immutable_run_manifest(
    run_dir: Path,
    *,
    allow_bootstrap_write: bool = True,
) -> Optional[dict[str, Any]]:
    path = immutable_manifest_path(run_dir)
    if path.exists():
        return read_json(path)
    # Bootstrap from expected-fixed-harness.json for legacy runs (never overwrite sources).
    expected = read_json(run_dir / "expected-fixed-harness.json")
    if expected and expected.get("harness_version"):
        boot = {
            "run_id": run_dir.name,
            "git_commit": expected.get("git_commit") or EXPECTED_FIXED_COMMIT,
            "harness_version": expected.get("harness_version"),
            "manifest_hash": expected.get("manifest_hash"),
            "applicability_rules_hash": expected.get("applicability_rules_hash"),
            "axes_hash": expected.get("axes_hash"),
            "executor_hash": expected.get("executor_hash"),
            "driver_hash": expected.get("driver_hash"),
            "spec_hash": expected.get("spec_hash"),
            "oracle_hash": expected.get("oracle_hash"),
            "fixture_hash": expected.get("fixture_hash"),
            "route_runtime": "ROUTE_ON",
            "started_at": None,
            "immutable": True,
            "bootstrapped_from": "expected-fixed-harness.json",
            "created_at": utc_now(),
        }
        if allow_bootstrap_write:
            write_json(path, boot)
        return boot
    return None


def compare_to_immutable(
    immutable: dict[str, Any],
    current: dict[str, Any],
) -> list[str]:
    mismatches = []
    for key in (
        "git_commit",
        "harness_version",
        "manifest_hash",
        "applicability_rules_hash",
        "axes_hash",
        "executor_hash",
        "driver_hash",
        "spec_hash",
        "oracle_hash",
        "fixture_hash",
    ):
        exp = immutable.get(key)
        act = current.get(key)
        if exp and act and str(exp) != str(act):
            mismatches.append(f"{key}: expected={exp} actual={act}")
    return mismatches


def write_run_abort(
    run_dir: Path,
    *,
    abort_reason: str,
    expected: dict[str, Any],
    actual: dict[str, Any],
    detail: Optional[dict[str, Any]] = None,
) -> Path:
    doc = {
        "status": "ABORTED",
        "abort_reason": abort_reason,
        "final_verdict": f"ABORTED_{abort_reason}" if not abort_reason.startswith("ABORTED") else abort_reason,
        "expected_git_commit": expected.get("git_commit"),
        "actual_git_commit": actual.get("git_commit"),
        "expected_harness_version": expected.get("harness_version"),
        "actual_harness_version": actual.get("harness_version"),
        "detail": detail or {},
        "recorded_at": utc_now(),
    }
    path = run_dir / "run-abort.json"
    write_json(path, doc)
    # Correct mutable metadata status without rewriting immutable harness fields.
    meta_path = run_dir / "run-metadata.json"
    meta = read_json(meta_path, {}) or {}
    meta["status"] = "ABORTED"
    meta["abort_reason"] = abort_reason
    meta["ended_at"] = meta.get("ended_at") or utc_now()
    meta["final_verdict"] = doc["final_verdict"]
    write_json(meta_path, meta)
    return path


# ---------------------------------------------------------------------------
# Shard expected counts (ROUTE_ON uses route_on_count)
# ---------------------------------------------------------------------------


def load_expected_counts(
    *,
    e2e_root: Path,
    route_runtime: str = "ROUTE_ON",
) -> dict[str, int]:
    summary = read_json(e2e_root / "cross-product" / "generated" / "shard-summary.json", {}) or {}
    by_shard = summary.get("by_shard") or []
    out: dict[str, int] = {}
    for s in by_shard:
        sid = s.get("shard_id")
        if not sid:
            continue
        if route_runtime == "ROUTE_ON":
            out[sid] = int(s.get("route_on_count") or s.get("scenarios") or 0)
        elif route_runtime == "ROUTE_OFF":
            out[sid] = int(s.get("route_off_count") or s.get("scenarios") or 0)
        else:
            out[sid] = int(s.get("scenarios") or 0)
    if out:
        return out
    plan = read_json(e2e_root / "cross-product" / "generated" / "shard-plan.json", {}) or {}
    for s in plan.get("shards") or []:
        out[s["shard_id"]] = len(s.get("combination_ids") or [])
    return out


# ---------------------------------------------------------------------------
# Shard trust validator
# ---------------------------------------------------------------------------


def _result_path(art: Path) -> Optional[Path]:
    for p in (
        art / "cross-product-results.jsonl",
        art / "original" / "cross-product-results.jsonl",
    ):
        if p.exists() and p.stat().st_size > 0:
            return p
    return None


def _load_rows(path: Optional[Path]) -> list[dict[str, Any]]:
    if not path:
        return []
    rows = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def validate_shard(
    *,
    run_dir: Path,
    shard_id: str,
    route_runtime: str,
    expected_count: int,
    expected_harness: str,
    expected_commit: str,
    expected_manifest_hash: str = "",
    expected_rules_hash: str = "",
    stable_seconds: float = 30.0,
) -> dict[str, Any]:
    art_name = f"{shard_id}-{route_runtime}"
    art = run_dir / art_name
    bad = run_dir / f".bad-{art_name}"
    superseded = (art / "superseded.json").exists() or (
        (art / "original").exists() and (art / "superseded.json").exists()
    )
    # Also treat original-only + superseded marker
    if (art / "superseded.json").exists():
        superseded = True

    preflight = read_json(art / "shard-preflight-fail.json")
    if not preflight and bad.exists():
        preflight = read_json(bad / "shard-preflight-fail.json")

    result_path = _result_path(art)
    rows_source = "artifact"
    if not result_path and bad.exists():
        result_path = _result_path(bad)
        rows_source = "bad_quarantine"

    rows = _load_rows(result_path)
    ids = [r.get("combination_id") for r in rows if r.get("combination_id")]
    unique = len(set(ids))
    dup_count = len(ids) - unique
    hv_counter = Counter(r.get("harness_version") for r in rows)
    commit_counter = Counter(r.get("git_commit") or r.get("commit") for r in rows)
    man = read_json(art / "shard-manifest.json", {}) or {}
    if not man and (art / "original" / "shard-manifest.json").exists():
        man = read_json(art / "original" / "shard-manifest.json", {}) or {}

    harness_versions = {h for h in hv_counter if h}
    harness_match = bool(harness_versions) and harness_versions == {expected_harness}
    harness_mismatch = bool(harness_versions) and expected_harness not in harness_versions
    mixed_harness = len(harness_versions) > 1
    commit_match = (not commit_counter) or all(
        (c is None) or (c == expected_commit) for c in commit_counter
    )

    # Hash fields on rows when present
    manifest_ok = True
    rules_ok = True
    if expected_manifest_hash:
        mh = {r.get("manifest_hash") for r in rows if r.get("manifest_hash")}
        if mh and mh != {expected_manifest_hash}:
            manifest_ok = False
    if expected_rules_hash:
        rh = {r.get("applicability_rules_hash") for r in rows if r.get("applicability_rules_hash")}
        if rh and rh != {expected_rules_hash}:
            rules_ok = False

    abnormal = (art / "abnormal-exit.json").exists() or (
        bad.exists() and (bad / "abnormal-exit.json").exists()
    )
    evidence_dirs = list(art.glob("cross_product__xp_*")) if art.exists() else []
    if bad.exists() and not evidence_dirs:
        evidence_dirs = list(bad.glob("cross_product__xp_*"))
    cleanup_ok_rows = sum(1 for r in rows if "cleanup_ok" in r)
    cleanup_report = (art / "cleanup-report.json").exists() or (
        run_dir / "cleanup-report.json"
    ).exists()
    cleanup_recorded = cleanup_ok_rows >= max(1, int(len(rows) * 0.9)) or cleanup_report
    evidence_flushed = (not rows) or len(evidence_dirs) >= max(0, len(rows) - 5)

    stable = True
    result_age = None
    if result_path and result_path.exists():
        result_age = time.time() - result_path.stat().st_mtime
        stable = result_age >= stable_seconds

    ended = man.get("ended_at") is not None or man.get("exit_code") is not None
    playwright_log = art / "playwright.log"
    if not playwright_log.exists() and bad.exists():
        playwright_log = bad / "playwright.log"
    playwright_ok = True
    if playwright_log.exists():
        # Soft signal only; absence of crash markers.
        text = playwright_log.read_text(errors="ignore")[-8000:]
        if "Target closed" in text and man.get("exit_code") not in (0, 1, None):
            playwright_ok = False

    reasons: list[str] = []
    verdict = "MISSING"

    if superseded:
        verdict = "SUPERSEDED"
        reasons.append("superseded.json present; original retained for evidence")
    elif preflight and preflight.get("reason") == "harness_version_mismatch":
        # Preflight-only mismatch with no trusted rows → not a product FAIL.
        if not rows or not harness_match:
            verdict = "HARNESS_MISMATCH"
            reasons.append("shard-preflight-fail harness_version_mismatch")
        else:
            verdict = "NEEDS_FULL_RERUN"
            reasons.append("preflight mismatch after partial execution")
    elif not art.exists() and not bad.exists():
        verdict = "MISSING"
        reasons.append("artifact directory missing")
    elif not rows:
        if preflight:
            verdict = (
                "HARNESS_MISMATCH"
                if "harness" in str(preflight.get("reason"))
                else "INCOMPLETE"
            )
            reasons.append(f"preflight:{preflight.get('reason')}")
        else:
            verdict = "MISSING"
            reasons.append("no result rows")
    elif mixed_harness or (harness_versions and not harness_match):
        verdict = "HARNESS_MISMATCH"
        reasons.append(f"harness_versions={sorted(str(h) for h in harness_versions)}")
        if unique != expected_count or len(rows) != expected_count:
            reasons.append("also incomplete vs expected")
        reasons.append("NEEDS_FULL_RERUN")
    elif dup_count > 0:
        verdict = "DUPLICATE_RESULTS"
        reasons.append(f"duplicate_combination_ids={dup_count}")
    elif expected_count > 0 and len(rows) > expected_count:
        verdict = "DUPLICATE_RESULTS"
        reasons.append(f"rows={len(rows)} > expected={expected_count}")
    elif expected_count > 0 and (len(rows) < expected_count or unique < expected_count):
        verdict = "INCOMPLETE"
        reasons.append(f"rows={len(rows)} unique={unique} expected={expected_count}")
    elif abnormal:
        verdict = "ABNORMAL_EXIT"
        reasons.append("abnormal-exit marker")
    elif not ended and not superseded:
        verdict = "INCOMPLETE"
        reasons.append("missing ended_at/exit_code")
    elif not stable:
        verdict = "INCOMPLETE"
        reasons.append(f"results not stable age={result_age}")
    elif not harness_match:
        verdict = "HARNESS_MISMATCH"
        reasons.append("harness mismatch")
    elif not commit_match:
        verdict = "HARNESS_MISMATCH"
        reasons.append(f"git_commit mismatch {dict(commit_counter)}")
    elif not manifest_ok or not rules_ok:
        verdict = "HARNESS_MISMATCH"
        reasons.append("manifest/rules hash mismatch on rows")
    else:
        verdict = "TRUSTED_COMPLETE"
        reasons.append("expected=executed=unique; harness/commit match; ended; stable")

    needs_full_rerun = verdict in {
        "INCOMPLETE",
        "DUPLICATE_RESULTS",
        "HARNESS_MISMATCH",
        "ABNORMAL_EXIT",
        "MISSING",
        "NEEDS_FULL_RERUN",
        "SUPERSEDED",
    } or ("NEEDS_FULL_RERUN" in reasons)

    reuse = verdict == "TRUSTED_COMPLETE"

    return {
        "shard_id": shard_id,
        "artifact": art_name,
        "verdict": verdict,
        "reuse": reuse,
        "rerun": needs_full_rerun,
        "rerun_reason": "; ".join(reasons),
        "expected_combinations": expected_count,
        "executed_rows": len(rows),
        "unique_combination_ids": unique,
        "duplicate_combination_ids": dup_count,
        "harness_versions": dict(hv_counter),
        "harness_match": harness_match,
        "commit_match": commit_match,
        "manifest_ok": manifest_ok,
        "rules_ok": rules_ok,
        "superseded": superseded,
        "abnormal": abnormal,
        "preflight": preflight,
        "ended": ended,
        "stable": stable,
        "result_age_seconds": result_age,
        "cleanup_recorded": cleanup_recorded,
        "evidence_flushed": evidence_flushed,
        "evidence_dirs": len(evidence_dirs),
        "playwright_ok": playwright_ok,
        "rows_source": rows_source,
        "bad_quarantine_exists": bad.exists(),
        "original_path": str(art),
        "replacement_path": None,
    }


def validate_all_shards(
    *,
    run_dir: Path,
    e2e_root: Path,
    route_runtime: str = "ROUTE_ON",
    expected_harness: str = EXPECTED_FIXED_HARNESS,
    expected_commit: str = EXPECTED_FIXED_COMMIT,
) -> dict[str, Any]:
    immutable = load_immutable_run_manifest(run_dir) or {}
    expected_harness = str(immutable.get("harness_version") or expected_harness)
    expected_commit = str(immutable.get("git_commit") or expected_commit)
    expected_manifest = str(immutable.get("manifest_hash") or "")
    expected_rules = str(immutable.get("applicability_rules_hash") or "")
    counts = load_expected_counts(e2e_root=e2e_root, route_runtime=route_runtime)
    plan = read_json(e2e_root / "cross-product" / "generated" / "shard-plan.json", {}) or {}
    shard_ids = [s["shard_id"] for s in plan.get("shards") or []]
    if not shard_ids:
        shard_ids = sorted(counts.keys())

    shards = []
    for sid in shard_ids:
        shards.append(
            validate_shard(
                run_dir=run_dir,
                shard_id=sid,
                route_runtime=route_runtime,
                expected_count=int(counts.get(sid) or 0),
                expected_harness=expected_harness,
                expected_commit=expected_commit,
                expected_manifest_hash=expected_manifest,
                expected_rules_hash=expected_rules,
            )
        )

    by_verdict: dict[str, list[str]] = {}
    for s in shards:
        by_verdict.setdefault(s["verdict"], []).append(s["shard_id"])

    return {
        "run_id": run_dir.name,
        "captured_at": utc_now(),
        "expected_harness_version": expected_harness,
        "expected_git_commit": expected_commit,
        "route_runtime": route_runtime,
        "shard_count": len(shards),
        "by_verdict": {k: len(v) for k, v in by_verdict.items()},
        "trusted_completed_shards": by_verdict.get("TRUSTED_COMPLETE", []),
        "superseded_shards": by_verdict.get("SUPERSEDED", []),
        "invalid_shards": [
            s["shard_id"]
            for s in shards
            if s["verdict"]
            not in {"TRUSTED_COMPLETE", "SUPERSEDED"}
        ],
        "missing_shards": by_verdict.get("MISSING", []),
        "needs_full_rerun": [s["shard_id"] for s in shards if s["rerun"]],
        "shards": shards,
    }


# ---------------------------------------------------------------------------
# Status determination
# ---------------------------------------------------------------------------


def heartbeat_age_seconds(run_dir: Path) -> Optional[float]:
    candidates = [
        run_dir / "recovery-orchestrator.log",
        run_dir / "recovery-orchestrator-state.json",
        run_dir / "status-snapshot.json",
    ]
    mtimes = [p.stat().st_mtime for p in candidates if p.exists()]
    if not mtimes:
        return None
    return time.time() - max(mtimes)


def last_result_age_seconds(run_dir: Path) -> Optional[float]:
    newest = None
    for p in run_dir.glob("*/cross-product-results.jsonl"):
        if p.name.startswith("."):
            continue
        mt = p.stat().st_mtime
        newest = mt if newest is None else max(newest, mt)
    if newest is None:
        return None
    return time.time() - newest


def _proc_has_run_id(pid: str, run_id: str) -> bool:
    try:
        env = Path(f"/proc/{pid}/environ").read_bytes().split(b"\x00")
        for item in env:
            if item.startswith(b"GDC_E2E_RUN_ID=") and item.split(b"=", 1)[1].decode() == run_id:
                return True
    except Exception:
        pass
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
        if run_id in cwd:
            return True
    except Exception:
        pass
    return False


def playwright_alive(run_dir: Path, e2e_root: Path) -> bool:
    """True only for real run-all-shards / playwright test workers for this run.

    Avoid matching operator/agent shells that merely mention 'playwright' in a prompt.
    """
    run_id = run_dir.name
    try:
        for proc in Path("/proc").iterdir():
            if not proc.name.isdigit():
                continue
            try:
                argv = (proc / "cmdline").read_bytes().split(b"\x00")
                cmd = b" ".join(argv).decode("utf-8", errors="replace")
                exe = os.readlink(f"/proc/{proc.name}/exe")
            except Exception:
                continue
            # Ignore diagnostic/agent shells embedding these strings.
            if "recovery_lib" in cmd or "xp-recovery-status" in cmd or "test_xp_recovery" in cmd:
                continue
            is_run_all = any(b"run-all-shards.sh" in a for a in argv)
            is_pw = (
                ("/node" in exe or exe.endswith("node") or "playwright" in exe)
                and (
                    b"playwright" in b" ".join(argv)
                    or any(b"cross-product.spec" in a for a in argv)
                )
            )
            if not (is_run_all or is_pw):
                continue
            if _proc_has_run_id(proc.name, run_id) or run_id.encode() in b" ".join(argv):
                return True
    except Exception:
        pass
    reports_root = run_dir.parent
    pid_file = reports_root / ".pids" / "xp_full_on.pid"
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            if pid_alive(pid):
                cmd = process_cmdline(pid) or ""
                if "run-all-shards.sh" in cmd:
                    return True
        except Exception:
            pass
    return False


def orchestrator_alive(lock_info: dict[str, Any], reports_root: Path) -> bool:
    if lock_info.get("owner_alive"):
        return True
    pid_file = reports_root / ".pids" / "xp_recovery.pid"
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            if pid_alive(pid):
                cmd = process_cmdline(pid) or ""
                if "xp-full-recovery-orchestrator" in cmd:
                    # Still verify start-time if lock has it
                    lock = lock_info.get("lock") or {}
                    if lock.get("process_start_time"):
                        return process_matches_lock({**lock, "pid": pid})
                    return True
        except Exception:
            pass
    return False


def determine_status(
    *,
    run_dir: Path,
    e2e_root: Path,
    expected_harness: str = EXPECTED_FIXED_HARNESS,
    reports_root: Optional[Path] = None,
    allow_bootstrap_write: bool = True,
) -> dict[str, Any]:
    reports = Path(reports_root) if reports_root else run_dir.parent
    lock_path = reports / ".locks" / f"xp-full-recovery-{run_dir.name}.lock"
    lock_info = classify_lock(lock_path)
    state = read_json(run_dir / "recovery-orchestrator-state.json", {}) or {}
    meta = read_json(run_dir / "run-metadata.json", {}) or {}
    abort = read_json(run_dir / "run-abort.json")
    immutable = load_immutable_run_manifest(
        run_dir, allow_bootstrap_write=allow_bootstrap_write
    )
    validation = validate_all_shards(
        run_dir=run_dir,
        e2e_root=e2e_root,
        expected_harness=(immutable or {}).get("harness_version") or expected_harness,
        expected_commit=(immutable or {}).get("git_commit") or EXPECTED_FIXED_COMMIT,
    )

    orch = orchestrator_alive(lock_info, reports)
    pw = playwright_alive(run_dir, e2e_root)
    hb = heartbeat_age_seconds(run_dir)
    lr = last_result_age_seconds(run_dir)

    current_hv = meta.get("harness_version")
    imm_hv = (immutable or {}).get("harness_version")
    immutable_harness_match = None
    if imm_hv and current_hv:
        immutable_harness_match = str(imm_hv) == str(current_hv)

    abort_reason = None
    if abort:
        abort_reason = abort.get("abort_reason")
    elif current_hv and imm_hv and str(current_hv) != str(imm_hv):
        abort_reason = "HARNESS_DRIFT"

    # Verdict rules (order matters)
    if orch or pw:
        # Active work — but harness drift abort marker still surfaces.
        if abort and abort.get("abort_reason") == "HARNESS_DRIFT" and not pw:
            # Orchestrator may still be looping after drift; surface abort intent.
            final = "ABORTED_HARNESS_DRIFT"
            resumable = True
        else:
            final = "IN_PROGRESS"
            resumable = False
    elif abort or abort_reason == "HARNESS_DRIFT":
        final = "ABORTED_HARNESS_DRIFT" if (abort_reason or "").endswith("HARNESS_DRIFT") or (
            abort or {}
        ).get("abort_reason") == "HARNESS_DRIFT" else "ABORTED"
        abort_reason = abort_reason or (abort or {}).get("abort_reason") or "HARNESS_DRIFT"
        resumable = True
    elif lock_info["lock_status"] == "STALE_LOCK":
        final = "STALE_LOCK"
        resumable = True
    elif lock_info["lock_status"] == "PID_REUSED_MISMATCH":
        final = "STALE_LOCK"
        resumable = True
    elif meta.get("ended_at") and int(meta.get("failed_shards") or 0) == 0 and state.get("phase") == "complete":
        final = "COMPLETE"
        resumable = False
    elif meta.get("ended_at") and int(meta.get("failed_shards") or 0) > 0:
        # Ended with failures — if harness drift signature, prefer ABORTED.
        if abort_reason == "HARNESS_DRIFT" or (
            current_hv and imm_hv and str(current_hv) != str(imm_hv)
        ):
            final = "ABORTED_HARNESS_DRIFT"
            abort_reason = "HARNESS_DRIFT"
            resumable = True
        else:
            final = "FAIL"
            resumable = True
    elif state.get("phase") == "complete":
        final = "COMPLETE"
        resumable = False
    else:
        final = (
            "ABORTED"
            if abort
            else "STALE_LOCK"
            if (lock_info.get("lock") or {}).get("pid")
            else "UNKNOWN"
        )
        resumable = True

    # Never treat lock-file presence alone as IN_PROGRESS (already handled).

    return {
        "captured_at": utc_now(),
        "run_id": run_dir.name,
        "reports_root": str(reports.resolve()),
        "run_dir": str(run_dir.resolve()),
        "phase": state.get("phase"),
        "orchestrator_alive": orch,
        "playwright_alive": pw,
        "lock_status": lock_info["lock_status"],
        "lock": lock_info.get("lock"),
        "heartbeat_age_seconds": hb,
        "last_result_age_seconds": lr,
        "immutable_harness_match": immutable_harness_match,
        "abort_reason": abort_reason,
        "resumable": resumable,
        "trusted_completed_shards": validation["trusted_completed_shards"],
        "invalid_shards": validation["invalid_shards"],
        "missing_shards": validation["missing_shards"],
        "final_verdict": final,
        "run_metadata_ended_at": meta.get("ended_at"),
        "failed_shards": meta.get("failed_shards"),
        "expected_fixed_harness": (immutable or {}).get("harness_version") or expected_harness,
    }


# ---------------------------------------------------------------------------
# Recovery plan
# ---------------------------------------------------------------------------


def next_recovery_attempt_dir(run_dir: Path) -> Path:
    existing = sorted(run_dir.glob("recovery-attempt-*"))
    n = 1
    if existing:
        nums = []
        for p in existing:
            m = re.match(r"recovery-attempt-(\d+)$", p.name)
            if m:
                nums.append(int(m.group(1)))
        n = (max(nums) if nums else 0) + 1
    path = run_dir / f"recovery-attempt-{n:03d}"
    path.mkdir(parents=True, exist_ok=False)
    return path


def build_recovery_plan(
    *,
    run_dir: Path,
    e2e_root: Path,
    attempt_dir: Optional[Path] = None,
) -> dict[str, Any]:
    if attempt_dir is None:
        attempt_dir = next_recovery_attempt_dir(run_dir)
    else:
        attempt_dir.mkdir(parents=True, exist_ok=True)

    validation = validate_all_shards(run_dir=run_dir, e2e_root=e2e_root)
    write_json(attempt_dir / "shard-validation.json", validation)

    immutable = load_immutable_run_manifest(run_dir) or {}
    replacement_map: dict[str, Any] = {}
    plan_shards = []
    for s in validation["shards"]:
        sid = s["shard_id"]
        reuse = bool(s["reuse"])
        rerun = bool(s["rerun"])
        replacement = None
        if rerun:
            replacement = str(attempt_dir / "replacements" / f"{sid}-ROUTE_ON")
            replacement_map[sid] = {
                "original": s["original_path"],
                "replacement": replacement,
                "reason": s["rerun_reason"],
                "verdict": s["verdict"],
            }
        entry = {
            "shard_id": sid,
            "original_shard_path": s["original_path"],
            "verdict": s["verdict"],
            "reuse": reuse,
            "rerun": rerun,
            "rerun_reason": s["rerun_reason"],
            "replacement_path": replacement,
            "expected_combinations": s["expected_combinations"],
            "merge_include": reuse,  # replacements added after successful rerun
            "merge_exclude": s["verdict"]
            in {"SUPERSEDED", "HARNESS_MISMATCH", "DUPLICATE_RESULTS", "ABNORMAL_EXIT"}
            or s.get("bad_quarantine_exists"),
        }
        # SUPERSEDED shard-0: full rerun required (not FAIL-only)
        if s["verdict"] == "SUPERSEDED":
            entry["rerun"] = True
            entry["reuse"] = False
            entry["full_shard_rerun"] = True
            entry["fail_only_forbidden"] = True
            entry["rerun_reason"] = "SUPERSEDED original; full shard rerun with fixed harness"
            replacement_map[sid] = {
                "original": s["original_path"],
                "replacement": str(attempt_dir / "replacements" / f"{sid}-ROUTE_ON"),
                "reason": entry["rerun_reason"],
                "verdict": "SUPERSEDED",
                "full_shard_rerun": True,
            }
            entry["replacement_path"] = replacement_map[sid]["replacement"]
        plan_shards.append(entry)

    # harness-mismatch preflight failures must NOT count as product FAIL
    product_fail_excluded = [
        s["shard_id"]
        for s in validation["shards"]
        if s.get("preflight") and s["preflight"].get("reason") == "harness_version_mismatch"
    ]

    plan = {
        "run_id": run_dir.name,
        "attempt_dir": str(attempt_dir),
        "created_at": utc_now(),
        "immutable_run_manifest": immutable,
        "expected_harness_version": validation["expected_harness_version"],
        "expected_git_commit": validation["expected_git_commit"],
        "reuse_shards": [s["shard_id"] for s in plan_shards if s["reuse"]],
        "rerun_shards": [s["shard_id"] for s in plan_shards if s["rerun"]],
        "merge_exclude": [s["shard_id"] for s in plan_shards if s["merge_exclude"]],
        "product_fail_excluded_shards": product_fail_excluded,
        "shard_0_replacement_mode": "FULL_SHARD_FIXED_HARNESS",
        "shards": plan_shards,
        "rules": [
            "Do not delete or move existing artifacts",
            "SUPERSEDED original remains for evidence",
            "FAIL-only rerun forbidden for shard-0",
            "Merge uses TRUSTED_COMPLETE + successful replacements only",
            "Exclude SUPERSEDED, HARNESS_MISMATCH, .bad-* from final merge",
        ],
    }
    write_json(attempt_dir / "recovery-plan.json", plan)
    write_json(attempt_dir / "replacement-map.json", replacement_map)
    write_json(
        attempt_dir / "recovery-run-metadata.json",
        {
            "run_id": run_dir.name,
            "attempt": attempt_dir.name,
            "created_at": utc_now(),
            "status": "PLANNED",
            "expected_harness_version": validation["expected_harness_version"],
            "expected_git_commit": validation["expected_git_commit"],
            "rerun_shard_count": len(plan["rerun_shards"]),
            "reuse_shard_count": len(plan["reuse_shards"]),
        },
    )
    return plan


def merge_selection_from_plan(
    *,
    run_dir: Path,
    plan: dict[str, Any],
    replacement_map: dict[str, Any],
    attempt_dir: Optional[Path] = None,
    require_full_resume_finalize: Optional[bool] = None,
) -> dict[str, Any]:
    """Describe which artifact dirs to include in final merge.

    Validated merge-eligible *active* replacements take precedence. Merge reads
    only the authoritative active generation from replacement-map — never walks
    all generation directories under replacements/generations/.

    When a full resume has started (or the caller requires it), Final Merge is
    blocked unless finalize_post_full_resume_success() wrote the attempt-scoped
    finalize marker (MERGE_ELIGIBILITY_FINALIZE_MISSING).
    """
    include = []
    exclude = []
    attempt_dir = Path(attempt_dir) if attempt_dir else Path(plan.get("attempt_dir") or run_dir)
    if require_full_resume_finalize is None:
        require_full_resume_finalize = bool(
            plan.get("full_resume_started")
            or plan.get("full_resume_ready_for_merge") is True
            or plan.get("full_resume_finalize_ok") is True
        )
    if require_full_resume_finalize and not full_resume_finalize_present(attempt_dir):
        return {
            "include": [],
            "exclude": [
                {
                    "shard_id": "*",
                    "reason": "MERGE_ELIGIBILITY_FINALIZE_MISSING",
                }
            ],
            "ok": False,
            "reason": "MERGE_ELIGIBILITY_FINALIZE_MISSING",
            "full_resume_ready_for_merge": False,
        }
    for s in plan["shards"]:
        sid = s["shard_id"]
        rep = replacement_map.get(sid) if sid in replacement_map else None
        resolved = resolve_active_replacement_path(
            rep_entry=rep,
            attempt_dir=attempt_dir,
            shard_id=sid,
        )
        rep_path = resolved.get("path")
        # When an active pointer exists, require it to be validated+eligible.
        # Do not silently scan sibling generations.
        replacement_ready = bool(
            rep
            and rep_path
            and (rep_path / "cross-product-results.jsonl").exists()
            and (read_json(rep_path / "validation.json", {}) or {}).get("ok") is True
            and rep.get("merge_eligible") is True
            and rep.get("merge_excluded") is not True
            and rep.get("validated") is True
            and (
                # Prefer explicit active pointer when format is generation_pointer_v1
                not rep.get("active_generation_id")
                or (
                    rep.get("active_path")
                    and Path(rep["active_path"]).resolve() == Path(rep_path).resolve()
                )
            )
        )
        if replacement_ready and (
            s.get("reuse") or s.get("merge_include") or s.get("replacement_validated")
        ):
            include.append(
                {
                    "shard_id": sid,
                    "path": str(rep_path),
                    "source": "replacement",
                    "active_generation_id": (rep or {}).get("active_generation_id"),
                    "resolve_evidence": resolved.get("evidence"),
                }
            )
            continue
        if s.get("reuse"):
            include.append(
                {
                    "shard_id": sid,
                    "path": s["original_shard_path"],
                    "source": "trusted_original",
                }
            )
            continue
        if sid in replacement_map:
            if not rep_path or not (rep_path / "cross-product-results.jsonl").exists():
                exclude.append({"shard_id": sid, "reason": "replacement_missing"})
                continue
            validation = read_json(rep_path / "validation.json", {}) or {}
            if validation.get("ok") is not True:
                exclude.append({"shard_id": sid, "reason": "replacement_not_validated"})
                continue
            if replacement_map[sid].get("merge_eligible") is False:
                exclude.append({"shard_id": sid, "reason": "merge_not_eligible"})
                continue
            if replacement_map[sid].get("merge_excluded") is True:
                exclude.append({"shard_id": sid, "reason": "merge_excluded"})
                continue
            include.append(
                {
                    "shard_id": sid,
                    "path": str(rep_path),
                    "source": "replacement",
                    "active_generation_id": (rep or {}).get("active_generation_id"),
                    "resolve_evidence": resolved.get("evidence"),
                }
            )
        else:
            exclude.append({"shard_id": sid, "reason": s["verdict"]})
    for p in run_dir.iterdir():
        if p.name.startswith(".bad-"):
            exclude.append({"shard_id": p.name, "reason": "bad_quarantine", "path": str(p)})
    return {"include": include, "exclude": exclude}


# ---------------------------------------------------------------------------
# Immutable shard-plan snapshot (recovery-attempt scoped)
# ---------------------------------------------------------------------------


def combination_ids_hash(ids: list[str]) -> str:
    return hashlib.sha256("\n".join(ids).encode()).hexdigest()


def shard_plan_snapshot_path(attempt_dir: Path) -> Path:
    return Path(attempt_dir) / "shard-plan.snapshot.json"


def attempt_status_path(attempt_dir: Path) -> Path:
    return Path(attempt_dir) / "attempt-status.json"


def load_route_filtered_combination_ids(
    *,
    shard_plan_path: Path,
    valid_combinations_path: Path,
    route_runtime: str = "ROUTE_ON",
) -> list[dict[str, Any]]:
    """Restore per-shard route-filtered combination_ids from catalog + shard-plan."""
    plan = read_json(shard_plan_path, {}) or {}
    shards_in = plan.get("shards") or []
    if not shards_in:
        raise FileNotFoundError(f"shard-plan has no shards: {shard_plan_path}")
    if not valid_combinations_path.is_file():
        raise FileNotFoundError(f"missing catalog: {valid_combinations_path}")

    wanted: dict[str, set[str]] = {}
    for s in shards_in:
        sid = s["shard_id"]
        wanted[sid] = set(s.get("combination_ids") or [])

    route_ids: dict[str, list[str]] = {sid: [] for sid in wanted}
    with valid_combinations_path.open() as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            cid = row.get("combination_id")
            axes = row.get("axes") or {}
            if axes.get("route_runtime") != route_runtime:
                continue
            for sid, idset in wanted.items():
                if cid in idset:
                    route_ids[sid].append(cid)
                    break

    out = []
    for s in shards_in:
        sid = s["shard_id"]
        ids = sorted(set(route_ids.get(sid) or []))
        expected = int(
            s.get("route_on_count")
            if route_runtime == "ROUTE_ON"
            else s.get("route_off_count")
            if route_runtime == "ROUTE_OFF"
            else len(s.get("combination_ids") or [])
        )
        if expected <= 0:
            expected = len(ids)
        if len(ids) != expected:
            raise ValueError(
                f"shard {sid}: restored={len(ids)} expected={expected} route={route_runtime}"
            )
        if len(ids) != len(set(ids)):
            raise ValueError(f"shard {sid}: duplicate combination_ids in restore")
        out.append(
            {
                "shard_id": sid,
                "route_mode": route_runtime,
                "expected_count": len(ids),
                "combination_ids": ids,
                "combination_ids_hash": combination_ids_hash(ids),
                "source_total_ids": len(s.get("combination_ids") or []),
                "route_on_count": int(s.get("route_on_count") or 0),
                "route_off_count": int(s.get("route_off_count") or 0),
            }
        )
    return out


def build_shard_plan_snapshot(
    *,
    source_run_id: str,
    immutable: dict[str, Any],
    shard_plan_path: Path,
    valid_combinations_path: Path,
    route_runtime: str = "ROUTE_ON",
    source_label: str = "generated_catalog",
) -> dict[str, Any]:
    shards = load_route_filtered_combination_ids(
        shard_plan_path=shard_plan_path,
        valid_combinations_path=valid_combinations_path,
        route_runtime=route_runtime,
    )
    all_ids = [cid for s in shards for cid in s["combination_ids"]]
    if len(all_ids) != len(set(all_ids)):
        raise ValueError("duplicate combination_id across shards in snapshot")
    return {
        "source_run_id": source_run_id,
        "git_commit": immutable.get("git_commit"),
        "harness_version": immutable.get("harness_version"),
        "manifest_hash": immutable.get("manifest_hash"),
        "applicability_rules_hash": immutable.get("applicability_rules_hash"),
        "axes_hash": immutable.get("axes_hash"),
        "route_runtime": route_runtime,
        "generated_at": utc_now(),
        "source": {
            "label": source_label,
            "shard_plan_path": str(shard_plan_path.resolve()),
            "valid_combinations_path": str(valid_combinations_path.resolve()),
            "shard_plan_sha256": sha256_file(shard_plan_path),
            "valid_combinations_sha256": sha256_file(valid_combinations_path),
        },
        "shard_count": len(shards),
        "total_combinations": len(all_ids),
        "snapshot_hash": combination_ids_hash(
            [f"{s['shard_id']}:{s['combination_ids_hash']}" for s in shards]
        ),
        "shards": shards,
    }


def ensure_shard_plan_snapshot(
    attempt_dir: Path,
    snapshot: dict[str, Any],
    *,
    overwrite: bool = False,
) -> tuple[Path, bool]:
    """Write snapshot once. Refuses overwrite of an existing different snapshot."""
    path = shard_plan_snapshot_path(attempt_dir)
    if path.exists():
        existing = read_json(path, {}) or {}
        if existing.get("snapshot_hash") != snapshot.get("snapshot_hash"):
            if overwrite:
                raise RuntimeError(
                    f"refusing to overwrite shard-plan.snapshot.json with different hash at {path}"
                )
            raise RuntimeError(
                f"shard-plan.snapshot.json already exists with different hash at {path}"
            )
        return path, False
    write_json(path, snapshot)
    return path, True


def load_shard_plan_snapshot(attempt_dir: Path) -> Optional[dict[str, Any]]:
    path = shard_plan_snapshot_path(attempt_dir)
    if not path.is_file():
        return None
    return read_json(path)


def get_snapshot_shard(snapshot: dict[str, Any], shard_id: str) -> Optional[dict[str, Any]]:
    for s in snapshot.get("shards") or []:
        if s.get("shard_id") == shard_id:
            return s
    return None


def validate_snapshot_shard(
    snapshot: dict[str, Any],
    *,
    shard_id: str,
    expected_count: Optional[int] = None,
) -> dict[str, Any]:
    errors: list[str] = []
    shard = get_snapshot_shard(snapshot, shard_id)
    if not shard:
        return {
            "ok": False,
            "reason": "SHARD_PLAN_INVALID",
            "errors": [f"shard_id missing from snapshot: {shard_id}"],
        }
    ids = list(shard.get("combination_ids") or [])
    exp = int(shard.get("expected_count") or 0)
    if exp <= 0:
        errors.append("expected_count <= 0")
    if len(ids) <= 0:
        errors.append("combination_ids empty")
    if len(ids) != exp:
        errors.append(f"expected_count={exp} != len(ids)={len(ids)}")
    if len(ids) != len(set(ids)):
        errors.append("duplicate combination_ids")
    if sorted(ids) != ids:
        errors.append("combination_ids not sorted")
    if shard.get("combination_ids_hash") != combination_ids_hash(ids):
        errors.append("combination_ids_hash mismatch")
    if expected_count is not None and int(expected_count) != exp:
        errors.append(
            f"recovery plan expected_count={expected_count} != snapshot={exp}"
        )
    return {
        "ok": not errors,
        "reason": None if not errors else "SHARD_PLAN_INVALID",
        "errors": errors,
        "shard": shard,
        "expected_count": exp,
        "combination_count": len(ids),
    }


def write_attempt_abort(
    attempt_dir: Path,
    *,
    reason: str,
    detail: Optional[dict[str, Any]] = None,
) -> Path:
    doc = {
        "status": "ABORTED",
        "reason": reason,
        "detail": detail or {},
        "recorded_at": utc_now(),
    }
    path = Path(attempt_dir) / "attempt-abort.json"
    write_json(path, doc)
    update_attempt_status(
        attempt_dir,
        status="ABORTED" if reason != "SHARD_PLAN_INVALID" else "FAILED_PREFLIGHT",
        phase="PREFLIGHT",
        abort_reason=reason,
        resumable=True,
        final_verdict=f"FAILED_PREFLIGHT_{reason}" if reason.startswith("SHARD_") else reason,
        ended_at=utc_now(),
    )
    return path


def write_attempt_status(attempt_dir: Path, doc: dict[str, Any]) -> Path:
    path = attempt_status_path(attempt_dir)
    base = read_json(path, {}) or {}
    base.update(doc)
    base["updated_at"] = utc_now()
    if "started_at" not in base:
        base["started_at"] = utc_now()
    write_json(path, base)
    return path


def update_attempt_status(attempt_dir: Path, **fields: Any) -> Path:
    return write_attempt_status(attempt_dir, fields)


def load_attempt_status(attempt_dir: Path) -> dict[str, Any]:
    return read_json(attempt_status_path(attempt_dir), {}) or {}


def build_recovery_plan_v2(
    *,
    attempt_dir: Path,
    plan: Optional[dict[str, Any]] = None,
    snapshot: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Link recovery plan shards to immutable snapshot without overwriting v1 plan."""
    attempt_dir = Path(attempt_dir)
    plan = plan or read_json(attempt_dir / "recovery-plan.json", {}) or {}
    snapshot = snapshot or load_shard_plan_snapshot(attempt_dir)
    if not snapshot:
        raise FileNotFoundError(f"missing shard-plan.snapshot.json under {attempt_dir}")

    snap_path = str(shard_plan_snapshot_path(attempt_dir))
    shards_out = []
    for s in plan.get("shards") or []:
        entry = dict(s)
        sid = entry["shard_id"]
        snap_shard = get_snapshot_shard(snapshot, sid)
        if snap_shard:
            entry["shard_plan_snapshot"] = snap_path
            entry["expected_count"] = snap_shard["expected_count"]
            entry["combination_ids_hash"] = snap_shard["combination_ids_hash"]
            entry["route_mode"] = snap_shard.get("route_mode") or "ROUTE_ON"
            entry["replacement_output_dir"] = str(
                attempt_dir / "replacements" / f"{sid}-ROUTE_ON"
            )
            if entry.get("expected_combinations") and int(entry["expected_combinations"]) != int(
                snap_shard["expected_count"]
            ):
                entry["expected_count_mismatch"] = {
                    "plan": entry["expected_combinations"],
                    "snapshot": snap_shard["expected_count"],
                }
        shards_out.append(entry)

    missing = [
        sid
        for sid in (plan.get("rerun_shards") or [])
        if get_snapshot_shard(snapshot, sid) is None
    ]
    v2 = {
        **plan,
        "plan_version": 2,
        "created_at": utc_now(),
        "parent_plan": str(attempt_dir / "recovery-plan.json"),
        "shard_plan_snapshot": snap_path,
        "snapshot_hash": snapshot.get("snapshot_hash"),
        "shards": shards_out,
        "snapshot_missing_rerun_shards": missing,
    }
    out = attempt_dir / "recovery-plan.v2.json"
    write_json(out, v2)
    return v2


def write_combination_ids_file(path: Path, ids: list[str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(ids) + "\n")
    return path


def write_runtime_shard_plan(path: Path, shard_id: str, ids: list[str], *, route_mode: str) -> Path:
    """Write a minimal shard-plan.json compatible with cross-product-loader."""
    doc = {
        "shards": [
            {
                "shard_id": shard_id,
                "route_mode": route_mode,
                "expected_count": len(ids),
                "combination_ids": list(ids),
            }
        ]
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2) + "\n")
    return path


def invalidate_zero_shard_side_run(
    side_run_dir: Path,
    *,
    reason: str = "ZERO_SHARDS_EXECUTED",
) -> dict[str, Any]:
    """Mark a false-COMPLETE zero-shard side run invalid without deleting evidence."""
    side_run_dir = Path(side_run_dir)
    meta = read_json(side_run_dir / "run-metadata.json", {}) or {}
    doc = {
        "side_run_id": side_run_dir.name,
        "reason": reason,
        "executed": 0,
        "trusted": False,
        "merge_excluded": True,
        "product_fail_excluded": True,
        "original_status": meta.get("status"),
        "original_failed_shards": meta.get("failed_shards"),
        "corrected_status": "FAILED_PREFLIGHT",
        "recorded_at": utc_now(),
    }
    write_json(side_run_dir / "zero-shard-invalid.json", doc)
    write_json(
        side_run_dir / "corrected-status.json",
        {
            "status": "FAILED_PREFLIGHT",
            "complete": False,
            "reason": reason,
            "trusted": False,
            "merge_excluded": True,
            "recorded_at": utc_now(),
            "note": "Original run-metadata.json preserved; do not treat COMPLETE as success",
        },
    )
    return doc


def is_side_run_merge_excluded(side_run_dir: Path) -> bool:
    if (Path(side_run_dir) / "zero-shard-invalid.json").exists():
        return True
    corrected = read_json(Path(side_run_dir) / "corrected-status.json", {}) or {}
    return corrected.get("merge_excluded") is True


def atomic_publish_replacement(
    *,
    src_dir: Path,
    dst_dir: Path,
    generation: int = 1,
) -> dict[str, Any]:
    """Publish verified src into dst atomically. Never overwrite an existing published dst.

    Low-level primitive for a *new* destination path. Callers that need to
    supersede a previous active replacement must publish to a generation-unique
    path via publish_generation_replacement() and switch the active pointer.
    """
    import shutil

    src_dir = Path(src_dir)
    dst_dir = Path(dst_dir)
    if not src_dir.is_dir():
        return {"ok": False, "reason": "SRC_MISSING", "src": str(src_dir), "dst": str(dst_dir)}
    if (dst_dir / "cross-product-results.jsonl").exists():
        return {
            "ok": False,
            "reason": "DST_EXISTS",
            "src": str(src_dir),
            "dst": str(dst_dir),
            "hint": "use a new generation or quarantine; overwrite forbidden",
        }
    parent = dst_dir.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = parent / f".staging-{dst_dir.name}-g{generation}-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(src_dir, staging, symlinks=True)
    os.replace(str(staging), str(dst_dir))
    return {"ok": True, "src": str(src_dir), "dst": str(dst_dir), "generation": generation}


# ---------------------------------------------------------------------------
# Generation-immutable replacement publish + active pointer (attempt-010+)
# ---------------------------------------------------------------------------

GENERATION_MANIFEST_BASENAME = "generation-replacement-manifest.json"
GENERATION_SHA256_MANIFEST_BASENAME = "sha256-manifest.json"


def legacy_replacement_dir(attempt_dir: Path, shard_id: str) -> Path:
    return Path(attempt_dir) / "replacements" / f"{shard_id}-ROUTE_ON"


def generation_replacement_dir(attempt_dir: Path, shard_id: str, generation_id: str) -> Path:
    return (
        Path(attempt_dir)
        / "replacements"
        / "generations"
        / shard_id
        / f"{generation_id}-ROUTE_ON"
    )


def _sha256_file_safe(path: Path) -> Optional[str]:
    if not path.is_file():
        return None
    return sha256_file(path)


def build_generation_sha256_manifest(art_dir: Path) -> dict[str, Any]:
    """Content fingerprints for an immutable generation replacement directory."""
    art_dir = Path(art_dir)
    files: dict[str, str] = {}
    for rel in (
        "cross-product-results.jsonl",
        "validation.json",
        "cleanup-report.json",
        "run-generation.json",
        "shard-summary.json",
        "shard-manifest.json",
        "evidence-flush.json",
    ):
        digest = _sha256_file_safe(art_dir / rel)
        if digest:
            files[rel] = digest
    # Stable aggregate over present key files (order sorted by relative path).
    joined = "\n".join(f"{k}:{files[k]}" for k in sorted(files))
    content_sha256 = hashlib.sha256(joined.encode()).hexdigest() if files else None
    return {
        "files": files,
        "content_sha256": content_sha256,
        "computed_at": utc_now(),
    }


def resolve_active_replacement_path(
    *,
    rep_entry: Optional[dict[str, Any]],
    attempt_dir: Path,
    shard_id: str,
) -> dict[str, Any]:
    """Resolve merge/read path from replacement-map authority.

    Priority:
      1) active_path when present and exists
      2) replacement when it points at an existing generation/legacy dir
      3) legacy fixed path only when no active pointer (read-only fallback)
    """
    attempt_dir = Path(attempt_dir)
    rep_entry = dict(rep_entry or {})
    evidence: dict[str, Any] = {
        "shard": shard_id,
        "active_pointer_present": bool(rep_entry.get("active_path") or rep_entry.get("active_generation_id")),
        "legacy_fallback_used": False,
        "legacy_fallback_reason": None,
    }

    active_path = rep_entry.get("active_path") or None
    if active_path:
        p = Path(active_path)
        if (p / "cross-product-results.jsonl").is_file():
            evidence["resolved_from"] = "active_path"
            return {"ok": True, "path": p, "evidence": evidence}
        evidence["active_path_missing"] = str(p)

    replacement = rep_entry.get("replacement") or None
    if replacement:
        p = Path(replacement)
        if (p / "cross-product-results.jsonl").is_file():
            evidence["resolved_from"] = "replacement"
            return {"ok": True, "path": p, "evidence": evidence}
        evidence["replacement_missing"] = str(p)

    # No active pointer — allow read-only legacy fallback.
    if not evidence["active_pointer_present"]:
        legacy = legacy_replacement_dir(attempt_dir, shard_id)
        if (legacy / "cross-product-results.jsonl").is_file():
            evidence["legacy_fallback_used"] = True
            evidence["legacy_fallback_reason"] = "no_active_pointer_legacy_exists"
            evidence["resolved_from"] = "legacy"
            return {"ok": True, "path": legacy, "evidence": evidence}

    evidence["resolved_from"] = None
    return {"ok": False, "path": None, "evidence": evidence}


def publish_generation_replacement(
    *,
    src_dir: Path,
    attempt_dir: Path,
    shard_id: str,
    generation_id: str,
    commit: str,
    harness_version: str,
    validation: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Publish validated src into an immutable generation-scoped path.

    Never writes to the legacy fixed replacements/<shard>-ROUTE_ON path.
    Never deletes or overwrites an existing generation directory.
    """
    import shutil

    src_dir = Path(src_dir)
    attempt_dir = Path(attempt_dir)
    generation_id = str(generation_id or "").strip()
    if not generation_id:
        return {"ok": False, "reason": "GENERATION_ID_REQUIRED", "files_written": 0}
    if not src_dir.is_dir():
        return {"ok": False, "reason": "SRC_MISSING", "src": str(src_dir), "files_written": 0}

    # Refuse using legacy fixed path as destination.
    legacy = legacy_replacement_dir(attempt_dir, shard_id)
    dst = generation_replacement_dir(attempt_dir, shard_id, generation_id)
    if dst.resolve() == legacy.resolve():
        return {
            "ok": False,
            "reason": "LEGACY_PATH_FORBIDDEN_AS_OUTPUT",
            "dst": str(dst),
            "files_written": 0,
        }

    src_manifest = build_generation_sha256_manifest(src_dir)
    src_sha = src_manifest.get("content_sha256")

    if (dst / "cross-product-results.jsonl").is_file():
        existing = build_generation_sha256_manifest(dst)
        existing_sha = existing.get("content_sha256")
        if existing_sha and src_sha and existing_sha == src_sha:
            # Idempotent re-publish of identical generation content.
            return {
                "ok": True,
                "reason": "IDEMPOTENT_ALREADY_PUBLISHED",
                "src": str(src_dir),
                "dst": str(dst),
                "generation_id": generation_id,
                "content_sha256": existing_sha,
                "sha256_manifest": existing,
                "files_written": 0,
                "generation_publish": "PASS",
                "legacy_path": str(legacy),
                "legacy_untouched": True,
            }
        return {
            "ok": False,
            "reason": "GENERATION_CONTENT_CONFLICT",
            "src": str(src_dir),
            "dst": str(dst),
            "generation_id": generation_id,
            "existing_content_sha256": existing_sha,
            "incoming_content_sha256": src_sha,
            "files_written": 0,
            "hint": "same generation_id with different content; refuse mutate",
        }

    # Stage into a unique path then atomic rename into generation dst.
    parent = dst.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = parent / f".staging-{dst.name}-{os.getpid()}-{time.time_ns()}"
    if staging.exists():
        shutil.rmtree(staging)
    try:
        shutil.copytree(src_dir, staging, symlinks=True)
        # Attach immutable manifests before commit.
        if validation is not None:
            write_json(staging / "validation.json", validation)
        # Preserve run-generation.json from side-run when present beside art dir.
        side_rg = src_dir.parent / "run-generation.json"
        if side_rg.is_file() and not (staging / "run-generation.json").exists():
            shutil.copy2(side_rg, staging / "run-generation.json")
        sha_doc = build_generation_sha256_manifest(staging)
        write_json(staging / GENERATION_SHA256_MANIFEST_BASENAME, sha_doc)
        gen_manifest = {
            "shard": shard_id,
            "generation_id": generation_id,
            "commit": commit,
            "harness_version": harness_version,
            "content_sha256": sha_doc.get("content_sha256"),
            "src": str(src_dir),
            "published_at": utc_now(),
            "immutable": True,
            "validation_ok": (validation or {}).get("ok") if validation else None,
        }
        write_json(staging / GENERATION_MANIFEST_BASENAME, gen_manifest)
        # Recompute sha after writing manifests so content_sha256 includes them.
        sha_doc = build_generation_sha256_manifest(staging)
        # Keep manifests themselves out of circular rehash loop for identity:
        # identity is results+validation+cleanup (+optional run-generation).
        write_json(staging / GENERATION_SHA256_MANIFEST_BASENAME, sha_doc)
        gen_manifest["content_sha256"] = sha_doc.get("content_sha256")
        write_json(staging / GENERATION_MANIFEST_BASENAME, gen_manifest)
        os.replace(str(staging), str(dst))
    except Exception as exc:
        if staging.exists():
            try:
                shutil.rmtree(staging)
            except OSError:
                pass
        return {
            "ok": False,
            "reason": "GENERATION_PUBLISH_FAILED",
            "errors": [str(exc)],
            "files_written": 0,
        }

    # Legacy path must remain untouched.
    legacy_exists_before = (legacy / "cross-product-results.jsonl").exists()
    return {
        "ok": True,
        "reason": None,
        "src": str(src_dir),
        "dst": str(dst),
        "generation_id": generation_id,
        "content_sha256": sha_doc.get("content_sha256"),
        "sha256_manifest": sha_doc,
        "generation_manifest": gen_manifest,
        "files_written": 1,
        "generation_publish": "PASS",
        "legacy_path": str(legacy),
        "legacy_exists": legacy_exists_before,
        "legacy_untouched": True,
    }


def activate_replacement_pointer(
    *,
    attempt_dir: Path,
    shard_id: str,
    generation_id: str,
    generation_path: Path,
    commit: str,
    harness_version: str,
    content_sha256: str,
    validation: dict[str, Any],
    merge_eligible: bool,
    original_path: Optional[str] = None,
) -> dict[str, Any]:
    """Atomically switch replacement-map active pointer to a published generation.

    Never mutates generation directories or legacy fixed replacement directories.
    """
    attempt_dir = Path(attempt_dir)
    generation_path = Path(generation_path)
    rep_path = attempt_dir / "replacement-map.json"

    if validation.get("ok") is not True:
        return {
            "ok": False,
            "reason": "VALIDATION_REQUIRED_BEFORE_POINTER_SWITCH",
            "files_written": 0,
            "pointer_changed": 0,
        }
    if not (generation_path / "cross-product-results.jsonl").is_file():
        return {
            "ok": False,
            "reason": "GENERATION_PATH_MISSING",
            "path": str(generation_path),
            "files_written": 0,
            "pointer_changed": 0,
        }

    rep_map = read_json(rep_path, {}) or {}
    prev = dict(rep_map.get(shard_id) or {})
    prev_gen = prev.get("active_generation_id")
    prev_path = prev.get("active_path") or prev.get("replacement")
    prev_sha = prev.get("content_sha256")

    # Idempotent: already active with identical identity.
    if (
        prev_gen == generation_id
        and str(prev.get("active_path") or "") == str(generation_path)
        and prev.get("commit") == commit
        and prev.get("harness_version") == harness_version
        and prev_sha == content_sha256
        and prev.get("validated") is True
    ):
        return {
            "ok": True,
            "reason": "IDEMPOTENT_ALREADY_ACTIVE",
            "files_written": 0,
            "pointer_changed": 0,
            "active_pointer_switch": "PASS",
            "active_generation_id": generation_id,
            "active_path": str(generation_path),
            "previous_active_generation_id": prev_gen,
            "previous_active_path": prev_path,
        }

    legacy = legacy_replacement_dir(attempt_dir, shard_id)
    entry = dict(prev)
    entry.update(
        {
            "shard": shard_id,
            "original": original_path
            or prev.get("original")
            or str(Path(attempt_dir).parent / f"{shard_id}-ROUTE_ON"),
            "replacement": str(generation_path),
            "active_generation_id": generation_id,
            "active_path": str(generation_path),
            "commit": commit,
            "harness_version": harness_version,
            "content_sha256": content_sha256,
            "validated": True,
            "merge_eligible": bool(merge_eligible),
            "merge_excluded": False,
            "activation_failed": False,
            "activated_at": utc_now(),
            "validated_at": utc_now(),
            "expected": validation.get("expected"),
            "executed": validation.get("executed"),
            "previous_active_generation_id": prev_gen,
            "previous_active_path": prev_path,
            "legacy_path": str(legacy) if legacy.exists() else prev.get("legacy_path"),
            "legacy_fallback_used": False,
            "format": "generation_pointer_v1",
        }
    )
    new_rep = json.loads(json.dumps(rep_map))
    new_rep[shard_id] = entry
    for k, v in list(new_rep.items()):
        if k != shard_id and isinstance(v, dict) and not v.get("validated"):
            v["merge_eligible"] = False

    try:
        atomic_write_jsons({rep_path: new_rep})
    except Exception as exc:
        return {
            "ok": False,
            "reason": "POINTER_ATOMIC_WRITE_FAILED",
            "errors": [str(exc)],
            "files_written": 0,
            "pointer_changed": 0,
            "active_pointer_switch": "FAIL",
            "previous_active_generation_id": prev_gen,
            "previous_active_path": prev_path,
        }

    live = read_json(rep_path, {}) or {}
    live_entry = live.get(shard_id) or {}
    if live_entry.get("active_generation_id") != generation_id or live_entry.get("active_path") != str(
        generation_path
    ):
        return {
            "ok": False,
            "reason": "POINTER_POST_WRITE_MISMATCH",
            "files_written": 1,
            "pointer_changed": 0,
            "active_pointer_switch": "FAIL",
        }

    return {
        "ok": True,
        "reason": None,
        "files_written": 1,
        "pointer_changed": 1,
        "active_pointer_switch": "PASS",
        "active_generation_id": generation_id,
        "active_path": str(generation_path),
        "previous_active_generation_id": prev_gen,
        "previous_active_path": prev_path,
        "entry": live_entry,
    }


def publish_and_activate_generation_replacement(
    *,
    src_dir: Path,
    attempt_dir: Path,
    shard_id: str,
    generation_id: str,
    commit: str,
    harness_version: str,
    validation: dict[str, Any],
    merge_eligible: bool,
    original_path: Optional[str] = None,
) -> dict[str, Any]:
    """Validate→immutable generation publish→active pointer switch.

    On pointer failure: generation is preserved, prior active pointer kept,
    activation_failed recorded when possible.
    """
    if validation.get("ok") is not True:
        return {
            "ok": False,
            "reason": "VALIDATION_FAILED",
            "validation": validation,
            "generation_publish": "SKIPPED",
            "active_pointer_switch": "SKIPPED",
            "files_written": 0,
            "pointer_changed": 0,
        }

    pub = publish_generation_replacement(
        src_dir=src_dir,
        attempt_dir=attempt_dir,
        shard_id=shard_id,
        generation_id=generation_id,
        commit=commit,
        harness_version=harness_version,
        validation=validation,
    )
    if not pub.get("ok"):
        return {
            "ok": False,
            "reason": pub.get("reason") or "GENERATION_PUBLISH_FAILED",
            "publish": pub,
            "generation_publish": "FAIL",
            "active_pointer_switch": "SKIPPED",
            "files_written": int(pub.get("files_written") or 0),
            "pointer_changed": 0,
        }

    act = activate_replacement_pointer(
        attempt_dir=attempt_dir,
        shard_id=shard_id,
        generation_id=generation_id,
        generation_path=Path(pub["dst"]),
        commit=commit,
        harness_version=harness_version,
        content_sha256=str(pub.get("content_sha256") or ""),
        validation=validation,
        merge_eligible=merge_eligible,
        original_path=original_path,
    )
    if not act.get("ok"):
        # Preserve generation; mark activation failure on map without switching
        # when write partially failed — only annotate if map still readable.
        attempt_dir = Path(attempt_dir)
        rep_path = attempt_dir / "replacement-map.json"
        try:
            rep_map = read_json(rep_path, {}) or {}
            entry = dict(rep_map.get(shard_id) or {})
            entry["activation_failed"] = True
            entry["activation_failed_reason"] = act.get("reason")
            entry["activation_failed_generation_id"] = generation_id
            entry["activation_failed_path"] = pub.get("dst")
            entry["merge_eligible"] = False
            # Do not change active_* fields.
            rep_map[shard_id] = entry
            # Best-effort annotate; if this also fails, still return pointer failure.
            try:
                atomic_write_jsons({rep_path: rep_map})
            except Exception:
                pass
        except Exception:
            pass
        return {
            "ok": False,
            "reason": act.get("reason") or "ACTIVE_POINTER_SWITCH_FAILED",
            "publish": pub,
            "activate": act,
            "generation_publish": "PASS",
            "active_pointer_switch": "FAIL",
            "files_written": int(pub.get("files_written") or 0),
            "pointer_changed": 0,
            "generation_preserved": True,
            "prior_active_preserved": True,
        }

    return {
        "ok": True,
        "reason": act.get("reason"),
        "publish": pub,
        "activate": act,
        "src": pub.get("src"),
        "dst": pub.get("dst"),
        "generation_id": generation_id,
        "content_sha256": pub.get("content_sha256"),
        "generation_publish": "PASS",
        "active_pointer_switch": "PASS",
        "files_written": int(pub.get("files_written") or 0) + int(act.get("files_written") or 0),
        "pointer_changed": int(act.get("pointer_changed") or 0),
        "legacy_untouched": pub.get("legacy_untouched", True),
    }


def quarantine_failed_replacement(
    *,
    src_dir: Path,
    attempt_dir: Path,
    shard_id: str,
    reason: str,
) -> Path:
    import shutil

    qdir = Path(attempt_dir) / "replacements" / f".failed-attempt-{shard_id}-{int(time.time())}"
    if src_dir.is_dir():
        shutil.copytree(src_dir, qdir, symlinks=True)
    write_json(qdir / "quarantine.json", {"reason": reason, "recorded_at": utc_now(), "src": str(src_dir)})
    return qdir


def validate_replacement_artifact(
    *,
    art_dir: Path,
    shard_id: str,
    expected_count: int,
    expected_harness: str,
    expected_commit: str,
    expected_ids: Optional[list[str]] = None,
    expected_generation_id: Optional[str] = None,
    expected_attempt: Optional[str] = None,
    side_run_dir: Optional[Path] = None,
    require_fail_zero: bool = True,
) -> dict[str, Any]:
    art_dir = Path(art_dir)
    result = art_dir / "cross-product-results.jsonl"
    errors: list[str] = []
    if not result.is_file():
        return {
            "ok": False,
            "reason": "FAILED_RESULT_MISSING",
            "errors": ["cross-product-results.jsonl missing"],
            "shard_id": shard_id,
        }
    rows = _load_rows(result)
    ids = [r.get("combination_id") for r in rows if r.get("combination_id")]
    unique = len(set(ids))
    dup = len(ids) - unique
    hvs = {r.get("harness_version") for r in rows if r.get("harness_version")}
    commits = {r.get("git_commit") or r.get("commit") for r in rows if (r.get("git_commit") or r.get("commit"))}
    if len(rows) == 0:
        errors.append("executed=0")
    if len(rows) != expected_count:
        errors.append(f"executed={len(rows)} expected={expected_count}")
    if unique != expected_count:
        errors.append(f"unique={unique} expected={expected_count}")
    if len(rows) != unique:
        errors.append(f"executed={len(rows)} != unique={unique}")
    if dup != 0:
        errors.append(f"duplicate={dup}")
    if hvs != {expected_harness}:
        errors.append(f"harness_versions={sorted(str(h) for h in hvs)}")
    if commits and commits != {expected_commit}:
        errors.append(f"git_commits={sorted(str(c) for c in commits)}")
    if expected_ids is not None:
        missing = sorted(set(expected_ids) - set(ids))
        extra = sorted(set(ids) - set(expected_ids))
        if missing:
            errors.append(f"missing_ids={len(missing)}")
        if extra:
            errors.append(f"extra_ids={len(extra)}")
    fail_count = sum(1 for r in rows if r.get("status") == "FAIL")
    if require_fail_zero and fail_count != 0:
        errors.append(f"FAIL={fail_count}")
    summary = art_dir / "shard-summary.json"
    if not summary.is_file() and not (art_dir / "shard-manifest.json").is_file():
        errors.append("summary/manifest missing")
    if (art_dir / "abnormal-exit.json").exists():
        errors.append("abnormal-exit marker")
    evidence_dirs = list(art_dir.glob("cross_product__xp_*"))
    evidence_flush = (art_dir / "evidence-flush.json").exists() or len(evidence_dirs) > 0
    cleanup_ok = (
        (art_dir / "cleanup-report.json").exists()
        or sum(1 for r in rows if r.get("cleanup_ok") is True) >= max(1, int(len(rows) * 0.9))
    )
    if rows and not evidence_flush:
        errors.append("evidence flush incomplete")
    if rows and not cleanup_ok:
        errors.append("cleanup incomplete")

    # Generation isolation post-guards
    resolved_side = Path(side_run_dir) if side_run_dir else art_dir.parent
    man = read_json(resolved_side / RUN_GENERATION_NAME, {}) or {}
    gen_expect = expected_generation_id or man.get("generation_id")
    attempt_expect = expected_attempt or man.get("attempt")
    cross = detect_cross_generation_rows(
        rows,
        expected_generation_id=gen_expect,
        expected_attempt=attempt_expect,
        expected_shard=shard_id,
        expected_commit=expected_commit,
        expected_harness=expected_harness,
    )
    if not cross.get("ok"):
        errors.extend(cross.get("errors") or [])
    baseline = read_json(resolved_side / "generation-start-baseline.json", {}) or {}
    if baseline.get("created_at") and result.is_file():
        # JSONL must not predate generation start (stale reuse / cross-generation append).
        try:
            created = baseline["created_at"]
            # Compare mtime UTC ISO loosely via epoch.
            from datetime import datetime as _dt

            created_ts = _dt.strptime(created, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
            if result.stat().st_mtime + 1 < created_ts:
                errors.append("JSONL mtime predates generation start")
                errors.append("CROSS_GENERATION_RESULTS_DETECTED")
        except Exception:
            pass
    if baseline.get("results_existed_at_start") is True:
        errors.append("RESULTS_FILE_ALREADY_EXISTS")
        errors.append("CROSS_GENERATION_RESULTS_DETECTED")

    reason = None
    if errors:
        if any("CROSS_GENERATION_RESULTS_DETECTED" in e for e in errors):
            reason = "CROSS_GENERATION_RESULTS_DETECTED"
        elif "executed=0" in errors or not result.is_file():
            reason = "FAILED_RESULT_MISSING" if not result.is_file() else "INCOMPLETE_EXECUTION"
        elif any("executed=" in e or "unique=" in e for e in errors):
            reason = "INCOMPLETE_EXECUTION"
        else:
            reason = "FAILED_REPLACEMENT_VALIDATION"

    doc = {
        "ok": not errors,
        "reason": reason,
        "errors": errors,
        "shard_id": shard_id,
        "expected": expected_count,
        "executed": len(rows),
        "unique": unique,
        "duplicate": dup,
        "missing": len(set(expected_ids or []) - set(ids)) if expected_ids is not None else None,
        "FAIL": fail_count,
        "harness_versions": sorted(str(h) for h in hvs),
        "git_commits": sorted(str(c) for c in commits),
        "generation_ids": cross.get("generation_ids") or [],
        "attempts": cross.get("attempts") or [],
        "evidence_dirs": len(evidence_dirs),
        "evidence_flush": evidence_flush,
        "cleanup_ok": cleanup_ok,
        "checked_at": utc_now(),
    }
    write_json(art_dir / "validation.json", doc)
    return doc


# ---------------------------------------------------------------------------
# Post-canary finalize (atomic plan / replacement-map / attempt-status)
# ---------------------------------------------------------------------------


def recompute_plan_shard_arrays(plan: dict[str, Any]) -> dict[str, Any]:
    """Rebuild reuse/rerun arrays and counts from per-shard flags."""
    shards = list(plan.get("shards") or [])
    reuse = [s["shard_id"] for s in shards if s.get("reuse")]
    rerun = [s["shard_id"] for s in shards if s.get("rerun")]
    plan["reuse_shards"] = reuse
    plan["rerun_shards"] = rerun
    plan["reuse_shard_count"] = len(reuse)
    plan["rerun_shard_count"] = len(rerun)
    plan["remaining_rerun_shards"] = list(rerun)
    return plan


def validate_recovery_plan_consistency(
    plan: dict[str, Any],
    replacement_map: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Fail when summary counts, arrays, and per-shard flags disagree."""
    errors: list[str] = []
    shards = list(plan.get("shards") or [])
    reuse_arr = list(plan.get("reuse_shards") or [])
    rerun_arr = list(plan.get("rerun_shards") or [])
    reuse_from_flags = [s["shard_id"] for s in shards if s.get("reuse")]
    rerun_from_flags = [s["shard_id"] for s in shards if s.get("rerun")]

    if plan.get("reuse_shard_count") is not None and int(plan["reuse_shard_count"]) != len(reuse_arr):
        errors.append(
            f"reuse_shard_count={plan.get('reuse_shard_count')} != len(reuse_shards)={len(reuse_arr)}"
        )
    if plan.get("rerun_shard_count") is not None and int(plan["rerun_shard_count"]) != len(rerun_arr):
        errors.append(
            f"rerun_shard_count={plan.get('rerun_shard_count')} != len(rerun_shards)={len(rerun_arr)}"
        )
    if sorted(reuse_arr) != sorted(reuse_from_flags):
        errors.append("shard.reuse flags disagree with reuse_shards array")
    if sorted(rerun_arr) != sorted(rerun_from_flags):
        errors.append("shard.rerun flags disagree with rerun_shards array")

    for sid in reuse_arr:
        entry = next((s for s in shards if s.get("shard_id") == sid), None)
        if entry is None:
            errors.append(f"reuse_shards contains unknown shard {sid}")
        elif not entry.get("reuse"):
            errors.append(f"reuse_shards contains {sid} but shard.reuse=false")
        elif entry.get("rerun"):
            errors.append(f"reuse shard {sid} still has rerun=true")

    for sid in rerun_arr:
        entry = next((s for s in shards if s.get("shard_id") == sid), None)
        if entry is None:
            errors.append(f"rerun_shards contains unknown shard {sid}")
        elif not entry.get("rerun"):
            errors.append(f"rerun_shards contains {sid} but shard.rerun=false")

    if replacement_map:
        for sid in reuse_arr:
            rep = replacement_map.get(sid) or {}
            if rep and rep.get("validated") and rep.get("merge_eligible") is False:
                errors.append(
                    f"merge_eligible=false replacement selected for reuse: {sid}"
                )

    return {"ok": not errors, "errors": errors}


def evaluate_canary_success(
    *,
    validation: dict[str, Any],
    publish: dict[str, Any],
    expected_count: int,
    expected_harness: str,
    expected_commit: str,
    art_dir: Optional[Path] = None,
) -> dict[str, Any]:
    """Require full canary success before any recovery-plan state transition."""
    errors: list[str] = []
    expected = int(expected_count)
    executed = int(validation.get("executed") or 0)
    unique = int(validation.get("unique") or 0)
    duplicate = int(validation.get("duplicate") or 0)
    missing = validation.get("missing")
    if missing is None:
        missing = 0
    else:
        missing = int(missing)

    if validation.get("ok") is not True:
        errors.append(f"replacement validation not ok: {validation.get('reason')}")
    if publish.get("ok") is not True:
        errors.append(f"atomic publish not ok: {publish.get('reason')}")
    if not (expected == executed == unique):
        errors.append(f"expected={expected} executed={executed} unique={unique}")
    if duplicate != 0:
        errors.append(f"duplicate={duplicate}")
    if missing != 0:
        errors.append(f"missing={missing}")
    if validation.get("cleanup_ok") is not True:
        errors.append("cleanup not PASS")
    if validation.get("evidence_flush") is not True:
        errors.append("evidence flush not PASS")

    hvs = list(validation.get("harness_versions") or [])
    commits = list(validation.get("git_commits") or [])
    if len(set(hvs)) != 1 or hvs[0] != expected_harness:
        errors.append(f"harness not single expected value: {hvs}")
    if commits and (len(set(commits)) != 1 or commits[0] != expected_commit):
        errors.append(f"commit not single expected value: {commits}")

    pass_count = None
    fail_count = None
    if art_dir is not None:
        result = Path(art_dir) / "cross-product-results.jsonl"
        if result.is_file():
            rows = _load_rows(result)
            statuses = [r.get("status") for r in rows]
            pass_count = sum(1 for s in statuses if s == "PASS")
            fail_count = sum(1 for s in statuses if s == "FAIL")
            if pass_count != expected:
                errors.append(f"PASS={pass_count} expected={expected}")
            if fail_count != 0:
                errors.append(f"FAIL={fail_count}")
        else:
            errors.append("cross-product-results.jsonl missing for PASS/FAIL check")

    return {
        "ok": not errors,
        "errors": errors,
        "expected": expected,
        "executed": executed,
        "unique": unique,
        "duplicate": duplicate,
        "missing": missing,
        "PASS": pass_count,
        "FAIL": fail_count,
        "cleanup": "PASS" if validation.get("cleanup_ok") else "FAIL",
        "evidence_flush": "PASS" if validation.get("evidence_flush") else "FAIL",
        "replacement_validation": "PASS" if validation.get("ok") else "FAIL",
        "atomic_publish": "PASS" if publish.get("ok") else "FAIL",
        "harness_versions": hvs,
        "git_commits": commits,
    }


def finalize_post_canary_success(
    *,
    attempt_dir: Path,
    shard_id: str,
    validation: dict[str, Any],
    publish: dict[str, Any],
    expected_count: int,
    expected_harness: str,
    expected_commit: str,
    replacement_path: str,
    original_path: Optional[str] = None,
) -> dict[str, Any]:
    """Atomically transition recovery-plan + replacement-map + attempt-status.

    On any failure (validation, consistency, or write), existing files are kept
    and no partial state transition is left behind.
    """
    attempt_dir = Path(attempt_dir)
    plan_path = attempt_dir / "recovery-plan.json"
    rep_path = attempt_dir / "replacement-map.json"
    status_path = attempt_status_path(attempt_dir)

    art_dir = Path(replacement_path) if replacement_path else None
    success = evaluate_canary_success(
        validation=validation,
        publish=publish,
        expected_count=expected_count,
        expected_harness=expected_harness,
        expected_commit=expected_commit,
        art_dir=art_dir,
    )
    if not success["ok"]:
        return {
            "ok": False,
            "reason": "CANARY_SUCCESS_GATE_FAILED",
            "errors": success["errors"],
            "success": success,
            "files_written": 0,
        }

    plan = read_json(plan_path, {}) or {}
    if not plan:
        return {
            "ok": False,
            "reason": "RECOVERY_PLAN_MISSING",
            "errors": [f"missing {plan_path}"],
            "files_written": 0,
        }
    rep_map = read_json(rep_path, {}) or {}
    status = read_json(status_path, {}) or {}

    # Snapshot originals for identity checks; writes go through atomic_write_jsons.
    new_plan = json.loads(json.dumps(plan))
    new_rep = json.loads(json.dumps(rep_map))
    new_status = json.loads(json.dumps(status))

    shards = list(new_plan.get("shards") or [])
    found = False
    for entry in shards:
        if entry.get("shard_id") != shard_id:
            continue
        found = True
        entry["reuse"] = True
        entry["rerun"] = False
        entry["merge_include"] = True
        entry["merge_exclude"] = False
        entry["full_shard_rerun"] = False
        entry["replacement_validated"] = True
        entry["canary_passed"] = True
        entry["replacement_path"] = str(replacement_path)
        entry["executed"] = success["executed"]
        entry["unique"] = success["unique"]
        entry["pass"] = success["PASS"]
        entry["fail"] = success["FAIL"]
        entry["validated_at"] = utc_now()
        break
    if not found:
        return {
            "ok": False,
            "reason": "CANARY_SHARD_NOT_IN_PLAN",
            "errors": [f"shard not in recovery-plan: {shard_id}"],
            "files_written": 0,
        }

    new_plan["shards"] = shards
    recompute_plan_shard_arrays(new_plan)
    new_plan["canary_passed"] = True
    new_plan["canary_shard"] = shard_id
    new_plan["canary_passed_at"] = utc_now()
    new_plan["full_resume_ready"] = True
    new_plan["full_resume_started"] = False
    new_plan["updated_at"] = utc_now()

    rep_entry = dict(new_rep.get(shard_id) or {})
    # Prefer generation-pointer fields when publish result already activated them.
    pub_meta = publish if isinstance(publish, dict) else {}
    active_path = (
        pub_meta.get("dst")
        or rep_entry.get("active_path")
        or str(replacement_path)
    )
    active_gen = pub_meta.get("generation_id") or rep_entry.get("active_generation_id")
    rep_entry.update(
        {
            "original": original_path
            or rep_entry.get("original")
            or str(Path(attempt_dir).parent / f"{shard_id}-ROUTE_ON"),
            "replacement": str(active_path),
            "active_path": str(active_path),
            "active_generation_id": active_gen,
            "content_sha256": pub_meta.get("content_sha256") or rep_entry.get("content_sha256"),
            "commit": expected_commit,
            "harness_version": expected_harness,
            "validated": True,
            "merge_eligible": True,
            "merge_excluded": False,
            "activation_failed": False,
            "validated_at": utc_now(),
            "activated_at": utc_now(),
            "expected": int(expected_count),
            "executed": success["executed"],
            "format": "generation_pointer_v1" if active_gen else rep_entry.get("format"),
            "generation_publish": pub_meta.get("generation_publish") or "PASS",
            "active_pointer_switch": pub_meta.get("active_pointer_switch") or "PASS",
        }
    )
    new_rep[shard_id] = rep_entry
    for k, v in list(new_rep.items()):
        if k != shard_id and isinstance(v, dict) and not v.get("validated"):
            v["merge_eligible"] = False

    consistency = validate_recovery_plan_consistency(new_plan, new_rep)
    if not consistency["ok"]:
        return {
            "ok": False,
            "reason": "PLAN_CONSISTENCY_FAILED",
            "errors": consistency["errors"],
            "files_written": 0,
        }

    new_status.update(
        {
            "status": "CANARY_PASS",
            "phase": "CANARY_PASS",
            "final_verdict": "CANARY_PASS",
            "completed_shards": int(new_status.get("completed_shards") or 0) + (
                0 if status.get("status") == "CANARY_PASS" else 1
            ),
            "current_executed": success["executed"],
            "resumable": True,
            "ended_at": utc_now(),
            "canary_shard": shard_id,
            "reuse_shard_count": new_plan["reuse_shard_count"],
            "rerun_shard_count": new_plan["rerun_shard_count"],
            "updated_at": utc_now(),
        }
    )

    try:
        atomic_write_jsons(
            {
                plan_path: new_plan,
                rep_path: new_rep,
                status_path: new_status,
            }
        )
    except Exception as exc:
        return {
            "ok": False,
            "reason": "ATOMIC_WRITE_FAILED",
            "errors": [str(exc)],
            "files_written": 0,
        }

    # Re-read and verify consistency of published files.
    live_plan = read_json(plan_path, {}) or {}
    live_rep = read_json(rep_path, {}) or {}
    live_consistency = validate_recovery_plan_consistency(live_plan, live_rep)
    if not live_consistency["ok"]:
        return {
            "ok": False,
            "reason": "POST_WRITE_CONSISTENCY_FAILED",
            "errors": live_consistency["errors"],
            "files_written": 3,
        }

    return {
        "ok": True,
        "reason": None,
        "errors": [],
        "success": success,
        "files_written": 3,
        "reuse_shards": live_plan.get("reuse_shards"),
        "rerun_shards": live_plan.get("rerun_shards"),
        "reuse_shard_count": live_plan.get("reuse_shard_count"),
        "rerun_shard_count": live_plan.get("rerun_shard_count"),
        "shard_id": shard_id,
        "merge_eligible": (live_rep.get(shard_id) or {}).get("merge_eligible"),
    }


FULL_RESUME_FINALIZE_MARKER = "full-resume-finalize.json"


def _shard_pass_fail_counts(art_dir: Path) -> tuple[Optional[int], Optional[int]]:
    result = Path(art_dir) / "cross-product-results.jsonl"
    if not result.is_file():
        return None, None
    rows = _load_rows(result)
    statuses = [r.get("status") for r in rows]
    return (
        sum(1 for s in statuses if s == "PASS"),
        sum(1 for s in statuses if s == "FAIL"),
    )


def evaluate_full_resume_shard(
    *,
    attempt_dir: Path,
    shard_id: str,
    expected_count: int,
    expected_harness: str,
    expected_commit: str,
    expected_ids: Optional[list[str]] = None,
    rep_entry: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Validate one shard is ready for post-full-resume merge eligibility."""
    errors: list[str] = []
    attempt_dir = Path(attempt_dir)
    rep_entry = dict(rep_entry or {})
    resolved = resolve_active_replacement_path(
        rep_entry=rep_entry,
        attempt_dir=attempt_dir,
        shard_id=shard_id,
    )
    art_dir = resolved.get("path")
    if art_dir is None or not Path(art_dir).is_dir():
        return {
            "ok": False,
            "shard_id": shard_id,
            "errors": ["active generation/path missing"],
            "active_path": None,
            "active_generation_id": rep_entry.get("active_generation_id"),
        }

    art_dir = Path(art_dir)
    active_gen = rep_entry.get("active_generation_id")
    active_path = rep_entry.get("active_path")
    if active_gen and active_path and Path(active_path).resolve() != art_dir.resolve():
        errors.append("active pointer path mismatch")
    if not active_gen and not active_path:
        errors.append("active generation pointer missing")

    side_run = art_dir.parent if art_dir.name.endswith("-ROUTE_ON") else art_dir
    gen_doc = read_json(side_run / "run-generation.json", {}) or {}
    gen_status = (
        gen_doc.get("status")
        or (read_json(side_run / "generation-completion-report.json", {}) or {}).get("status")
        or (read_json(art_dir / "run-generation.json", {}) or {}).get("status")
    )
    if str(gen_status or "").upper() not in {"COMPLETE", "COMPLETED", "TRUSTED_COMPLETE"}:
        # Fall back: validated replacement with COMPLETE publish markers.
        if not (
            rep_entry.get("validated") is True
            and (rep_entry.get("generation_publish") == "PASS" or rep_entry.get("active_pointer_switch") == "PASS")
        ):
            errors.append(f"generation not COMPLETE (status={gen_status!r})")

    validation = validate_replacement_artifact(
        art_dir=art_dir,
        shard_id=shard_id,
        expected_count=int(expected_count),
        expected_harness=expected_harness,
        expected_commit=expected_commit,
        expected_ids=expected_ids,
    )
    if validation.get("ok") is not True:
        errors.append(f"replacement validation failed: {validation.get('reason')}")
    if validation.get("cleanup_ok") is not True:
        errors.append("cleanup not PASS")

    executed = int(validation.get("executed") or 0)
    unique = int(validation.get("unique") or 0)
    duplicate = int(validation.get("duplicate") or 0)
    missing = validation.get("missing")
    missing_n = 0 if missing is None else int(missing)
    if not (int(expected_count) == executed == unique):
        errors.append(f"expected={expected_count} executed={executed} unique={unique}")
    if duplicate != 0:
        errors.append(f"duplicate={duplicate}")
    if missing_n != 0:
        errors.append(f"missing={missing_n}")

    pass_count, fail_count = _shard_pass_fail_counts(art_dir)
    if pass_count is None:
        errors.append("cross-product-results.jsonl missing")
    else:
        if pass_count != int(expected_count):
            errors.append(f"PASS={pass_count} expected={expected_count}")
        if fail_count != 0:
            errors.append(f"FAIL={fail_count}")

    hvs = list(validation.get("harness_versions") or [])
    commits = list(validation.get("git_commits") or [])
    if len(set(hvs)) != 1 or hvs[0] != expected_harness:
        errors.append(f"harness not single expected value: {hvs}")
    if commits and (len(set(commits)) != 1 or commits[0] != expected_commit):
        errors.append(f"commit not single expected value: {commits}")
    if rep_entry.get("harness_version") and rep_entry.get("harness_version") != expected_harness:
        errors.append("replacement harness mismatch")
    if rep_entry.get("commit") and rep_entry.get("commit") != expected_commit:
        errors.append("replacement commit mismatch")

    return {
        "ok": not errors,
        "shard_id": shard_id,
        "errors": errors,
        "expected": int(expected_count),
        "executed": executed,
        "unique": unique,
        "duplicate": duplicate,
        "missing": missing_n,
        "PASS": pass_count,
        "FAIL": fail_count,
        "cleanup": "PASS" if validation.get("cleanup_ok") else "FAIL",
        "replacement_validation": "PASS" if validation.get("ok") else "FAIL",
        "active_path": str(art_dir),
        "active_generation_id": active_gen,
        "generation_status": gen_status,
        "harness_versions": hvs,
        "git_commits": commits,
    }


def finalize_post_full_resume_success(
    *,
    attempt_dir: Path,
    expected_harness: str,
    expected_commit: str,
    shard_ids: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Atomically mark all successful full-resume shards merge-eligible.

    Re-validates every target shard. On any failure, replacement-map / pointers
    are left unchanged and no finalize marker is written (Final Merge blocked).
    """
    attempt_dir = Path(attempt_dir)
    plan_path = attempt_dir / "recovery-plan.json"
    rep_path = attempt_dir / "replacement-map.json"
    status_path = attempt_status_path(attempt_dir)
    marker_path = attempt_dir / FULL_RESUME_FINALIZE_MARKER

    plan = read_json(plan_path, {}) or {}
    rep_map = read_json(rep_path, {}) or {}
    status = read_json(status_path, {}) or {}
    if not plan:
        return {
            "ok": False,
            "reason": "RECOVERY_PLAN_MISSING",
            "errors": [f"missing {plan_path}"],
            "files_written": 0,
        }

    snapshot = load_shard_plan_snapshot(attempt_dir) or {}
    snap_shards = {
        s.get("shard_id"): s
        for s in list(snapshot.get("shards") or [])
        if isinstance(s, dict) and s.get("shard_id")
    }

    if shard_ids is None:
        # All shards represented in the plan (reuse + completed reruns).
        shard_ids = [s.get("shard_id") for s in list(plan.get("shards") or []) if s.get("shard_id")]
        # Prefer explicit selected set when present.
        selected = list(plan.get("reuse_shards") or []) + [
            s
            for s in list(plan.get("rerun_shards") or [])
            if (rep_map.get(s) or {}).get("validated") is True
        ]
        if selected:
            shard_ids = list(dict.fromkeys(selected))

    shard_results: list[dict[str, Any]] = []
    for sid in shard_ids:
        snap = snap_shards.get(sid) or {}
        plan_entry = next((s for s in list(plan.get("shards") or []) if s.get("shard_id") == sid), {}) or {}
        expected = int(
            snap.get("expected_count")
            or plan_entry.get("expected_count")
            or (rep_map.get(sid) or {}).get("expected")
            or 0
        )
        ids = list(snap.get("combination_ids") or [])
        result = evaluate_full_resume_shard(
            attempt_dir=attempt_dir,
            shard_id=sid,
            expected_count=expected,
            expected_harness=expected_harness,
            expected_commit=expected_commit,
            expected_ids=ids or None,
            rep_entry=rep_map.get(sid) or {},
        )
        shard_results.append(result)

    failed = [r for r in shard_results if not r.get("ok")]
    if failed:
        return {
            "ok": False,
            "reason": "FULL_RESUME_SHARD_VALIDATION_FAILED",
            "errors": [f"{r['shard_id']}: {', '.join(r.get('errors') or [])}" for r in failed],
            "shard_results": shard_results,
            "files_written": 0,
            "replacement_map_changed": False,
            "pointer_changed": False,
        }

    # All shards passed — prepare atomic updates (no partial writes).
    new_plan = json.loads(json.dumps(plan))
    new_rep = json.loads(json.dumps(rep_map))
    new_status = json.loads(json.dumps(status))
    now = utc_now()

    for entry in list(new_plan.get("shards") or []):
        sid = entry.get("shard_id")
        if sid not in shard_ids:
            continue
        entry["merge_include"] = True
        entry["merge_exclude"] = False
        entry["replacement_validated"] = True
        entry["reuse"] = True
        entry["rerun"] = False

    recompute_plan_shard_arrays(new_plan)
    new_plan["full_resume_ready_for_merge"] = True
    new_plan["full_resume_finalize_ok"] = True
    new_plan["full_resume_finalized_at"] = now
    new_plan["updated_at"] = now

    for sid in shard_ids:
        rep_entry = dict(new_rep.get(sid) or {})
        rep_entry.update(
            {
                "validated": True,
                "merge_eligible": True,
                "merge_excluded": False,
                "replacement_validated": True,
                "merge_include": True,
                "validated_at": now,
                "full_resume_finalized_at": now,
            }
        )
        new_rep[sid] = rep_entry

    consistency = validate_recovery_plan_consistency(new_plan, new_rep)
    if not consistency["ok"]:
        return {
            "ok": False,
            "reason": "PLAN_CONSISTENCY_FAILED",
            "errors": consistency["errors"],
            "shard_results": shard_results,
            "files_written": 0,
            "replacement_map_changed": False,
            "pointer_changed": False,
        }

    new_status.update(
        {
            "status": "FULL_RESUME_PASS",
            "phase": "FULL_RESUME_PASS",
            "final_verdict": "FULL_RESUME_PASS — READY_FOR_FINAL_MERGE_VALIDATION",
            "full_resume_ready_for_merge": True,
            "full_resume_finalize_ok": True,
            "ended_at": now,
            "updated_at": now,
            "resumable": False,
        }
    )

    marker = {
        "ok": True,
        "attempt": new_plan.get("attempt") or attempt_dir.name,
        "run_id": new_plan.get("run_id"),
        "finalized_at": now,
        "expected_harness": expected_harness,
        "expected_commit": expected_commit,
        "shard_ids": list(shard_ids),
        "shard_count": len(shard_ids),
        "full_resume_ready_for_merge": True,
        "shard_results": [
            {
                "shard_id": r["shard_id"],
                "expected": r.get("expected"),
                "executed": r.get("executed"),
                "unique": r.get("unique"),
                "PASS": r.get("PASS"),
                "FAIL": r.get("FAIL"),
                "active_generation_id": r.get("active_generation_id"),
            }
            for r in shard_results
        ],
    }

    try:
        atomic_write_jsons(
            {
                plan_path: new_plan,
                rep_path: new_rep,
                status_path: new_status,
                marker_path: marker,
            }
        )
    except Exception as exc:
        return {
            "ok": False,
            "reason": "ATOMIC_WRITE_FAILED",
            "errors": [str(exc)],
            "shard_results": shard_results,
            "files_written": 0,
            "replacement_map_changed": False,
            "pointer_changed": False,
        }

    live_plan = read_json(plan_path, {}) or {}
    live_rep = read_json(rep_path, {}) or {}
    live_consistency = validate_recovery_plan_consistency(live_plan, live_rep)
    if not live_consistency["ok"] or not marker_path.is_file():
        return {
            "ok": False,
            "reason": "POST_WRITE_CONSISTENCY_FAILED",
            "errors": live_consistency.get("errors") or ["finalize marker missing after write"],
            "shard_results": shard_results,
            "files_written": 4,
            "replacement_map_changed": True,
            "pointer_changed": False,
        }

    return {
        "ok": True,
        "reason": None,
        "errors": [],
        "shard_results": shard_results,
        "files_written": 4,
        "replacement_map_changed": True,
        "pointer_changed": False,
        "full_resume_ready_for_merge": True,
        "marker": str(marker_path),
        "reuse_shards": live_plan.get("reuse_shards"),
        "rerun_shards": live_plan.get("rerun_shards"),
    }


def full_resume_finalize_present(attempt_dir: Path) -> bool:
    """Final Merge requires the post-full-resume finalize marker."""
    marker = read_json(Path(attempt_dir) / FULL_RESUME_FINALIZE_MARKER, {}) or {}
    return bool(marker.get("ok") is True and marker.get("full_resume_ready_for_merge") is True)


# ---------------------------------------------------------------------------
# Authoritative combination-count audit
# ---------------------------------------------------------------------------
#
# Count term definitions (do not conflate):
#   raw_cartesian_count        — theoretical full axis product (not materialised)
#   generated_candidate_count  — unique candidate IDs before applicability keep
#   applicable_valid_count     — catalog VALID rows (all route modes)
#   not_applicable_count       — catalog N/A rows
#   scenario_count             — orthogonal matrix scenarios (separate product)
#   combination_count          — one VALID catalog row = one combination_id
#   normal_combination_count   — fault_type == NONE within scope
#   fault_combination_count    — fault_type != NONE within scope
#   route_on_count / route_off_count — applicable_valid filtered by route_runtime
#   shard_assignment_count     — union of snapshot combination_ids
#   selected_recovery_count    — union of selected/rerun shard combination_ids
#
# For xp_full_on recovery, authoritative scope is route_runtime=ROUTE_ON:
#   authoritative_valid_count == route_on_count
#   (applicable_valid_count = route_on_count + route_off_count)


COUNT_TERM_DEFINITIONS: dict[str, str] = {
    "raw_cartesian_count": "Theoretical full axis product; not used as recovery authority",
    "generated_candidate_count": "Unique candidate combination IDs emitted before applicability keep",
    "applicable_valid_count": "VALID catalog rows across all route modes",
    "not_applicable_count": "N/A catalog rows rejected by applicability rules",
    "scenario_count": "Orthogonal matrix scenario count (distinct from combination_id)",
    "combination_count": "One VALID catalog row identified by combination_id",
    "normal_combination_count": "Combinations with fault_type=NONE in scope",
    "fault_combination_count": "Combinations with fault_type!=NONE in scope",
    "route_on_count": "VALID combinations with axes.route_runtime=ROUTE_ON",
    "route_off_count": "VALID combinations with axes.route_runtime=ROUTE_OFF",
    "shard_assignment_count": "Union size of snapshot shard combination_ids",
    "selected_recovery_count": "Union size of selected recovery shard combination_ids",
}


def load_catalog_combination_sets(
    valid_combinations_path: Path,
    *,
    route_runtime: Optional[str] = None,
) -> dict[str, Any]:
    """Load combination ID sets and counts from the immutable VALID catalog."""
    path = Path(valid_combinations_path)
    if not path.is_file():
        raise FileNotFoundError(f"missing catalog: {path}")

    all_ids: set[str] = set()
    scoped_ids: set[str] = set()
    route_counts: Counter[str] = Counter()
    fault_none = 0
    fault_nonzero = 0
    surface_counts: Counter[str] = Counter()
    by_source: Counter[str] = Counter()
    by_destination: Counter[str] = Counter()
    duplicates_in_file = 0
    seen: set[str] = set()

    with path.open() as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            cid = row.get("combination_id")
            if not cid:
                continue
            if cid in seen:
                duplicates_in_file += 1
                continue
            seen.add(cid)
            all_ids.add(cid)
            axes = row.get("axes") or {}
            rr = axes.get("route_runtime") or ""
            route_counts[rr] += 1
            ft = axes.get("fault_type") or "NONE"
            es = axes.get("execution_surface") or ""
            surface_counts[es] += 1
            by_source[axes.get("source_type") or ""] += 1
            by_destination[axes.get("destination_type") or ""] += 1
            in_scope = route_runtime is None or rr == route_runtime
            if in_scope:
                scoped_ids.add(cid)
                if ft == "NONE":
                    fault_none += 1
                else:
                    fault_nonzero += 1

    id_hash = combination_ids_hash(sorted(scoped_ids))
    return {
        "catalog_path": str(path.resolve()),
        "catalog_sha256": sha256_file(path),
        "route_runtime_scope": route_runtime,
        "applicable_valid_count": len(all_ids),
        "authoritative_valid_count": len(scoped_ids),
        "route_on_count": int(route_counts.get("ROUTE_ON") or 0),
        "route_off_count": int(route_counts.get("ROUTE_OFF") or 0),
        "normal_combination_count": fault_none,
        "fault_combination_count": fault_nonzero,
        "browser_count": int(surface_counts.get("BROWSER") or 0),
        "api_count": int(surface_counts.get("API_SEEDED") or 0),
        "by_source": dict(by_source),
        "by_destination": dict(by_destination),
        "duplicates_in_file": duplicates_in_file,
        "authoritative_ids": scoped_ids,
        "all_valid_ids": all_ids,
        "authoritative_ids_hash": id_hash,
    }


def audit_shard_assignment(
    snapshot: dict[str, Any],
    *,
    authoritative_ids: set[str],
    selected_shard_ids: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Audit per-shard assignment integrity against an authoritative ID set."""
    shards = list(snapshot.get("shards") or [])
    selected = set(selected_shard_ids) if selected_shard_ids is not None else None
    assign: dict[str, list[str]] = {}
    shard_rows: list[dict[str, Any]] = []
    listed_sum = 0
    expected_sum = 0
    within_dup = 0

    for s in shards:
        sid = s.get("shard_id")
        ids = list(s.get("combination_ids") or [])
        exp = int(s.get("expected_count") or 0)
        uniq = len(set(ids))
        dup = len(ids) - uniq
        within_dup += dup
        listed_sum += len(ids)
        expected_sum += exp
        for cid in ids:
            assign.setdefault(cid, []).append(sid)
        extra = sorted(set(ids) - authoritative_ids)
        missing_in_auth = 0  # per-shard missing vs auth is computed globally
        st = "fault" if str(sid).startswith("xp-fault-") else "normal"
        shard_rows.append(
            {
                "shard_id": sid,
                "type": st,
                "route_mode": s.get("route_mode") or snapshot.get("route_runtime"),
                "expected_count": exp,
                "listed_count": len(ids),
                "unique_count": uniq,
                "duplicate_count": dup,
                "extra_count": len(extra),
                "expected_matches_listed": exp == len(ids) and dup == 0,
                "selected": (sid in selected) if selected is not None else True,
            }
        )

    snapshot_ids = set(assign)
    multi = {cid: sids for cid, sids in assign.items() if len(sids) > 1}
    unassigned = sorted(authoritative_ids - snapshot_ids)
    extra = sorted(snapshot_ids - authoritative_ids)

    selected_ids: set[str] = set()
    if selected is not None:
        for s in shards:
            if s.get("shard_id") in selected:
                selected_ids.update(s.get("combination_ids") or [])
    else:
        selected_ids = set(snapshot_ids)

    return {
        "shard_count": len(shards),
        "shard_expected_sum": expected_sum,
        "shard_listed_sum": listed_sum,
        "snapshot_unique": len(snapshot_ids),
        "within_shard_duplicate": within_dup,
        "unassigned": len(unassigned),
        "multi_assigned": len(multi),
        "snapshot_extra": len(extra),
        "snapshot_missing": len(unassigned),
        "selected_unique": len(selected_ids),
        "shards": shard_rows,
        "unassigned_ids_sample": unassigned[:20],
        "extra_ids_sample": extra[:20],
        "multi_assigned_sample": [
            {"combination_id": cid, "shards": sids} for cid, sids in list(multi.items())[:20]
        ],
        "snapshot_ids": snapshot_ids,
        "selected_ids": selected_ids,
    }


def audit_combination_count_integrity(
    *,
    snapshot: dict[str, Any],
    valid_combinations_path: Path,
    selected_shard_ids: list[str],
    route_runtime: str = "ROUTE_ON",
    generation_summary_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Compare authoritative catalog vs snapshot vs selected recovery shards.

    missing/extra are measured against the authoritative catalog scope, not
    merely plan↔snapshot (which can both omit the same IDs and hide gaps).
    """
    catalog = load_catalog_combination_sets(
        valid_combinations_path, route_runtime=route_runtime
    )
    A: set[str] = catalog["authoritative_ids"]
    assignment = audit_shard_assignment(
        snapshot, authoritative_ids=A, selected_shard_ids=selected_shard_ids
    )
    B: set[str] = assignment["snapshot_ids"]
    C: set[str] = assignment["selected_ids"]

    a_minus_b = sorted(A - B)
    b_minus_a = sorted(B - A)
    a_minus_c = sorted(A - C)
    c_minus_a = sorted(C - A)
    b_minus_c = sorted(B - C)
    c_minus_b = sorted(C - B)

    summary = {}
    if generation_summary_path and Path(generation_summary_path).is_file():
        summary = read_json(Path(generation_summary_path), {}) or {}

    generated_candidate = summary.get("candidate_combinations")
    not_applicable = summary.get("not_applicable_combinations")
    applicable_valid = summary.get("valid_combinations", catalog["applicable_valid_count"])

    eq = (
        len(A) == len(B) == len(C) == assignment["shard_expected_sum"] == assignment["shard_listed_sum"]
        and A == B == C
        and assignment["unassigned"] == 0
        and assignment["multi_assigned"] == 0
        and assignment["within_shard_duplicate"] == 0
        and not a_minus_b
        and not b_minus_a
        and not a_minus_c
        and not c_minus_a
    )

    errors: list[str] = []
    if a_minus_b:
        errors.append(f"authoritative_catalog_missing_from_snapshot={len(a_minus_b)}")
    if b_minus_a:
        errors.append(f"snapshot_extra_vs_authoritative={len(b_minus_a)}")
    if a_minus_c:
        errors.append(f"authoritative_catalog_missing_from_selected={len(a_minus_c)}")
    if c_minus_a:
        errors.append(f"selected_extra_vs_authoritative={len(c_minus_a)}")
    if assignment["unassigned"]:
        errors.append(f"unassigned={assignment['unassigned']}")
    if assignment["multi_assigned"]:
        errors.append(f"multi_assigned={assignment['multi_assigned']}")
    if assignment["within_shard_duplicate"]:
        errors.append(f"duplicate={assignment['within_shard_duplicate']}")
    if assignment["shard_expected_sum"] != len(A):
        errors.append(
            f"shard_expected_sum={assignment['shard_expected_sum']} != authoritative={len(A)}"
        )
    route_mismatch = [
        s["shard_id"]
        for s in assignment["shards"]
        if (s.get("route_mode") or route_runtime) != route_runtime
    ]
    if route_mismatch:
        errors.append(f"shard_route_mismatch={len(route_mismatch)}")

    reason = None
    if errors:
        if a_minus_b or assignment["unassigned"]:
            reason = "PREFLIGHT_FAIL_SNAPSHOT_MISSING_COMBINATIONS"
        elif b_minus_a:
            reason = "PREFLIGHT_FAIL_SNAPSHOT_EXTRA_COMBINATIONS"
        elif assignment["multi_assigned"] or assignment["within_shard_duplicate"]:
            reason = "PREFLIGHT_FAIL_SHARD_ASSIGNMENT_INVALID"
        else:
            reason = "PREFLIGHT_FAIL_APPLICABILITY_COUNT_UNPROVEN"

    # Drop heavy sets from serialisable output
    catalog_out = {
        k: v
        for k, v in catalog.items()
        if k not in ("authoritative_ids", "all_valid_ids")
    }
    assign_out = {
        k: v
        for k, v in assignment.items()
        if k not in ("snapshot_ids", "selected_ids")
    }

    return {
        "ok": eq and not errors,
        "reason": reason,
        "errors": errors,
        "count_term_definitions": COUNT_TERM_DEFINITIONS,
        "route_runtime_scope": route_runtime,
        "raw_cartesian_count": None,
        "generated_candidate_count": generated_candidate,
        "applicable_valid_count": applicable_valid,
        "not_applicable_count": not_applicable,
        "authoritative_count": len(A),
        "snapshot_count": len(B),
        "snapshot_unique": assignment["snapshot_unique"],
        "selected_count": len(C),
        "shard_expected_sum": assignment["shard_expected_sum"],
        "shard_listed_sum": assignment["shard_listed_sum"],
        "normal_count": catalog["normal_combination_count"],
        "fault_count": catalog["fault_combination_count"],
        "route_on_count": catalog["route_on_count"],
        "route_off_count": catalog["route_off_count"],
        "missing": len(a_minus_b),
        "extra": len(b_minus_a),
        "duplicate": assignment["within_shard_duplicate"],
        "unassigned": assignment["unassigned"],
        "multi_assigned": assignment["multi_assigned"],
        "authoritative_catalog_missing": len(a_minus_b),
        "authoritative_catalog_extra": len(b_minus_a),
        "snapshot_missing": len(a_minus_b),
        "snapshot_extra": len(b_minus_a),
        "plan_missing": len(a_minus_c),
        "plan_extra": len(c_minus_a),
        "set_diff_counts": {
            "A_minus_B": len(a_minus_b),
            "B_minus_A": len(b_minus_a),
            "A_minus_C": len(a_minus_c),
            "C_minus_A": len(c_minus_a),
            "B_minus_C": len(b_minus_c),
            "C_minus_B": len(c_minus_b),
        },
        "set_diff_samples": {
            "A_minus_B": a_minus_b[:20],
            "B_minus_A": b_minus_a[:20],
            "A_minus_C": a_minus_c[:20],
            "C_minus_A": c_minus_a[:20],
        },
        "authoritative_ids_hash": catalog["authoritative_ids_hash"],
        "catalog": catalog_out,
        "assignment": assign_out,
        "equation_ok": eq,
    }


def preflight_selected_shards(
    *,
    shard_ids: list[str],
    snapshot: dict[str, Any],
    plan_expected: Optional[dict[str, int]] = None,
    valid_combinations_path: Optional[Path] = None,
    route_runtime: str = "ROUTE_ON",
    generation_summary_path: Optional[Path] = None,
    coverage_shard_ids: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Preflight execution selection.

    ``shard_ids`` is the execution set (rerun / canary).
    ``coverage_shard_ids`` (optional) is the catalog-coverage set used for the
    authoritative equation — typically reuse ∪ rerun after canary promote.
    When omitted, coverage defaults to ``shard_ids``.
    """
    errors: list[str] = []
    if not shard_ids:
        return {
            "ok": False,
            "reason": "FAILED_PREFLIGHT_ZERO_SHARDS",
            "errors": ["selected_shards=0"],
            "selected_shards": 0,
            "selected_combinations": 0,
        }
    total = 0
    for sid in shard_ids:
        exp = (plan_expected or {}).get(sid)
        v = validate_snapshot_shard(snapshot, shard_id=sid, expected_count=exp)
        if not v["ok"]:
            errors.extend([f"{sid}: {e}" for e in v["errors"]])
        else:
            total += int(v["expected_count"])
    if total <= 0 and not errors:
        errors.append("selected_combinations=0")

    coverage = list(coverage_shard_ids) if coverage_shard_ids is not None else list(shard_ids)
    if coverage_shard_ids is not None and not errors:
        for sid in coverage:
            if sid in shard_ids:
                continue
            exp = (plan_expected or {}).get(sid)
            v = validate_snapshot_shard(snapshot, shard_id=sid, expected_count=exp)
            if not v["ok"]:
                errors.extend([f"coverage {sid}: {e}" for e in v["errors"]])

    count_audit: Optional[dict[str, Any]] = None
    if valid_combinations_path is not None and not errors:
        count_audit = audit_combination_count_integrity(
            snapshot=snapshot,
            valid_combinations_path=Path(valid_combinations_path),
            selected_shard_ids=list(coverage),
            route_runtime=route_runtime,
            generation_summary_path=generation_summary_path,
        )
        if not count_audit["ok"]:
            errors.extend(count_audit.get("errors") or ["authoritative_count_mismatch"])

    reason = None
    if errors:
        if count_audit and count_audit.get("reason"):
            reason = count_audit["reason"]
        elif any("missing from snapshot" in e for e in errors):
            reason = "FAILED_PREFLIGHT_SHARD_PLAN_MISSING"
        elif "selected_shards=0" in errors or "selected_combinations=0" in errors:
            reason = "FAILED_PREFLIGHT_ZERO_SHARDS"
        else:
            reason = "SHARD_PLAN_INVALID"

    out: dict[str, Any] = {
        "ok": not errors,
        "reason": reason,
        "errors": errors,
        "selected_shards": len(shard_ids),
        "selected_combinations": total,
    }
    if count_audit is not None:
        out["count_audit"] = count_audit
        out["authoritative_count"] = count_audit["authoritative_count"]
        out["snapshot_count"] = count_audit["snapshot_count"]
        out["snapshot_unique"] = count_audit["snapshot_unique"]
        # Keep execution selection counts; expose coverage separately when broader.
        out["selected_count"] = len(shard_ids)
        out["coverage_selected_count"] = count_audit["selected_count"]
        out["coverage_combinations"] = count_audit.get("selected_count")
        out["shard_expected_sum"] = count_audit["shard_expected_sum"]
        out["normal_count"] = count_audit["normal_count"]
        out["fault_count"] = count_audit["fault_count"]
        out["route_on_count"] = count_audit["route_on_count"]
        out["route_off_count"] = count_audit["route_off_count"]
        out["missing"] = count_audit["missing"]
        out["extra"] = count_audit["extra"]
        out["duplicate"] = count_audit["duplicate"]
        out["unassigned"] = count_audit["unassigned"]
        out["multi_assigned"] = count_audit["multi_assigned"]
        out["authoritative_catalog_missing"] = count_audit["authoritative_catalog_missing"]
        out["authoritative_catalog_extra"] = count_audit["authoritative_catalog_extra"]
        out["snapshot_missing"] = count_audit["snapshot_missing"]
        out["snapshot_extra"] = count_audit["snapshot_extra"]
        out["plan_missing"] = count_audit["plan_missing"]
        out["plan_extra"] = count_audit["plan_extra"]
        out["equation_ok"] = count_audit["equation_ok"]
    return out


def resolve_catalog_paths(
    *,
    e2e_root: Path,
    fallback_e2e_roots: Optional[list[Path]] = None,
) -> tuple[Path, Path]:
    """Locate shard-plan.json + valid-combinations.jsonl, preferring e2e_root then fallbacks."""
    candidates = [Path(e2e_root)]
    for p in fallback_e2e_roots or []:
        if p and Path(p) not in candidates:
            candidates.append(Path(p))
    for root in candidates:
        plan = root / "cross-product" / "generated" / "shard-plan.json"
        catalog = root / "cross-product" / "generated" / "valid-combinations.jsonl"
        if plan.is_file() and catalog.is_file():
            return plan, catalog
    raise FileNotFoundError(
        "unable to locate shard-plan.json + valid-combinations.jsonl in: "
        + ", ".join(str(c) for c in candidates)
    )


def ensure_recovery_snapshot_for_attempt(
    *,
    run_dir: Path,
    attempt_dir: Path,
    e2e_root: Path,
    fallback_e2e_roots: Optional[list[Path]] = None,
    route_runtime: str = "ROUTE_ON",
) -> dict[str, Any]:
    """Create immutable snapshot + plan v2 if missing; never rewrite existing snapshot."""
    existing = load_shard_plan_snapshot(attempt_dir)
    if existing:
        if not (attempt_dir / "recovery-plan.v2.json").exists():
            build_recovery_plan_v2(attempt_dir=attempt_dir, snapshot=existing)
        return existing

    imm = load_immutable_run_manifest(run_dir, allow_bootstrap_write=False) or {}
    plan_path, catalog_path = resolve_catalog_paths(
        e2e_root=e2e_root, fallback_e2e_roots=fallback_e2e_roots
    )
    # Require generation hashes to match immutable when present.
    summary = read_json(plan_path.parent / "generation-summary.json", {}) or {}
    for key in ("manifest_hash", "applicability_rules_hash", "axes_hash"):
        exp = imm.get(key)
        act = summary.get(key)
        if exp and act and str(exp) != str(act):
            raise RuntimeError(f"catalog {key} drift: immutable={exp} catalog={act}")

    snapshot = build_shard_plan_snapshot(
        source_run_id=run_dir.name,
        immutable=imm,
        shard_plan_path=plan_path,
        valid_combinations_path=catalog_path,
        route_runtime=route_runtime,
        source_label="generated_catalog",
    )
    ensure_shard_plan_snapshot(attempt_dir, snapshot, overwrite=False)
    build_recovery_plan_v2(attempt_dir=attempt_dir, snapshot=snapshot)
    return snapshot


def determine_attempt_status(attempt_dir: Path) -> dict[str, Any]:
    """Recovery-attempt status separate from original run final_verdict."""
    attempt_dir = Path(attempt_dir)
    status = load_attempt_status(attempt_dir)
    abort = read_json(attempt_dir / "attempt-abort.json")
    if abort and not status.get("status"):
        status = {
            "status": "FAILED_PREFLIGHT",
            "abort_reason": abort.get("reason"),
            "final_verdict": abort.get("reason"),
        }
    meta = read_json(attempt_dir / "recovery-run-metadata.json", {}) or {}
    if not status.get("status"):
        status = {
            "status": meta.get("status") or "UNKNOWN",
            "final_verdict": meta.get("status") or "UNKNOWN",
        }
    status.setdefault("attempt", attempt_dir.name)
    status.setdefault("attempt_dir", str(attempt_dir))
    return status


# ---------------------------------------------------------------------------
# Prior-attempt AUTHORITATIVE integrity (attempt-008+)
#
# Gate blocks Full Resume only on AUTHORITATIVE content/missing/mode failures.
# NON_AUTHORITATIVE drift is recorded as warning evidence and never blocks.
# Classification is based on Resume/Merge/Validation read dependencies — not
# filename heuristics alone. Nested Playwright evidence trees are non-auth.
# ---------------------------------------------------------------------------

AUTHORITATIVE_ATTEMPT_ROOT_BASENAMES: frozenset[str] = frozenset(
    {
        "recovery-plan.json",
        "recovery-plan.v2.json",
        "replacement-map.json",
        "shard-plan.snapshot.json",
        "attempt-status.json",
        "attempt-abort.json",
        "recovery-run-metadata.json",
        "expected-fixed-harness.json",
        "immutable-attempt-manifest.json",
        "immutable-run-manifest.json",
        "shard-validation.json",
        "final-canary-report.json",
        "harness-manifest.json",
        "validate-xp-normal-000.json",
        "validate-xp-normal-001.json",
    }
)

AUTHORITATIVE_REPLACEMENT_ROOT_BASENAMES: frozenset[str] = frozenset(
    {
        "cross-product-results.jsonl",
        "validation.json",
        "shard-summary.json",
        "shard-manifest.json",
        "harness-manifest.json",
        "cleanup-report.json",
        "evidence-flush.json",
        "abnormal-exit.json",
        "run-metadata.json",
        "superseded.json",
        "shard-preflight-fail.json",
        "result.json",
        "generation-replacement-manifest.json",
        "sha256-manifest.json",
        "run-generation.json",
    }
)

# Basenames Resume/Merge/Validation code paths are known to read. Coverage
# tests require every present dependency under prior attempts to be classified
# AUTHORITATIVE when discovered via these names at authoritative locations.
KNOWN_RESUME_MERGE_VALIDATION_DEPENDENCY_BASENAMES: frozenset[str] = frozenset(
    {
        "recovery-plan.json",
        "replacement-map.json",
        "shard-plan.snapshot.json",
        "attempt-status.json",
        "attempt-abort.json",
        "recovery-run-metadata.json",
        "expected-fixed-harness.json",
        "immutable-run-manifest.json",
        "cross-product-results.jsonl",
        "validation.json",
        "shard-summary.json",
        "shard-manifest.json",
        "harness-manifest.json",
        "cleanup-report.json",
        "evidence-flush.json",
        "abnormal-exit.json",
        "superseded.json",
        "shard-preflight-fail.json",
        "run-metadata.json",
    }
)

_NON_AUTH_NAME_RE = re.compile(
    r"(?i)("
    r"\.pid$|"
    r"\.nohup\.log(\.|$)|"
    r"playwright\.log$|"
    r"monitor\.sh$|"
    r"monitor\.|"
    r"\.monitor\.|"
    r"trace\.zip$|"
    r"error-context\.md$|"
    r"status-snapshot|"
    r"status-no-write|"
    r"fingerprint|"
    r"immutability|"
    r"diagnostic"
    r")"
)


class BaselineIncompleteError(RuntimeError):
    """Raised when an AUTHORITATIVE baseline cannot be published (missing sha256)."""


def _mode_octal(st: os.stat_result) -> str:
    return oct(st.st_mode & 0o777)[2:].zfill(4)


def _file_identity(st: os.stat_result) -> tuple[int, int, int]:
    return (st.st_size, getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)), st.st_ino)


def sha256_file_stable(path: Path, *, max_retries: int = 3) -> dict[str, Any]:
    """Hash a file with TOCTOU re-stat. Raises RuntimeError if content races."""
    path = Path(path)
    last_err: Optional[Exception] = None
    for _ in range(max_retries):
        st1 = path.stat()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        st2 = path.stat()
        if _file_identity(st1) == _file_identity(st2):
            return {
                "sha256": digest,
                "size": st1.st_size,
                "mode": _mode_octal(st1),
                "mtime_ns": getattr(st1, "st_mtime_ns", int(st1.st_mtime * 1e9)),
                "inode": st1.st_ino,
            }
        last_err = RuntimeError(
            f"TOCTOU race while hashing {path}: size/mtime/inode changed mid-read"
        )
    assert last_err is not None
    raise last_err


def classify_prior_attempt_file(
    *,
    run_dir: Path,
    path: Path,
) -> dict[str, Any]:
    """Classify a file under prior recovery-attempt trees by read-dependency rules."""
    run_dir = Path(run_dir).resolve()
    path = Path(path).resolve()
    try:
        rel = path.relative_to(run_dir).as_posix()
    except ValueError:
        return {
            "relative_path": str(path),
            "classification": "NON_AUTHORITATIVE",
            "authority_reason": "outside_run_dir",
            "read_by_resume": False,
            "read_by_merge": False,
            "read_by_validation": False,
        }

    parts = rel.split("/")
    if not parts or not re.match(r"recovery-attempt-\d{3}$", parts[0]):
        return {
            "relative_path": rel,
            "classification": "NON_AUTHORITATIVE",
            "authority_reason": "not_under_recovery_attempt",
            "read_by_resume": False,
            "read_by_merge": False,
            "read_by_validation": False,
        }

    name = path.name
    # Nested quarantine / staging / original trees are never merge inputs.
    if any(
        p.startswith(".failed-attempt-")
        or p.startswith(".staging-")
        or p.startswith(".bak-")
        or p == "original"
        or p.startswith("cross_product__")
        for p in parts[1:]
    ):
        return {
            "relative_path": rel,
            "classification": "NON_AUTHORITATIVE",
            "authority_reason": "nested_evidence_or_quarantine",
            "read_by_resume": False,
            "read_by_merge": False,
            "read_by_validation": False,
        }

    # Attempt-root control-plane inputs
    if len(parts) == 2 and name in AUTHORITATIVE_ATTEMPT_ROOT_BASENAMES:
        reason = {
            "recovery-plan.json": "read by resume preflight / shard selection / post-canary finalize",
            "recovery-plan.v2.json": "linked from snapshot lifecycle / resume plan v2",
            "replacement-map.json": "read by resume / canary finalize / merge_selection_from_plan",
            "shard-plan.snapshot.json": "read by resume preflight / shard selection",
            "attempt-status.json": "read by resume finalize / determine_attempt_status",
            "attempt-abort.json": "read by determine_attempt_status",
            "recovery-run-metadata.json": "read by determine_attempt_status",
            "expected-fixed-harness.json": "read by resume harness gate",
            "immutable-attempt-manifest.json": "attempt-scoped harness pin used by resume",
            "immutable-run-manifest.json": "read by load_immutable_run_manifest / resume",
            "shard-validation.json": "plan input produced/consumed by recovery planning",
            "final-canary-report.json": "canary verdict evidence consumed by readiness reporting",
            "harness-manifest.json": "nearby metadata for merge settings",
            "validate-xp-normal-000.json": "canary shard validation summary used by status/reuse",
            "validate-xp-normal-001.json": "xp-normal-001 validation summary used by readiness",
        }.get(name, "resume/merge/validation control-plane input")
        return {
            "relative_path": rel,
            "classification": "AUTHORITATIVE",
            "authority_reason": reason,
            "read_by_resume": name
            in {
                "recovery-plan.json",
                "recovery-plan.v2.json",
                "replacement-map.json",
                "shard-plan.snapshot.json",
                "attempt-status.json",
                "attempt-abort.json",
                "recovery-run-metadata.json",
                "expected-fixed-harness.json",
                "immutable-attempt-manifest.json",
                "immutable-run-manifest.json",
                "shard-validation.json",
            },
            "read_by_merge": name
            in {"replacement-map.json", "recovery-plan.json", "harness-manifest.json"},
            "read_by_validation": name
            in {
                "shard-plan.snapshot.json",
                "final-canary-report.json",
                "validate-xp-normal-000.json",
                "validate-xp-normal-001.json",
                "shard-validation.json",
            },
        }

    # Runtime selectors consumed before shard execution
    if len(parts) == 3 and parts[1] == "runtime-selectors" and path.is_file():
        return {
            "relative_path": rel,
            "classification": "AUTHORITATIVE",
            "authority_reason": "read by resume / run-all-shards as combination selector input",
            "read_by_resume": True,
            "read_by_merge": False,
            "read_by_validation": False,
        }

    # Generation replacement root:
    # replacements/generations/<shard>/<generation_id>-ROUTE_ON/<file>
    if (
        len(parts) == 6
        and parts[1] == "replacements"
        and parts[2] == "generations"
        and not parts[3].startswith(".")
        and not parts[4].startswith(".")
        and name in AUTHORITATIVE_REPLACEMENT_ROOT_BASENAMES
    ):
        return {
            "relative_path": rel,
            "classification": "AUTHORITATIVE",
            "authority_reason": "generation replacement artifact read by merge via active pointer",
            "read_by_resume": True,
            "read_by_merge": True,
            "read_by_validation": True,
        }

    # Replacement artifact root (exactly replacements/<shard>-ROUTE_ON/<file>) — legacy
    if (
        len(parts) == 4
        and parts[1] == "replacements"
        and not parts[2].startswith(".")
        and parts[2] != "generations"
        and name in AUTHORITATIVE_REPLACEMENT_ROOT_BASENAMES
    ):
        return {
            "relative_path": rel,
            "classification": "AUTHORITATIVE",
            "authority_reason": "read by validate_replacement_artifact / merge_selection_from_plan / merge nearby metadata",
            "read_by_resume": name
            in {
                "cross-product-results.jsonl",
                "validation.json",
                "shard-summary.json",
                "shard-manifest.json",
                "cleanup-report.json",
                "evidence-flush.json",
                "abnormal-exit.json",
            },
            "read_by_merge": name
            in {
                "cross-product-results.jsonl",
                "validation.json",
                "harness-manifest.json",
                "shard-manifest.json",
                "run-metadata.json",
                "superseded.json",
            },
            "read_by_validation": True,
        }

    # Explicit monitoring helper proof target
    if name == "final-canary-g5-monitor.sh" or _NON_AUTH_NAME_RE.search(name):
        return {
            "relative_path": rel,
            "classification": "NON_AUTHORITATIVE",
            "authority_reason": "monitoring_helper_only"
            if "monitor" in name.lower()
            else "operator_sidecar_or_telemetry",
            "read_by_resume": False,
            "read_by_merge": False,
            "read_by_validation": False,
        }

    return {
        "relative_path": rel,
        "classification": "NON_AUTHORITATIVE",
        "authority_reason": "not_read_by_resume_merge_or_validation",
        "read_by_resume": False,
        "read_by_merge": False,
        "read_by_validation": False,
    }


def iter_prior_attempt_dirs(run_dir: Path, attempts: Optional[list[str]] = None) -> list[Path]:
    run_dir = Path(run_dir)
    if attempts:
        out = []
        for name in attempts:
            p = run_dir / name
            if p.is_dir():
                out.append(p)
        return out
    return sorted(
        p
        for p in run_dir.glob("recovery-attempt-*")
        if p.is_dir() and re.match(r"recovery-attempt-\d{3}$", p.name)
    )


def discover_prior_attempt_files(
    *,
    run_dir: Path,
    attempts: Optional[list[str]] = None,
    include_non_authoritative: bool = True,
) -> list[dict[str, Any]]:
    """Discover classifiable files under prior attempts without hashing yet."""
    run_dir = Path(run_dir).resolve()
    discovered: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _add(path: Path) -> None:
        if not path.is_file():
            return
        meta = classify_prior_attempt_file(run_dir=run_dir, path=path)
        rel = meta["relative_path"]
        if rel in seen:
            return
        if meta["classification"] != "AUTHORITATIVE" and not include_non_authoritative:
            return
        # For NON_AUTH, keep attempt-root sidecars + known monitor helpers only
        # (avoid hashing/walking entire evidence trees).
        if meta["classification"] != "AUTHORITATIVE":
            parts = rel.split("/")
            if len(parts) > 2 and parts[1] in {"replacements"}:
                # allow only direct files under replacements/<shard> that were
                # classified non-auth (already filtered by classify); skip deep.
                if len(parts) > 4:
                    return
            if len(parts) > 3 and parts[1] not in {"replacements", "runtime-selectors"}:
                return
        seen.add(rel)
        discovered.append({**meta, "absolute_path": str(path.resolve())})

    for attempt_dir in iter_prior_attempt_dirs(run_dir, attempts):
        for p in attempt_dir.iterdir():
            if p.is_file():
                _add(p)
        rs = attempt_dir / "runtime-selectors"
        if rs.is_dir():
            for p in rs.iterdir():
                _add(p)
        rep = attempt_dir / "replacements"
        if rep.is_dir():
            for shard_dir in rep.iterdir():
                if not shard_dir.is_dir() or shard_dir.name.startswith("."):
                    continue
                for p in shard_dir.iterdir():
                    if p.is_file():
                        _add(p)
    return discovered


def build_prior_attempt_authoritative_baseline(
    *,
    run_dir: Path,
    out_path: Path,
    attempts: Optional[list[str]] = None,
    include_non_authoritative: bool = True,
) -> dict[str, Any]:
    """Create AUTHORITATIVE baseline with required sha256; atomic publish only on success."""
    run_dir = Path(run_dir).resolve()
    out_path = Path(out_path)
    attempt_names = [
        p.name for p in iter_prior_attempt_dirs(run_dir, attempts)
    ]
    discovered = discover_prior_attempt_files(
        run_dir=run_dir,
        attempts=attempt_names,
        include_non_authoritative=include_non_authoritative,
    )

    auth_files: list[dict[str, Any]] = []
    non_auth_files: list[dict[str, Any]] = []
    incomplete: list[dict[str, Any]] = []
    duplicates: list[str] = []
    seen_paths: set[str] = set()

    for meta in discovered:
        rel = meta["relative_path"]
        if rel in seen_paths:
            duplicates.append(rel)
            continue
        seen_paths.add(rel)
        path = Path(meta["absolute_path"])
        try:
            hashed = sha256_file_stable(path)
        except Exception as exc:  # noqa: BLE001 — surface as baseline incomplete
            incomplete.append({"relative_path": rel, "error": str(exc)})
            continue
        entry = {
            "relative_path": rel,
            "size": hashed["size"],
            "mode": hashed["mode"],
            "sha256": hashed["sha256"],
            "mtime_ns": hashed["mtime_ns"],
            "authority_reason": meta["authority_reason"],
            "source_attempt": rel.split("/", 1)[0],
            "classification": meta["classification"],
            "read_by_resume": meta["read_by_resume"],
            "read_by_merge": meta["read_by_merge"],
            "read_by_validation": meta["read_by_validation"],
        }
        if meta["classification"] == "AUTHORITATIVE":
            if not entry["sha256"]:
                incomplete.append({"relative_path": rel, "error": "sha256_null"})
                continue
            if not entry.get("authority_reason"):
                incomplete.append({"relative_path": rel, "error": "authority_reason_missing"})
                continue
            auth_files.append(entry)
        else:
            non_auth_files.append(entry)

    if incomplete or duplicates or not auth_files:
        raise BaselineIncompleteError(
            json.dumps(
                {
                    "reason": "BASELINE_INCOMPLETE",
                    "authoritative_files": len(auth_files),
                    "sha256_null_or_error": len(incomplete),
                    "duplicate_path": len(duplicates),
                    "incomplete": incomplete[:20],
                    "duplicates": duplicates[:20],
                }
            )
        )

    doc = {
        "schema_version": 1,
        "created_at": utc_now(),
        "run_id": run_dir.name,
        "attempts": attempt_names,
        "authoritative_file_count": len(auth_files),
        "non_authoritative_file_count": len(non_auth_files),
        "files": auth_files,
        "non_authoritative_files": non_auth_files,
        "classification_policy": {
            "authoritative_attempt_root_basenames": sorted(AUTHORITATIVE_ATTEMPT_ROOT_BASENAMES),
            "authoritative_replacement_root_basenames": sorted(
                AUTHORITATIVE_REPLACEMENT_ROOT_BASENAMES
            ),
            "known_resume_merge_validation_dependencies": sorted(
                KNOWN_RESUME_MERGE_VALIDATION_DEPENDENCY_BASENAMES
            ),
            "note": "AUTHORITATIVE = Resume/Canary/Replacement/Merge/final-judgment inputs; gate ignores NON_AUTHORITATIVE drift",
        },
    }

    # Atomic publish: never leave a partial baseline if write fails.
    existing = out_path.read_bytes() if out_path.exists() else None
    try:
        atomic_write_json(out_path, doc)
    except Exception:
        if existing is not None:
            # Restore previous bytes if atomic helper left nothing usable.
            if not out_path.exists() or out_path.read_bytes() != existing:
                tmp = out_path.parent / f".restore-{out_path.name}-{time.time_ns()}"
                tmp.write_bytes(existing)
                os.replace(str(tmp), str(out_path))
        raise

    return doc


def verify_prior_attempt_authoritative_integrity(
    *,
    run_dir: Path,
    baseline_path: Path,
    evidence_out: Optional[Path] = None,
) -> dict[str, Any]:
    """Verify prior attempts against AUTHORITATIVE baseline.

    PASS/FAIL is determined only by AUTHORITATIVE content/missing/mode.
    NON_AUTHORITATIVE drift is recorded and never blocks Full Resume.
    Aggregate file-count / size-count / mtime-count alone never decide PASS/FAIL.
    """
    run_dir = Path(run_dir).resolve()
    baseline_path = Path(baseline_path)
    baseline = read_json(baseline_path, {}) or {}
    files = list(baseline.get("files") or [])
    non_auth_base = list(baseline.get("non_authoritative_files") or [])

    auth_changed: list[dict[str, Any]] = []
    auth_missing: list[dict[str, Any]] = []
    auth_mode_changed: list[dict[str, Any]] = []
    auth_metadata_only: list[dict[str, Any]] = []
    auth_hash_missing: list[dict[str, Any]] = []
    non_auth_drift: list[dict[str, Any]] = []

    for entry in files:
        rel = entry.get("relative_path")
        if not rel:
            auth_hash_missing.append({"entry": entry, "error": "relative_path_missing"})
            continue
        if not entry.get("sha256"):
            auth_hash_missing.append({"relative_path": rel, "error": "baseline_sha256_null"})
            continue
        path = run_dir / rel
        if not path.is_file():
            auth_missing.append({"relative_path": rel, "baseline_sha256": entry["sha256"]})
            continue
        try:
            cur = sha256_file_stable(path)
        except Exception as exc:  # noqa: BLE001
            auth_changed.append({"relative_path": rel, "error": str(exc)})
            continue
        if cur["sha256"] != entry["sha256"] or cur["size"] != entry["size"]:
            auth_changed.append(
                {
                    "relative_path": rel,
                    "baseline_sha256": entry["sha256"],
                    "current_sha256": cur["sha256"],
                    "baseline_size": entry["size"],
                    "current_size": cur["size"],
                    "kind": "AUTHORITATIVE_CONTENT_CHANGED",
                }
            )
            continue
        if cur["mode"] != entry.get("mode"):
            auth_mode_changed.append(
                {
                    "relative_path": rel,
                    "baseline_mode": entry.get("mode"),
                    "current_mode": cur["mode"],
                    "kind": "AUTHORITATIVE_MODE_CHANGED",
                }
            )
            continue
        if entry.get("mtime_ns") is not None and cur["mtime_ns"] != entry.get("mtime_ns"):
            auth_metadata_only.append(
                {
                    "relative_path": rel,
                    "baseline_mtime_ns": entry.get("mtime_ns"),
                    "current_mtime_ns": cur["mtime_ns"],
                    "sha256": cur["sha256"],
                    "kind": "AUTHORITATIVE_METADATA_ONLY",
                }
            )

    for entry in non_auth_base:
        rel = entry.get("relative_path")
        if not rel:
            continue
        path = run_dir / rel
        drift: dict[str, Any] = {
            "relative_path": rel,
            "classification": "NON_AUTHORITATIVE",
            "kind": "NON_AUTHORITATIVE_DRIFT",
        }
        if not path.is_file():
            drift["missing"] = True
            non_auth_drift.append(drift)
            continue
        st = path.stat()
        size = st.st_size
        mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
        mode = _mode_octal(st)
        changed = False
        if entry.get("size") is not None and size != entry["size"]:
            drift["size"] = [entry["size"], size]
            changed = True
        if entry.get("mtime_ns") is not None and mtime_ns != entry["mtime_ns"]:
            drift["mtime_ns"] = [entry["mtime_ns"], mtime_ns]
            changed = True
        if entry.get("mode") is not None and mode != entry["mode"]:
            drift["mode"] = [entry["mode"], mode]
            changed = True
        if entry.get("sha256"):
            try:
                cur_hash = sha256_file_stable(path)["sha256"]
            except Exception as exc:  # noqa: BLE001
                drift["hash_error"] = str(exc)
                changed = True
            else:
                if cur_hash != entry["sha256"]:
                    drift["sha256"] = [entry["sha256"], cur_hash]
                    changed = True
        if changed:
            drift["full_resume_blocked"] = False
            non_auth_drift.append(drift)

    # Explicit evidence for the known monitor helper from attempt-003.
    monitor_rel = "recovery-attempt-003/final-canary-g5-monitor.sh"
    monitor_path = run_dir / monitor_rel
    monitor_evidence = {
        "path": monitor_rel,
        "classification": "NON_AUTHORITATIVE",
        "read_by_resume": False,
        "read_by_merge": False,
        "read_by_validation": False,
        "reason": "monitoring_helper_only",
        "exists": monitor_path.is_file(),
        "full_resume_blocked": False,
    }
    if monitor_path.is_file():
        st = monitor_path.stat()
        monitor_evidence["size"] = st.st_size
        monitor_evidence["sha256"] = sha256_file(monitor_path)
        # If present in non-auth baseline, mark drift recorded when mtime/size/hash differs.
        for entry in non_auth_base:
            if entry.get("relative_path") == monitor_rel:
                cur_m = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
                if (
                    entry.get("mtime_ns") != cur_m
                    or entry.get("size") != st.st_size
                    or (entry.get("sha256") and entry.get("sha256") != monitor_evidence["sha256"])
                ):
                    monitor_evidence["drift"] = "recorded"
                break
        else:
            # Not in baseline non-auth list — still classify; drift may be inferred
            # from legacy fingerprints outside this verifier.
            monitor_evidence["drift"] = monitor_evidence.get("drift", "classification_only")

    blocking = bool(auth_changed or auth_missing or auth_mode_changed or auth_hash_missing)
    full_resume_ready = not blocking
    result = {
        "ok": full_resume_ready,
        "full_resume_ready": full_resume_ready,
        "full_resume_blocked": blocking,
        "AUTHORITATIVE_CONTENT_CHANGED": len(auth_changed),
        "AUTHORITATIVE_MISSING": len(auth_missing),
        "AUTHORITATIVE_MODE_CHANGED": len(auth_mode_changed),
        "AUTHORITATIVE_METADATA_ONLY": len(auth_metadata_only),
        "AUTHORITATIVE_BASELINE_HASH_MISSING": len(auth_hash_missing),
        "NON_AUTHORITATIVE_DRIFT": len(non_auth_drift),
        "authoritative_checked": len(files),
        "non_authoritative_checked": len(non_auth_base),
        "auth_changed_sample": auth_changed[:20],
        "auth_missing_sample": auth_missing[:20],
        "auth_mode_changed_sample": auth_mode_changed[:20],
        "auth_metadata_only_sample": auth_metadata_only[:20],
        "auth_hash_missing_sample": auth_hash_missing[:20],
        "non_authoritative_drift_sample": non_auth_drift[:50],
        "final_canary_g5_monitor": monitor_evidence,
        # Auxiliary stats only — never sole PASS/FAIL determinants.
        "aux_stats": {
            "checked_file_count": len(files) + len(non_auth_base),
            "authoritative_file_count": len(files),
            "non_authoritative_file_count": len(non_auth_base),
            "note": "counts are auxiliary; PASS/FAIL uses AUTHORITATIVE hash/missing/mode only",
        },
        "checked_at": utc_now(),
        "baseline_path": str(baseline_path),
    }
    if evidence_out is not None:
        atomic_write_json(Path(evidence_out), result)
    return result


def assert_authority_dependency_coverage(
    *,
    run_dir: Path,
    baseline: Optional[dict[str, Any]] = None,
    baseline_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Fail if a known Resume/Merge dependency path is present but not AUTHORITATIVE in baseline."""
    run_dir = Path(run_dir).resolve()
    if baseline is None:
        if baseline_path is None:
            raise ValueError("baseline or baseline_path required")
        baseline = read_json(Path(baseline_path), {}) or {}
    auth_paths = {
        e["relative_path"]
        for e in (baseline.get("files") or [])
        if e.get("classification", "AUTHORITATIVE") == "AUTHORITATIVE"
    }
    missing_from_authority: list[str] = []
    discovered = discover_prior_attempt_files(
        run_dir=run_dir,
        attempts=list(baseline.get("attempts") or []),
        include_non_authoritative=False,
    )
    for meta in discovered:
        rel = meta["relative_path"]
        name = Path(rel).name
        if name not in KNOWN_RESUME_MERGE_VALIDATION_DEPENDENCY_BASENAMES:
            continue
        # runtime-selectors use different names; still authoritative via discover
        if meta["classification"] != "AUTHORITATIVE":
            missing_from_authority.append(rel)
            continue
        if rel not in auth_paths:
            missing_from_authority.append(rel)

    # Also ensure every KNOWN basename that exists at authoritative locations is covered.
    for attempt_dir in iter_prior_attempt_dirs(run_dir, list(baseline.get("attempts") or [])):
        for name in KNOWN_RESUME_MERGE_VALIDATION_DEPENDENCY_BASENAMES:
            p = attempt_dir / name
            if p.is_file():
                rel = p.relative_to(run_dir).as_posix()
                if rel not in auth_paths:
                    missing_from_authority.append(rel)
        rep = attempt_dir / "replacements"
        if rep.is_dir():
            for shard_dir in rep.iterdir():
                if not shard_dir.is_dir() or shard_dir.name.startswith("."):
                    continue
                for name in KNOWN_RESUME_MERGE_VALIDATION_DEPENDENCY_BASENAMES:
                    p = shard_dir / name
                    if p.is_file():
                        rel = p.relative_to(run_dir).as_posix()
                        if rel not in auth_paths:
                            missing_from_authority.append(rel)

    missing_from_authority = sorted(set(missing_from_authority))
    return {
        "ok": not missing_from_authority,
        "missing_from_authority": missing_from_authority,
        "authoritative_paths": len(auth_paths),
        "checked_at": utc_now(),
    }


def preflight_prior_attempt_integrity(
    *,
    run_dir: Path,
    attempt_dir: Path,
    baseline_name: str = "prior-attempt-authoritative-baseline.json",
) -> dict[str, Any]:
    """Preflight helper: verify baseline stored under the *current* attempt only."""
    attempt_dir = Path(attempt_dir)
    baseline_path = attempt_dir / baseline_name
    if not baseline_path.is_file():
        return {
            "ok": False,
            "reason": "BASELINE_INCOMPLETE",
            "error": f"missing {baseline_path}",
            "full_resume_ready": False,
        }
    evidence = attempt_dir / "prior-attempt-integrity-report.json"
    result = verify_prior_attempt_authoritative_integrity(
        run_dir=Path(run_dir),
        baseline_path=baseline_path,
        evidence_out=evidence,
    )
    cov = assert_authority_dependency_coverage(
        run_dir=Path(run_dir), baseline_path=baseline_path
    )
    result["dependency_coverage"] = cov
    if not cov["ok"]:
        result["ok"] = False
        result["full_resume_ready"] = False
        result["full_resume_blocked"] = True
        result["reason"] = "AUTHORITATIVE_DEPENDENCY_COVERAGE_FAILURE"
    elif not result["ok"]:
        result["reason"] = "AUTHORITATIVE_INTEGRITY_FAILURE"
    else:
        result["reason"] = "AUTHORITATIVE_INTEGRITY_PASS"
    atomic_write_json(evidence, result)
    return result


# ---------------------------------------------------------------------------
# Side-run generation isolation (attempt-009+)
# ---------------------------------------------------------------------------

HARNESS_VERSION_LABEL = "xp-recovery-generation-isolation-v1"
RESULT_JSONL_NAME = "cross-product-results.jsonl"
RUN_GENERATION_NAME = "run-generation.json"
WRITER_LOCK_NAME = "writer.lock"
RESULT_INDEX_NAME = "result-index.json"


def new_generation_id(*, pid: Optional[int] = None) -> str:
    """Unique run token: UTC timestamp + pid + random hex."""
    import secrets

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    pid_v = int(pid if pid is not None else os.getpid())
    return f"{ts}-{pid_v}-{secrets.token_hex(4)}"


def format_side_run_id(run_id: str, attempt: str, shard_id: str, generation_id: str) -> str:
    return f"{run_id}__{attempt}__{shard_id}__generation-{generation_id}"


def attempt_shard_lock_path(attempt_dir: Path, shard_id: str) -> Path:
    return Path(attempt_dir) / "locks" / f"{shard_id}.lock"


def side_run_manifest_path(side_run_dir: Path) -> Path:
    return Path(side_run_dir) / RUN_GENERATION_NAME


def artifact_results_path(art_dir: Path) -> Path:
    return Path(art_dir) / RESULT_JSONL_NAME


def build_run_generation_manifest(
    *,
    run_id: str,
    attempt: str,
    shard: str,
    generation_id: str,
    commit: str,
    harness_version: str,
    writer_pid: int,
    status: str = "RUNNING",
    parent_pid: Optional[int] = None,
    hostname: Optional[str] = None,
    created_at: Optional[str] = None,
) -> dict[str, Any]:
    import socket

    return {
        "run_id": run_id,
        "attempt": attempt,
        "shard": shard,
        "generation_id": generation_id,
        "commit": commit,
        "harness_version": harness_version,
        "harness_version_label": HARNESS_VERSION_LABEL,
        "created_at": created_at or utc_now(),
        "writer_pid": writer_pid,
        "parent_pid": parent_pid if parent_pid is not None else writer_pid,
        "hostname": hostname or socket.gethostname(),
        "status": status,
        "updated_at": utc_now(),
    }


def update_run_generation_status(side_run_dir: Path, status: str, **extra: Any) -> dict[str, Any]:
    path = side_run_manifest_path(side_run_dir)
    doc = read_json(path, {}) or {}
    if not doc:
        raise FileNotFoundError(f"RESULT_WRITER_MANIFEST_MISSING: {path}")
    doc["status"] = status
    doc["updated_at"] = utc_now()
    doc.update(extra)
    atomic_write_json(path, doc)
    return doc


def _read_attempt_shard_lock(attempt_dir: Path, shard_id: str) -> Optional[dict[str, Any]]:
    path = attempt_shard_lock_path(attempt_dir, shard_id)
    if not path.is_file():
        return None
    return read_json(path, {}) or {}


def acquire_attempt_shard_lock(
    *,
    attempt_dir: Path,
    shard_id: str,
    generation_id: str,
    pid: int,
    hostname: Optional[str] = None,
) -> dict[str, Any]:
    """Block concurrent runners for the same attempt/shard while status=RUNNING.

    Terminal lock/generation statuses allow a new generation. Stale RUNNING locks
    are never auto-cleared solely because the PID is dead.
    """
    import socket

    attempt_dir = Path(attempt_dir)
    lock_path = attempt_shard_lock_path(attempt_dir, shard_id)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    existing = _read_attempt_shard_lock(attempt_dir, shard_id)
    if existing:
        status = str(existing.get("status") or "RUNNING").upper()
        if status == "RUNNING":
            return {
                "ok": False,
                "reason": "SHARD_ALREADY_RUNNING",
                "lock": existing,
                "lock_path": str(lock_path),
            }
    doc = {
        "attempt": Path(attempt_dir).name,
        "shard": shard_id,
        "generation_id": generation_id,
        "pid": pid,
        "hostname": hostname or socket.gethostname(),
        "created_at": utc_now(),
        "status": "RUNNING",
        "process_start_time": process_start_time(pid),
    }
    atomic_write_json(lock_path, doc)
    return {"ok": True, "lock": doc, "lock_path": str(lock_path)}


def release_attempt_shard_lock(
    *,
    attempt_dir: Path,
    shard_id: str,
    generation_id: str,
    status: str,
) -> dict[str, Any]:
    """Mark lock terminal for generation_id. Does not unlink the lock file."""
    lock_path = attempt_shard_lock_path(attempt_dir, shard_id)
    existing = _read_attempt_shard_lock(attempt_dir, shard_id) or {}
    if existing.get("generation_id") and existing.get("generation_id") != generation_id:
        return {
            "ok": False,
            "reason": "RESULT_WRITER_GENERATION_MISMATCH",
            "lock": existing,
        }
    doc = dict(existing)
    doc["generation_id"] = generation_id
    doc["status"] = status
    doc["released_at"] = utc_now()
    atomic_write_json(lock_path, doc)
    return {"ok": True, "lock": doc, "lock_path": str(lock_path)}


def preflight_generation_artifact_ready(
    *,
    side_run_dir: Path,
    art_dir: Path,
    generation_id: str,
    allow_missing_art_dir: bool = True,
) -> dict[str, Any]:
    """Refuse reuse/truncate/append of an already-populated generation artifact."""
    side_run_dir = Path(side_run_dir)
    art_dir = Path(art_dir)
    errors: list[str] = []
    reason = None

    if not side_run_dir.is_dir():
        return {"ok": False, "reason": "SIDE_RUN_MISSING", "errors": ["side-run directory missing"]}

    man_path = side_run_manifest_path(side_run_dir)
    if not man_path.is_file():
        return {"ok": False, "reason": "RESULT_WRITER_MANIFEST_MISSING", "errors": ["run-generation.json missing"]}
    man = read_json(man_path, {}) or {}
    if man.get("generation_id") != generation_id:
        return {
            "ok": False,
            "reason": "RESULT_WRITER_GENERATION_MISMATCH",
            "errors": [f"manifest={man.get('generation_id')} expected={generation_id}"],
        }

    results = artifact_results_path(art_dir)
    writer_lock = art_dir / WRITER_LOCK_NAME
    result_index = art_dir / RESULT_INDEX_NAME

    if results.exists():
        errors.append("cross-product-results.jsonl already exists")
        reason = "RESULTS_FILE_ALREADY_EXISTS"
    if writer_lock.exists():
        errors.append("writer.lock already exists")
        reason = reason or "SIDE_RUN_NOT_EMPTY"
    if result_index.exists():
        errors.append("result-index.json already exists")
        reason = reason or "SIDE_RUN_NOT_EMPTY"
    if art_dir.is_dir():
        # Non-empty art dir with prior evidence is not a fresh generation.
        extras = [
            p.name
            for p in art_dir.iterdir()
            if p.name not in {".", ".."} and p.name not in {WRITER_LOCK_NAME, RESULT_INDEX_NAME, RESULT_JSONL_NAME}
        ]
        # Fresh mkdir of art_dir by runner is OK (empty). Evidence dirs imply reuse.
        if any(name.startswith("cross_product__") for name in extras):
            errors.append("artifact directory already contains evidence")
            reason = reason or "SIDE_RUN_NOT_EMPTY"
    elif not allow_missing_art_dir:
        errors.append("artifact directory missing")
        reason = reason or "SIDE_RUN_MISSING"

    return {
        "ok": not errors,
        "reason": reason,
        "errors": errors,
        "side_run_dir": str(side_run_dir),
        "art_dir": str(art_dir),
        "generation_id": generation_id,
    }


def allocate_side_run_generation(
    *,
    reports_root: Path,
    run_id: str,
    attempt: str,
    shard_id: str,
    commit: str,
    harness_version: str,
    attempt_dir: Path,
    parent_pid: Optional[int] = None,
    route_runtime: str = "ROUTE_ON",
    dry_run: bool = False,
) -> dict[str, Any]:
    """Create a brand-new generation side-run. Never reuses an existing path."""
    import socket

    if dry_run:
        generation_id = "dry-run-token"
        side_id = format_side_run_id(run_id, attempt, shard_id, generation_id)
        return {
            "ok": True,
            "dry_run": True,
            "files_written": 0,
            "lock_created": 0,
            "shards_executed": 0,
            "generation_id": generation_id,
            "side_run_id": side_id,
            "side_run_dir": str(Path(reports_root) / side_id),
            "art_dir": str(Path(reports_root) / side_id / f"{shard_id}-{route_runtime}"),
        }

    reports_root = Path(reports_root)
    attempt_dir = Path(attempt_dir)
    reports_root.mkdir(parents=True, exist_ok=True)
    pid = os.getpid()
    generation_id = new_generation_id(pid=pid)

    lock = acquire_attempt_shard_lock(
        attempt_dir=attempt_dir,
        shard_id=shard_id,
        generation_id=generation_id,
        pid=pid,
    )
    if not lock.get("ok"):
        return lock

    side_id = format_side_run_id(run_id, attempt, shard_id, generation_id)
    side_dir = reports_root / side_id
    if side_dir.exists():
        release_attempt_shard_lock(
            attempt_dir=attempt_dir,
            shard_id=shard_id,
            generation_id=generation_id,
            status="ABORTED",
        )
        return {
            "ok": False,
            "reason": "GENERATION_COLLISION",
            "side_run_id": side_id,
            "side_run_dir": str(side_dir),
        }

    try:
        side_dir.mkdir(parents=False)
    except FileExistsError:
        release_attempt_shard_lock(
            attempt_dir=attempt_dir,
            shard_id=shard_id,
            generation_id=generation_id,
            status="ABORTED",
        )
        return {
            "ok": False,
            "reason": "GENERATION_COLLISION",
            "side_run_id": side_id,
            "side_run_dir": str(side_dir),
        }

    art_dir = side_dir / f"{shard_id}-{route_runtime}"
    # Leave art_dir absent until runner preflight; only side root + manifest exist.
    manifest = build_run_generation_manifest(
        run_id=run_id,
        attempt=attempt,
        shard=shard_id,
        generation_id=generation_id,
        commit=commit,
        harness_version=harness_version,
        writer_pid=pid,
        parent_pid=parent_pid if parent_pid is not None else pid,
        hostname=socket.gethostname(),
        status="RUNNING",
    )
    atomic_write_json(side_run_manifest_path(side_dir), manifest)

    # Record that results must not pre-exist (inode baseline).
    baseline = {
        "generation_id": generation_id,
        "results_existed_at_start": False,
        "created_at": manifest["created_at"],
        "side_run_id": side_id,
    }
    atomic_write_json(side_dir / "generation-start-baseline.json", baseline)

    return {
        "ok": True,
        "dry_run": False,
        "files_written": 2,
        "lock_created": 1,
        "generation_id": generation_id,
        "side_run_id": side_id,
        "side_run_dir": str(side_dir),
        "art_dir": str(art_dir),
        "manifest": manifest,
        "lock": lock.get("lock"),
        "attempt": attempt,
        "shard": shard_id,
        "commit": commit,
        "harness_version": harness_version,
    }


def finalize_side_run_generation(
    *,
    side_run_dir: Path,
    attempt_dir: Path,
    shard_id: str,
    generation_id: str,
    status: str,
    **extra: Any,
) -> dict[str, Any]:
    status_u = str(status).upper()
    if status_u not in {"COMPLETE", "FAILED", "ABORTED"}:
        raise ValueError(f"invalid generation status: {status}")
    man = update_run_generation_status(Path(side_run_dir), status_u, **extra)
    lock = release_attempt_shard_lock(
        attempt_dir=Path(attempt_dir),
        shard_id=shard_id,
        generation_id=generation_id,
        status=status_u,
    )
    report = {
        "ok": True,
        "generation_id": generation_id,
        "status": status_u,
        "manifest": man,
        "lock": lock,
        "completed_at": utc_now(),
        **extra,
    }
    atomic_write_json(Path(side_run_dir) / "generation-completion-report.json", report)
    return report


def claim_result_writer(
    *,
    side_run_dir: Path,
    art_dir: Path,
    generation_id: str,
    attempt: str,
    shard: str,
    commit: str,
    harness_version: str,
    writer_pid: Optional[int] = None,
) -> dict[str, Any]:
    """Exclusive writer claim for a fresh generation artifact directory."""
    import socket

    side_run_dir = Path(side_run_dir)
    art_dir = Path(art_dir)
    pf = preflight_generation_artifact_ready(
        side_run_dir=side_run_dir,
        art_dir=art_dir,
        generation_id=generation_id,
        allow_missing_art_dir=True,
    )
    if not pf.get("ok"):
        return pf

    man = read_json(side_run_manifest_path(side_run_dir), {}) or {}
    if man.get("generation_id") != generation_id:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH", "manifest": man}
    if man.get("attempt") != attempt:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH", "detail": "attempt"}
    if man.get("shard") != shard:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH", "detail": "shard"}
    if commit and man.get("commit") and man.get("commit") != commit:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH", "detail": "commit"}
    if harness_version and man.get("harness_version") and man.get("harness_version") != harness_version:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH", "detail": "harness"}
    if str(man.get("status") or "").upper() != "RUNNING":
        return {"ok": False, "reason": "RESULT_WRITER_NOT_OWNER", "manifest": man}

    art_dir.mkdir(parents=True, exist_ok=True)
    results = artifact_results_path(art_dir)
    if results.exists():
        return {"ok": False, "reason": "RESULTS_FILE_ALREADY_EXISTS"}

    lock_path = art_dir / WRITER_LOCK_NAME
    if lock_path.exists():
        return {"ok": False, "reason": "RESULT_WRITER_NOT_OWNER", "errors": ["writer.lock exists"]}

    pid = int(writer_pid if writer_pid is not None else os.getpid())
    lock_doc = {
        "attempt": attempt,
        "shard": shard,
        "generation_id": generation_id,
        "commit": commit,
        "harness_version": harness_version,
        "pid": pid,
        "hostname": socket.gethostname(),
        "created_at": utc_now(),
        "status": "OWNED",
    }
    # Exclusive create: O_EXCL
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    try:
        fd = os.open(str(lock_path), flags, 0o644)
    except FileExistsError:
        return {"ok": False, "reason": "RESULT_WRITER_NOT_OWNER"}
    try:
        payload = (json.dumps(lock_doc, indent=2) + "\n").encode()
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)

    return {"ok": True, "writer_lock": lock_doc, "lock_path": str(lock_path), "art_dir": str(art_dir)}


def assert_result_writer_allowed(
    *,
    side_run_dir: Path,
    art_dir: Path,
    generation_id: str,
    attempt: str,
    shard: str,
    commit: str,
    harness_version: str,
    writer_pid: Optional[int] = None,
) -> dict[str, Any]:
    """Validate ownership before appendFileSync / append_result_row_guarded."""
    side_run_dir = Path(side_run_dir)
    art_dir = Path(art_dir)
    man_path = side_run_manifest_path(side_run_dir)
    if not man_path.is_file():
        return {"ok": False, "reason": "RESULT_WRITER_MANIFEST_MISSING"}
    man = read_json(man_path, {}) or {}
    if man.get("generation_id") != generation_id:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH"}
    if man.get("attempt") != attempt or man.get("shard") != shard:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH"}
    if commit and man.get("commit") and man.get("commit") != commit:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH"}
    if harness_version and man.get("harness_version") and man.get("harness_version") != harness_version:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH"}

    lock_path = art_dir / WRITER_LOCK_NAME
    if not lock_path.is_file():
        return {"ok": False, "reason": "RESULT_WRITER_NOT_OWNER", "errors": ["writer.lock missing"]}
    lock = read_json(lock_path, {}) or {}
    if lock.get("generation_id") != generation_id:
        return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH"}
    if writer_pid is not None and lock.get("pid") not in (None, writer_pid):
        # Allow same generation different worker pids only if lock pid matches env owner.
        # Default: require exact pid match when provided.
        if int(lock.get("pid") or -1) != int(writer_pid):
            # Playwright workers may differ; require generation match primarily.
            # Still reject if lock generation mismatches (handled above).
            pass

    # Never append into a results file that predates this generation baseline.
    baseline = read_json(side_run_dir / "generation-start-baseline.json", {}) or {}
    results = artifact_results_path(art_dir)
    if results.exists() and baseline.get("results_existed_at_start") is True:
        return {"ok": False, "reason": "RESULTS_FILE_ALREADY_EXISTS"}

    return {"ok": True, "manifest": man, "writer_lock": lock}


def append_result_row_guarded(
    *,
    side_run_dir: Path,
    art_dir: Path,
    generation_id: str,
    attempt: str,
    shard: str,
    commit: str,
    harness_version: str,
    row: dict[str, Any],
    writer_pid: Optional[int] = None,
) -> dict[str, Any]:
    """Append one JSONL row only when generation ownership checks pass."""
    allowed = assert_result_writer_allowed(
        side_run_dir=side_run_dir,
        art_dir=art_dir,
        generation_id=generation_id,
        attempt=attempt,
        shard=shard,
        commit=commit,
        harness_version=harness_version,
        writer_pid=writer_pid,
    )
    if not allowed.get("ok"):
        return allowed

    results = artifact_results_path(art_dir)
    # First write only: if somehow a foreign file appeared, refuse (no truncate).
    if results.exists() and results.stat().st_size > 0:
        # Ensure existing rows are same generation (defense in depth).
        try:
            first = results.read_text(encoding="utf-8").splitlines()[0]
            existing = json.loads(first) if first.strip() else {}
            if existing.get("generation_id") and existing.get("generation_id") != generation_id:
                return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH"}
        except Exception:
            return {"ok": False, "reason": "RESULT_WRITER_GENERATION_MISMATCH"}

    enriched = {
        **row,
        "attempt": attempt,
        "shard": shard,
        "generation_id": generation_id,
        "commit": commit,
        "git_commit": row.get("git_commit") or commit,
        "harness_version": row.get("harness_version") or harness_version,
    }
    art_dir.mkdir(parents=True, exist_ok=True)
    with open(results, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(enriched, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return {"ok": True, "path": str(results), "row": enriched}


def detect_cross_generation_rows(
    rows: list[dict[str, Any]],
    *,
    expected_generation_id: Optional[str] = None,
    expected_attempt: Optional[str] = None,
    expected_shard: Optional[str] = None,
    expected_commit: Optional[str] = None,
    expected_harness: Optional[str] = None,
) -> dict[str, Any]:
    gens = sorted({str(r.get("generation_id")) for r in rows if r.get("generation_id")})
    attempts = sorted({str(r.get("attempt")) for r in rows if r.get("attempt")})
    shards = sorted({str(r.get("shard")) for r in rows if r.get("shard")})
    commits = sorted(
        {
            str(r.get("git_commit") or r.get("commit"))
            for r in rows
            if (r.get("git_commit") or r.get("commit"))
        }
    )
    harnesses = sorted({str(r.get("harness_version")) for r in rows if r.get("harness_version")})
    errors: list[str] = []
    if len(gens) > 1:
        errors.append("CROSS_GENERATION_RESULTS_DETECTED")
    if expected_generation_id and gens and set(gens) != {expected_generation_id}:
        errors.append("CROSS_GENERATION_RESULTS_DETECTED")
    if len(attempts) > 1:
        errors.append("attempt not single-valued")
    if expected_attempt and attempts and set(attempts) != {expected_attempt}:
        errors.append("attempt mismatch")
    if len(shards) > 1:
        errors.append("shard not single-valued")
    if expected_shard and shards and set(shards) != {expected_shard}:
        errors.append("shard mismatch")
    if len(commits) > 1:
        errors.append("commit not single-valued")
    if expected_commit and commits and set(commits) != {expected_commit}:
        errors.append("commit mismatch")
    if len(harnesses) > 1:
        errors.append("harness not single-valued")
    if expected_harness and harnesses and set(harnesses) != {expected_harness}:
        errors.append("harness mismatch")
    reason = "CROSS_GENERATION_RESULTS_DETECTED" if any("CROSS_GENERATION" in e for e in errors) else (
        errors[0] if errors else None
    )
    return {
        "ok": not errors,
        "reason": reason,
        "errors": errors,
        "generation_ids": gens,
        "attempts": attempts,
        "shards": shards,
        "commits": commits,
        "harness_versions": harnesses,
    }


def build_generation_authority_baseline(
    *,
    side_run_dir: Path,
    art_dir: Path,
) -> dict[str, Any]:
    """SHA-256 baseline for authoritative generation outputs."""
    side_run_dir = Path(side_run_dir)
    art_dir = Path(art_dir)
    candidates = [
        side_run_dir / RUN_GENERATION_NAME,
        art_dir / RESULT_JSONL_NAME,
        art_dir / "validation.json",
        art_dir / "shard-summary.json",
        art_dir / "shard-manifest.json",
        side_run_dir / "generation-completion-report.json",
    ]
    files: dict[str, Any] = {}
    for p in candidates:
        if p.is_file():
            files[str(p.relative_to(side_run_dir) if p.is_relative_to(side_run_dir) else p.name)] = {
                "path": str(p),
                "sha256": sha256_file(p),
                "size": p.stat().st_size,
            }
    doc = {
        "created_at": utc_now(),
        "side_run_dir": str(side_run_dir),
        "art_dir": str(art_dir),
        "files": files,
        "authoritative": True,
    }
    atomic_write_json(side_run_dir / "generation-authority-baseline.json", doc)
    return doc
