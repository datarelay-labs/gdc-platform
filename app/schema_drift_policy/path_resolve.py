"""Extracted → enriched path resolution (parity with Wizard path resolve)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.mappers.mapping_rules import normalize_field_mappings
from app.parsers.jsonpath_parser import extract_one
from app.runtime.response_analysis import flatten_field_paths

_ARRAY_INDEX_RE = re.compile(r"\[\d+\]")


def normalize_protection_json_path(path: str) -> str:
    trimmed = str(path or "").strip()
    if not trimmed:
        return ""
    return trimmed if trimmed.startswith("$") else f"$.{trimmed}"


def _leaf_segment(field_path: str) -> str:
    normalized = normalize_protection_json_path(field_path)
    leaf = normalized.split(".")[-1] if normalized else normalized
    return _ARRAY_INDEX_RE.sub("", leaf).replace("$", "").lower()


def collect_enriched_field_paths(events: list[dict[str, Any]]) -> list[str]:
    paths: set[str] = set()
    for event in events:
        if not isinstance(event, dict):
            continue
        for path in flatten_field_paths(event):
            normalized = normalize_protection_json_path(path)
            if normalized:
                paths.add(normalized)
    return sorted(paths)


def path_exists_on_event(event: dict[str, Any], field_path: str) -> bool:
    normalized = normalize_protection_json_path(field_path)
    if not normalized or normalized == "$":
        return False
    try:
        value = extract_one(event, normalized)
    except Exception:
        return False
    return value is not None


def path_exists_in_batch(events: list[dict[str, Any]], field_path: str) -> bool:
    return any(isinstance(event, dict) and path_exists_on_event(event, field_path) for event in events)


def build_protection_path_alias_map(
    *,
    field_mappings: dict[str, Any] | None,
    enrichment_json: dict[str, Any] | None,
) -> dict[str, str]:
    """Mapping source JSONPath → enriched output path."""

    aliases: dict[str, str] = {}
    for rule in normalize_field_mappings(field_mappings):
        source = normalize_protection_json_path(rule.source_json_path)
        output = normalize_protection_json_path(rule.output_field)
        if source and output:
            aliases[source] = output

    enrichment = enrichment_json if isinstance(enrichment_json, dict) else {}
    for key, raw in enrichment.items():
        if not isinstance(key, str) or not key.strip():
            continue
        target_path = normalize_protection_json_path(key.strip())
        if not target_path:
            continue
        if isinstance(raw, dict):
            source_field = str(raw.get("source_field") or raw.get("normalize_source_field") or "").strip()
            if source_field:
                aliases[normalize_protection_json_path(source_field)] = target_path
        elif isinstance(raw, str) and raw.strip():
            aliases[normalize_protection_json_path(raw.strip())] = target_path

    return aliases


@dataclass(frozen=True, slots=True)
class PathResolveResult:
    ok: bool
    resolved_path: str = ""
    error: str = ""


def resolve_protection_field_path(
    selected_path: str,
    runtime_paths: list[str],
    alias_map: dict[str, str],
) -> PathResolveResult:
    normalized = normalize_protection_json_path(selected_path)
    if not normalized:
        return PathResolveResult(ok=False, error="Protection field path is required.")

    path_set = {normalize_protection_json_path(path) for path in runtime_paths}

    # Prefer mapped/enriched output path even when the extracted source path is
    # still present (Route Processing shared phase runs drift before transform).
    aliased = alias_map.get(normalized)
    if aliased:
        return PathResolveResult(ok=True, resolved_path=aliased)

    if normalized in path_set:
        return PathResolveResult(ok=True, resolved_path=normalized)

    leaf = _leaf_segment(normalized)
    leaf_matches = [path for path in path_set if _leaf_segment(path) == leaf]
    if len(leaf_matches) == 1:
        return PathResolveResult(ok=True, resolved_path=leaf_matches[0])
    if len(leaf_matches) > 1:
        return PathResolveResult(
            ok=False,
            error=f"Ambiguous protection path {normalized}; matches: {', '.join(leaf_matches)}",
        )

    return PathResolveResult(
        ok=False,
        error=f"Protection path {normalized} does not exist on the runtime enriched event.",
    )
