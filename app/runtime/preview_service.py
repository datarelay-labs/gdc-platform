"""Runtime preview and HTTP API test execution (read-only; no StreamRunner/Sender/DB mutations)."""

from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from app.http.outbound_httpx_timeout import outbound_httpx_timeout

from app.destinations.repository import get_destination_by_id
from app.delivery.webhook_payload_mode import (
    WEBHOOK_PAYLOAD_MODE_BATCH,
    resolve_webhook_payload_mode,
)
from app.enrichers.enrichment_engine import apply_enrichments
from app.formatters.config_resolver import resolve_formatter_config
from app.formatters.json_formatter import build_webhook_http_preview_messages, format_webhook_events
from app.formatters.message_prefix import (
    build_message_prefix_context,
    compact_event_json,
    effective_message_prefix_enabled,
    effective_message_prefix_template,
    format_delivery_lines_syslog,
    format_single_delivery_line,
    resolve_message_prefix_template,
)
from app.formatters.syslog_formatter import format_syslog
from app.pollers.http_query_params import httpx_body_kwargs
from app.enrichers.rule_executor import execute_enrichment
from app.enrichers.rule_validation import validate_enrichment_json
from app.mappers.full_event_mapping import (
    apply_full_event_mapping,
    extract_basic_jsonpath_mappings,
    is_full_event_mapping,
)
from app.mappers.mapper import apply_compiled_mappings, apply_mapping, apply_mappings, compile_mappings
from app.mappers.unmapped_policy import should_pass_through_unmapped
from app.parsers.event_extractor import extract_events
from app.parsers.extraction_paths import (
    is_preview_only_array_path,
    normalize_event_array_path,
    normalize_event_root_path,
)
from app.parsers.jsonpath_parser import find_values
from app.http.shared_request_builder import (
    build_shared_http_request,
    join_base_url_endpoint,
    merge_shared_header_layers,
)
from app.routes.models import Route
from app.streams.models import Stream
from app.sources.models import Source
from app.sources.database_query.execute import preview_limited_rows, probe_database_connection
from app.sources.s3_probe import probe_s3_source
from app.sources.remote_file_probe import probe_remote_file_source
from app.connectors.auth.http_common import build_request_url
from app.connectors.session_login_http import SessionLoginHttpDebug
from app.connectors.auth.normalize import normalize_connector_auth
from app.connectors.auth.registry import apply_auth_to_http_request
from app.runtime.errors import EnrichmentError, MappingError, ParserError, PreviewRequestError, SourceFetchError, SourceFetchError
from app.security.secrets import mask_http_headers, mask_secrets
from app.connectors.auth_execute import (
    _vendor_jwt_validate_credentials,
    build_vendor_token_exchange_auth_headers,
    build_vendor_token_exchange_body_kwargs,
    merge_vendor_access_into_target,
    normalize_vendor_token_auth_mode,
    resolve_vendor_token_exchange_url,
    resource_json_kw,
    vendor_access_token_from_response,
    vendor_token_request_body_mode_label,
)
from app.runtime.response_analysis import build_http_api_test_analysis_dict
from app.runtime.schemas import (
    ConnectorAuthTestRequest,
    ConnectorAuthTestResponse,
    DeliveryFormatDraftPreviewRequest,
    DeliveryFormatDraftPreviewResponse,
    ExtractionValidateRequest,
    ExtractionValidateResponse,
    ExtractionValidationIssue,
    E2EDraftPreviewRequest,
    E2EDraftPreviewResponse,
    FormatPreviewRequest,
    FormatPreviewResponse,
    FinalEventDraftPreviewRequest,
    FinalEventDraftPreviewResponse,
    HttpApiTestAnalysis,
    HttpApiTestActualRequestMeta,
    HttpApiTestRequest,
    HttpApiTestResponse,
    HttpApiTestRequestMeta,
    HttpApiTestResponseMeta,
    HttpApiTestStep,
    MappingDraftPreviewMissingFieldItem,
    MappingDraftPreviewRequest,
    MappingDraftPreviewResponse,
    MappingJsonPathItem,
    MappingJsonPathsRequest,
    MappingJsonPathsResponse,
    MappingPreviewRequest,
    MappingPreviewResponse,
    MappingValidateRequest,
    MappingValidateResponse,
    MappingValidationWarning,
    DeliveryPrefixFormatPreviewRequest,
    DeliveryPrefixFormatPreviewResponse,
    EnrichmentExecPreviewRequest,
    EnrichmentExecPreviewResponse,
    EnrichmentExecPreviewWarning,
    EnrichmentValidateRequest,
    EnrichmentValidateResponse,
    EnrichmentValidationIssueItem,
    RouteDeliveryPreviewRequest,
    RouteDeliveryPreviewResponse,
    TransformPreviewFieldResultItem,
    TransformPreviewIssueItem,
    TransformPreviewRequest,
    TransformPreviewResponse,
    TransformPreviewSampleSummary,
    SensitiveDetectionPreviewRequest,
    SensitiveDetectionPreviewResponse,
    SensitiveSuggestionEntry,
)


def _lookup(cfg: dict[str, Any], keys: list[str], default: Any = None) -> Any:
    for key in keys:
        if key in cfg and cfg[key] is not None:
            return cfg[key]
    return default


_normalize_auth = normalize_connector_auth
_apply_auth_to_request = apply_auth_to_http_request


def _is_database_query_connector_auth_config(cfg: dict[str, Any]) -> bool:
    if str(cfg.get("source_type") or "").strip().upper() == "DATABASE_QUERY":
        return True
    return bool(
        str(cfg.get("db_type") or "").strip().upper() == "POSTGRESQL"
        and str(cfg.get("host") or "").strip()
        and str(cfg.get("database") or "").strip()
    )


def _is_remote_file_connector_auth_config(cfg: dict[str, Any]) -> bool:
    if str(cfg.get("source_type") or "").strip().upper() in {"REMOTE_FILE_POLLING", "REMOTE_FILE"}:
        return True
    return bool(
        str(cfg.get("connector_type") or "").strip().lower() == "remote_file"
        and str(cfg.get("host") or "").strip()
    )


def _normalize_remote_file_source_for_runtime(cfg: dict[str, Any]) -> dict[str, Any]:
    out = dict(cfg)
    if not str(out.get("username") or "").strip() and out.get("remote_username"):
        out["username"] = str(out.get("remote_username") or "").strip()
    if out.get("password") in (None, "") and out.get("remote_password"):
        out["password"] = str(out.get("remote_password") or "")
    if not str(out.get("protocol") or "").strip() and out.get("remote_file_protocol"):
        out["protocol"] = str(out.get("remote_file_protocol") or "sftp").strip().lower()
    if not str(out.get("private_key") or "").strip() and out.get("remote_private_key"):
        out["private_key"] = str(out.get("remote_private_key") or "")
    if not str(out.get("private_key_passphrase") or "").strip() and out.get("remote_private_key_passphrase"):
        out["private_key_passphrase"] = str(out.get("remote_private_key_passphrase") or "")
    return out


def _is_s3_connector_auth_config(cfg: dict[str, Any]) -> bool:
    if str(cfg.get("source_type") or "").strip().upper() in {"S3_OBJECT_POLLING", "S3"}:
        return True
    return bool(
        str(cfg.get("endpoint_url") or "").strip()
        and str(cfg.get("bucket") or "").strip()
        and not str(cfg.get("base_url") or "").strip()
    )


def _flatten_source_row(source: Source) -> dict[str, Any]:
    cfg = dict(source.config_json or {})
    auth = dict(source.auth_json or {})
    out: dict[str, Any] = {
        "base_url": str(cfg.get("base_url") or "").strip(),
        "verify_ssl": bool(cfg.get("verify_ssl", True)),
        "http_proxy": cfg.get("http_proxy"),
        "headers": dict(cfg.get("common_headers") or {}),
    }
    out.update(auth)
    return out


def _flatten_any_source_row(source: Source) -> dict[str, Any]:
    st = str(source.source_type or "").strip().upper()
    if st == "S3_OBJECT_POLLING":
        out = dict(source.config_json or {})
        out["source_type"] = "S3_OBJECT_POLLING"
        auth = dict(source.auth_json or {})
        out["auth_type"] = str(auth.get("auth_type") or "no_auth")
        return out
    if st == "DATABASE_QUERY":
        out = dict(source.config_json or {})
        out["source_type"] = "DATABASE_QUERY"
        out["auth_type"] = "no_auth"
        return out
    if st == "REMOTE_FILE_POLLING":
        out = dict(source.config_json or {})
        out["source_type"] = "REMOTE_FILE_POLLING"
        out["auth_type"] = "no_auth"
        return out
    return _flatten_source_row(source)


def _load_source_config_for_connector(db: Session, connector_id: int) -> dict[str, Any] | None:
    """Load merged Source config for connector-auth and stream API tests."""

    row = db.query(Source).filter(Source.connector_id == connector_id).order_by(Source.id.asc()).first()
    if row is None:
        return None
    return _flatten_any_source_row(row)


def _target_suggests_login_redirect(resp: httpx.Response) -> bool:
    if resp.status_code not in (301, 302, 303, 307, 308):
        return False
    loc = (resp.headers.get("location") or "").lower()
    if not loc:
        return False
    needles = ("login", "signin", "sign-in", "auth", "/session", "logout")
    return any(n in loc for n in needles)


def _jar_has_named_cookie(jar: Any, name: str) -> bool:
    getter = getattr(jar, "get", None)
    if callable(getter):
        try:
            return getter(name) is not None
        except Exception:
            return False
    return False


def _perform_session_login(client: httpx.Client, auth: dict[str, Any], base_url: str) -> tuple[httpx.Response, SessionLoginHttpDebug]:
    """Single configured login POST (or method from auth); raises PreviewRequestError on obvious failure."""

    from app.connectors.session_login_http import resolve_session_login_url, session_login_single_request

    username = str(auth.get("login_username") or "")
    password = str(auth.get("login_password") or "")
    if not username or not password:
        raise PreviewRequestError(
            400,
            {
                "ok": False,
                "error_type": "session_login_failed",
                "message": "login_username/login_password missing from connector auth",
                "hint": "Ensure connector credentials are saved on the connector Source.",
            },
        )

    origin = base_url.rstrip("/")
    login_url = resolve_session_login_url(auth, origin)
    if not login_url:
        raise PreviewRequestError(
            400,
            {
                "ok": False,
                "error_type": "session_login_failed",
                "message": "login_url or login_path is required for SESSION_LOGIN",
            },
        )

    lr, dbg = session_login_single_request(client, auth, origin)
    if not dbg.login_http_ok:
        raise PreviewRequestError(
            400,
            {
                "ok": False,
                "error_type": "session_login_failed",
                "message": dbg.login_http_reason,
                "login_http_status": int(lr.status_code),
                "login_final_url": dbg.login_final_url,
                "redirect_chain": dbg.redirect_chain,
                "session_login_body_mode": dbg.body_mode,
                "session_login_follow_redirects": dbg.login_allow_redirects,
                "login_failure_reason": dbg.login_http_reason,
                "login_http_reason": dbg.login_http_reason,
                "session_login_body_preview": dbg.session_login_body_preview,
                "session_login_content_type": dbg.session_login_content_type,
                "session_login_request_encoding": dbg.session_login_request_encoding,
                "computed_login_request_url": dbg.computed_login_request_url,
                "login_url_resolution_warnings": dbg.login_url_resolution_warnings,
                "preflight_http_status": dbg.preflight_http_status,
                "preflight_final_url": dbg.preflight_final_url,
                "preflight_cookies": dbg.preflight_cookies,
                "extracted_variables": dbg.extracted_variables,
                "template_render_preview": dbg.template_render_preview,
            },
        )

    named = str(auth.get("session_cookie_name") or "").strip()
    if named and not _jar_has_named_cookie(client.cookies, named):
        raise PreviewRequestError(
            400,
            {
                "ok": False,
                "error_type": "session_login_failed",
                "message": f"expected session cookie {named!r} not present after login",
            },
        )
    return lr, dbg


def perform_http_session_login(client: httpx.Client, source_config: dict[str, Any]) -> None:
    """Run SESSION_LOGIN on ``client`` so cookies persist for later requests."""

    auth = _normalize_auth(source_config)
    if auth.get("auth_type") != "SESSION_LOGIN":
        return
    base_url = str(_lookup(source_config, ["base_url", "host"], "")).strip()
    _perform_session_login(client, auth, base_url)


def _redirect_chain_urls(resp: httpx.Response) -> list[str]:
    return [str(r.url) for r in resp.history] + [str(resp.url)]


def _resolve_connector_auth_test_url(base_url: str, test_path: str | None, test_url: str | None) -> str:
    """Build probe URL from base + path, or validate absolute test_url (same host as base — SSRF guard)."""

    raw_abs = (test_url or "").strip()
    if raw_abs:
        parsed = urlparse(raw_abs)
        if parsed.scheme not in ("http", "https"):
            raise PreviewRequestError(
                400,
                {"ok": False, "error_type": "invalid_test_url", "message": "test_url must be an http(s) URL"},
            )
        if not parsed.netloc:
            raise PreviewRequestError(
                400,
                {"ok": False, "error_type": "invalid_test_url", "message": "test_url must include a host"},
            )
        base_for_parse = base_url.strip()
        if "://" not in base_for_parse:
            base_for_parse = f"https://{base_for_parse}"
        base_p = urlparse(base_for_parse)
        host_a = (base_p.hostname or "").lower()
        host_b = (parsed.hostname or "").lower()
        if host_a and host_b and host_a != host_b:
            raise PreviewRequestError(
                400,
                {
                    "ok": False,
                    "error_type": "invalid_test_url",
                    "message": f"test_url host must match connector base URL host ({host_a})",
                },
            )
        return raw_abs
    path = (test_path if test_path is not None else "").strip() or "/"
    if not path.startswith("/"):
        path = f"/{path}"
    return build_request_url(base_url, path)


def _auth_test_classify_status(code: int) -> tuple[bool, str | None, str]:
    """Returns (ok_2xx, error_type_or_none, short_message)."""

    if 200 <= code < 300:
        return True, None, f"HTTP {code}"
    if code == 401:
        return False, "target_401_unauthorized", f"HTTP {code} Unauthorized"
    if code == 403:
        return False, "target_403_forbidden", f"HTTP {code} Forbidden"
    if code == 404:
        return False, "target_404_not_found", f"HTTP {code} Not Found"
    if code == 405:
        return False, "target_405_method_not_allowed", f"HTTP {code} Method Not Allowed"
    return False, "target_http_error", f"HTTP {code}"


def _connector_auth_response_from_probe(
    *,
    auth_type: str,
    method: str,
    request_url: str,
    headers_sent: dict[str, str],
    response: httpx.Response | None,
    login_http_status: int | None = None,
    login_final_url: str | None = None,
    redirect_chain: list[str] | None = None,
    session_cookie_obtained: bool = False,
    cookie_names: list[str] | None = None,
    session_message: str | None = None,
    transport_error: str | None = None,
    transport_error_type: str | None = None,
    message_override: str | None = None,
    session_login_body_mode: str | None = None,
    session_login_follow_redirects: bool | None = None,
    login_failure_reason: str | None = None,
    login_http_reason: str | None = None,
    session_login_body_preview: str | None = None,
    session_login_content_type: str | None = None,
    session_login_request_encoding: str | None = None,
    preflight_http_status: int | None = None,
    preflight_final_url: str | None = None,
    preflight_cookies: dict[str, str] | None = None,
    extracted_variables: dict[str, str] | None = None,
    template_render_preview: str | None = None,
    computed_login_request_url: str | None = None,
    login_url_resolution_warnings: list[str] | None = None,
) -> ConnectorAuthTestResponse:
    req_masked = mask_http_headers({str(k): str(v) for k, v in headers_sent.items()})
    if response is None:
        return ConnectorAuthTestResponse(
            ok=False,
            auth_type=auth_type,
            message=transport_error or "Request failed",
            error_type=transport_error_type or "network_error",
            login_http_status=login_http_status,
            login_final_url=login_final_url,
            redirect_chain=redirect_chain or [],
            session_cookie_obtained=session_cookie_obtained,
            cookie_names=cookie_names or [],
            request_method=method,
            request_url=request_url,
            request_headers_masked=req_masked,
            session_login_body_mode=session_login_body_mode,
            session_login_follow_redirects=session_login_follow_redirects,
            login_failure_reason=login_failure_reason,
            login_http_reason=login_http_reason,
            session_login_body_preview=session_login_body_preview,
            session_login_content_type=session_login_content_type,
            session_login_request_encoding=session_login_request_encoding,
            preflight_http_status=preflight_http_status,
            preflight_final_url=preflight_final_url,
            preflight_cookies=preflight_cookies,
            extracted_variables=extracted_variables,
            template_render_preview=template_render_preview,
            computed_login_request_url=computed_login_request_url,
            login_url_resolution_warnings=list(login_url_resolution_warnings or []),
        )

    code = int(response.status_code)
    ok_2xx, etype, short_msg = _auth_test_classify_status(code)
    raw = response.text
    try:
        body_snip = json.dumps(mask_secrets(response.json()), ensure_ascii=False)[:8000]
    except Exception:
        body_snip = raw[:8000] if raw else ""
    resp_headers = mask_http_headers({k: v for k, v in response.headers.items()})
    parts = [session_message] if session_message else []
    eff_url = str(response.request.url) if response.request else request_url
    if message_override:
        msg_line = message_override
    else:
        parts.append(f"{method} {eff_url} → HTTP {code}")
        if not ok_2xx and etype:
            parts.append(short_msg)
        msg_line = " · ".join(p for p in parts if p) or short_msg
    return ConnectorAuthTestResponse(
        ok=ok_2xx,
        auth_type=auth_type,
        message=msg_line,
        error_type=None if ok_2xx else etype,
        login_http_status=login_http_status,
        login_final_url=login_final_url,
        redirect_chain=redirect_chain or [],
        session_cookie_obtained=session_cookie_obtained,
        cookie_names=cookie_names or [],
        probe_http_status=code,
        probe_url=request_url,
        request_method=method,
        request_url=eff_url,
        request_headers_masked=req_masked,
        response_status_code=code,
        response_headers_masked=resp_headers,
        response_body=body_snip,
        session_login_body_mode=session_login_body_mode,
        session_login_follow_redirects=session_login_follow_redirects,
        login_failure_reason=login_failure_reason,
        login_http_reason=login_http_reason,
        session_login_body_preview=session_login_body_preview,
        session_login_content_type=session_login_content_type,
        session_login_request_encoding=session_login_request_encoding,
        preflight_http_status=preflight_http_status,
        preflight_final_url=preflight_final_url,
        preflight_cookies=preflight_cookies,
        extracted_variables=extracted_variables,
        template_render_preview=template_render_preview,
        computed_login_request_url=computed_login_request_url,
        login_url_resolution_warnings=list(login_url_resolution_warnings or []),
    )


def _source_config_for_connector_auth_test(payload: ConnectorAuthTestRequest, db: Session | None) -> dict[str, Any]:
    """Load merged Source config from DB or use unsaved inline payload (same shape as _flatten_source_row)."""

    if payload.connector_id is not None:
        loaded = _load_source_config_for_connector(db, int(payload.connector_id))
        if loaded is None:
            raise PreviewRequestError(
                404,
                {
                    "ok": False,
                    "error_type": "connector_not_found",
                    "message": f"No Source row found for connector_id={payload.connector_id}",
                },
            )
        return loaded
    inl = dict(payload.inline_flat_source or {})
    if "headers" not in inl and "common_headers" in inl:
        inl = {**inl, "headers": dict(inl.get("common_headers") or {})}
    return inl


def _mask_auth_probe_body(resp: httpx.Response) -> str:
    raw = (resp.text or "")[:8000]
    try:
        return json.dumps(mask_secrets(resp.json()), ensure_ascii=False)
    except Exception:
        return raw


def _vendor_jwt_connector_auth_test(
    *,
    auth: dict[str, Any],
    base_url: str,
    method: str,
    target_url: str,
    verify_ssl: bool,
    proxy_url: str | None,
    timeout_seconds: float,
    common_headers: dict[str, str],
    extra_headers: dict[str, str],
    query_params: dict[str, Any],
    json_body: Any | None,
) -> ConnectorAuthTestResponse:
    """Auth probe for vendor_jwt_exchange: token request ignores common headers; final request merges them."""

    auth_label = str(auth.get("auth_type") or "VENDOR_JWT_EXCHANGE").strip().upper()
    path_origin = base_url.rstrip("/")
    method_u = str(method or "GET").strip().upper()

    def merged_final_headers() -> dict[str, str]:
        h = {str(k): str(v) for k, v in common_headers.items()}
        h.update(extra_headers)
        return h

    mode = normalize_vendor_token_auth_mode(auth.get("token_auth_mode"))
    val_err = _vendor_jwt_validate_credentials(auth, mode)
    if val_err:
        return ConnectorAuthTestResponse(
            ok=False,
            auth_type=auth_label,
            message=val_err,
            error_type="vendor_jwt_exchange_failed",
            phase="token_exchange",
            token_request_method=None,
            token_request_url=None,
            token_request_headers_masked={},
            token_request_body_mode=None,
            token_response_status_code=None,
            token_response_headers_masked={},
            token_response_body=None,
            token_response_body_masked=None,
            final_request_method=method_u,
            final_request_url=target_url,
            final_request_headers_masked={},
            final_response_status_code=None,
            final_response_headers_masked={},
            final_response_body=None,
            request_method=method_u,
            request_url=target_url,
            request_headers_masked={},
            response_status_code=None,
            response_headers_masked={},
            response_body=None,
        )

    token_method_u = str(auth.get("token_method") or "POST").upper()
    token_url_raw = str(auth.get("token_url") or "").strip()
    resolved_token_url = resolve_vendor_token_exchange_url(token_url_raw, path_origin)
    body_mode_label = vendor_token_request_body_mode_label(auth, token_method_u)

    try:
        tok_headers, tok_query = build_vendor_token_exchange_auth_headers(auth)
        body_kw = build_vendor_token_exchange_body_kwargs(auth, token_method_u)
    except (json.JSONDecodeError, ValueError) as exc:
        return ConnectorAuthTestResponse(
            ok=False,
            auth_type=auth_label,
            message=str(exc),
            error_type="vendor_jwt_exchange_failed",
            phase="token_exchange",
            token_request_method=token_method_u,
            token_request_url=resolved_token_url or None,
            token_request_headers_masked={},
            token_request_body_mode=body_mode_label,
            token_response_status_code=None,
            token_response_headers_masked={},
            token_response_body=None,
            token_response_body_masked=None,
            final_request_method=method_u,
            final_request_url=target_url,
            final_request_headers_masked={},
            final_response_status_code=None,
            final_response_headers_masked={},
            final_response_body=None,
            request_method=method_u,
            request_url=target_url,
            request_headers_masked={},
            response_status_code=None,
            response_headers_masked={},
            response_body=None,
        )

    tok_req_masked = mask_http_headers(tok_headers)

    try:
        httpx_timeout = outbound_httpx_timeout(timeout_seconds)
        with httpx.Client(verify=verify_ssl, proxy=proxy_url, timeout=httpx_timeout) as client:
            tr = client.request(
                token_method_u,
                resolved_token_url,
                headers=tok_headers,
                params=tok_query if tok_query else None,
                follow_redirects=False,
                **body_kw,
            )

            tok_resp_headers_masked = mask_http_headers({str(k): str(v) for k, v in tr.headers.items()})
            tok_body_masked = _mask_auth_probe_body(tr)

            code = int(tr.status_code)
            ok_tok, et_tok, short_tok = _auth_test_classify_status(code)

            tok_bundle = {
                "token_request_method": token_method_u,
                "token_request_url": str(tr.request.url) if tr.request else resolved_token_url,
                "token_request_headers_masked": tok_req_masked,
                "token_request_body_mode": body_mode_label,
                "token_response_status_code": code,
                "token_response_headers_masked": tok_resp_headers_masked,
                "token_response_body": tok_body_masked,
                "token_response_body_masked": tok_body_masked,
            }

            if not ok_tok:
                msg = f"Token exchange failed: {token_method_u} {tok_bundle['token_request_url']} returned HTTP {code} ({short_tok}). See token_response_body_masked."
                return ConnectorAuthTestResponse(
                    ok=False,
                    auth_type=auth_label,
                    message=msg,
                    error_type=et_tok or "vendor_jwt_exchange_failed",
                    phase="token_exchange",
                    request_method=method_u,
                    request_url=target_url,
                    **tok_bundle,
                    final_request_method=method_u,
                    final_request_url=target_url,
                    final_request_headers_masked={},
                    final_response_status_code=None,
                    final_response_headers_masked={},
                    final_response_body=None,
                    request_headers_masked={},
                    response_status_code=None,
                    response_headers_masked={},
                    response_body=None,
                )

            try:
                tjson = tr.json()
            except Exception:
                msg = f"Token exchange succeeded with HTTP {code} but response body is not JSON. See token_response_body_masked."
                return ConnectorAuthTestResponse(
                    ok=False,
                    auth_type=auth_label,
                    message=msg,
                    error_type="vendor_jwt_exchange_failed",
                    phase="token_exchange",
                    request_method=method_u,
                    request_url=target_url,
                    **tok_bundle,
                    final_request_method=method_u,
                    final_request_url=target_url,
                    final_request_headers_masked={},
                    final_response_status_code=None,
                    final_response_headers_masked={},
                    final_response_body=None,
                    request_headers_masked={},
                    response_status_code=None,
                    response_headers_masked={},
                    response_body=None,
                )

            tdict = tjson if isinstance(tjson, dict) else {}
            access_token = vendor_access_token_from_response(tdict, auth)
            if not access_token:
                tb = json.dumps(mask_secrets(tdict), ensure_ascii=False)[:8000]
                tb_bundle = {**tok_bundle, "token_response_body": tb, "token_response_body_masked": tb}
                msg = "access token not found at token_path (see token_response_body_masked)."
                return ConnectorAuthTestResponse(
                    ok=False,
                    auth_type=auth_label,
                    message=msg,
                    error_type="token_extraction_failed",
                    phase="token_exchange",
                    request_method=method_u,
                    request_url=target_url,
                    **tb_bundle,
                    final_request_method=method_u,
                    final_request_url=target_url,
                    final_request_headers_masked={},
                    final_response_status_code=None,
                    final_response_headers_masked={},
                    final_response_body=None,
                    request_headers_masked={},
                    response_status_code=None,
                    response_headers_masked={},
                    response_body=None,
                )

            params = dict(query_params)
            final_headers, final_params = merge_vendor_access_into_target(auth, str(access_token), merged_final_headers(), params)
            final_headers.setdefault("Accept", "application/json")
            final_headers.setdefault("Content-Type", "application/json")

            try:
                resp = client.request(
                    method_u,
                    target_url,
                    headers=final_headers,
                    params=final_params if final_params else None,
                    follow_redirects=False,
                    **resource_json_kw(method_u, json_body, final_headers),
                )
            except httpx.TimeoutException:
                return ConnectorAuthTestResponse(
                    ok=False,
                    auth_type=auth_label,
                    message=f"Final probe timed out: {method_u} {target_url}",
                    error_type="timeout",
                    phase="final_request",
                    request_method=method_u,
                    request_url=target_url,
                    **tok_bundle,
                    final_request_method=method_u,
                    final_request_url=target_url,
                    request_headers_masked=mask_http_headers(final_headers),
                    final_request_headers_masked=mask_http_headers(final_headers),
                    final_response_status_code=None,
                    final_response_headers_masked={},
                    final_response_body=None,
                    response_status_code=None,
                    response_headers_masked={},
                    response_body=None,
                )
            except httpx.ConnectError as exc:
                lowered = str(exc).lower()
                et = "ssl_error" if "ssl" in lowered or "certificate" in lowered else "network_error"
                return ConnectorAuthTestResponse(
                    ok=False,
                    auth_type=auth_label,
                    message=f"Final probe connection error: {exc}",
                    error_type=et,
                    phase="final_request",
                    request_method=method_u,
                    request_url=target_url,
                    **tok_bundle,
                    final_request_method=method_u,
                    final_request_url=target_url,
                    request_headers_masked=mask_http_headers(final_headers),
                    final_request_headers_masked=mask_http_headers(final_headers),
                    final_response_status_code=None,
                    final_response_headers_masked={},
                    final_response_body=None,
                    response_status_code=None,
                    response_headers_masked={},
                    response_body=None,
                )

            fin_url = str(resp.request.url) if resp.request else target_url
            code_sc = int(resp.status_code)
            eff_msg = f"Final probe: {method_u} {fin_url} → HTTP {code_sc}"
            fin = _connector_auth_response_from_probe(
                auth_type=auth_label,
                method=method_u,
                request_url=target_url,
                headers_sent=final_headers,
                response=resp,
                message_override=eff_msg,
            )
            out = fin.model_copy(
                update={
                    **tok_bundle,
                    "phase": None if fin.ok else "final_request",
                    "final_request_method": method_u,
                    "final_request_url": fin_url,
                    "final_request_headers_masked": mask_http_headers(final_headers),
                    "final_response_status_code": int(resp.status_code),
                    "final_response_headers_masked": mask_http_headers({str(k): str(v) for k, v in resp.headers.items()}),
                    "final_response_body": fin.response_body,
                    "probe_http_status": fin.probe_http_status,
                    "probe_url": fin.probe_url,
                }
            )
            if not fin.ok:
                detail = (
                    f"Final request failed: {method_u} {fin_url} returned HTTP {int(resp.status_code)}. "
                    f"See final_response_body and error_type."
                )
                return out.model_copy(update={"message": detail})
            return out

    except httpx.TimeoutException:
        return ConnectorAuthTestResponse(
            ok=False,
            auth_type=auth_label,
            message=f"Token exchange timed out: {token_method_u} {resolved_token_url}",
            error_type="timeout",
            phase="token_exchange",
            token_request_method=token_method_u,
            token_request_url=resolved_token_url,
            token_request_headers_masked=tok_req_masked,
            token_request_body_mode=body_mode_label,
            token_response_status_code=None,
            token_response_headers_masked={},
            token_response_body=None,
            token_response_body_masked=None,
            final_request_method=method_u,
            final_request_url=target_url,
            final_request_headers_masked={},
            final_response_status_code=None,
            final_response_headers_masked={},
            final_response_body=None,
            request_method=method_u,
            request_url=target_url,
            request_headers_masked={},
            response_status_code=None,
            response_headers_masked={},
            response_body=None,
        )
    except httpx.ConnectError as exc:
        lowered = str(exc).lower()
        et = "ssl_error" if "ssl" in lowered or "certificate" in lowered else "network_error"
        return ConnectorAuthTestResponse(
            ok=False,
            auth_type=auth_label,
            message=f"Token exchange connection error: {exc}",
            error_type=et,
            phase="token_exchange",
            token_request_method=token_method_u,
            token_request_url=resolved_token_url,
            token_request_headers_masked=tok_req_masked,
            token_request_body_mode=body_mode_label,
            token_response_status_code=None,
            token_response_headers_masked={},
            token_response_body=None,
            token_response_body_masked=None,
            final_request_method=method_u,
            final_request_url=target_url,
            final_request_headers_masked={},
            final_response_status_code=None,
            final_response_headers_masked={},
            final_response_body=None,
            request_method=method_u,
            request_url=target_url,
            request_headers_masked={},
            response_status_code=None,
            response_headers_masked={},
            response_body=None,
        )


def run_connector_auth_test(payload: ConnectorAuthTestRequest, db: Session | None) -> ConnectorAuthTestResponse:
    """Validate connector authentication with a user-defined HTTP probe (not limited to GET /)."""

    source_config = _source_config_for_connector_auth_test(payload, db)

    if _is_database_query_connector_auth_config(source_config):
        flat = {
            "db_type": str(source_config.get("db_type") or "").strip().upper(),
            "host": str(source_config.get("host") or "").strip(),
            "port": int(source_config.get("port") or 0)
            or (5432 if str(source_config.get("db_type") or "").strip().upper() == "POSTGRESQL" else 3306),
            "database": str(source_config.get("database") or "").strip(),
            "username": str(source_config.get("username") or "").strip(),
            "password": str(source_config.get("password") or ""),
            "ssl_mode": str(source_config.get("ssl_mode") or "PREFER").strip().upper(),
            "connection_timeout_seconds": int(source_config.get("connection_timeout_seconds") or 15),
        }
        probe = probe_database_connection(flat)
        ok = bool(probe.get("ok"))
        et = None if ok else str(probe.get("error_type") or "database_probe_failed")
        return ConnectorAuthTestResponse(
            ok=ok,
            auth_type="DATABASE_QUERY",
            message=str(probe.get("message") or ("ok" if ok else "failed")),
            error_type=et,
            db_reachable=bool(probe.get("db_reachable")),
            db_auth_ok=bool(probe.get("db_auth_ok")),
            db_select_ok=ok,
        )

    if _is_s3_connector_auth_config(source_config):
        probe = probe_s3_source(source_config)
        ok = (
            bool(probe.get("s3_endpoint_reachable"))
            and bool(probe.get("s3_auth_ok"))
            and bool(probe.get("s3_bucket_exists"))
            and probe.get("s3_error_type") is None
        )
        msg = str(probe.get("s3_message") or ("S3 connectivity probe succeeded" if ok else "S3 connectivity probe failed"))
        et = None if ok else str(probe.get("s3_error_type") or "s3_probe_failed")
        return ConnectorAuthTestResponse(
            ok=ok,
            auth_type="S3_OBJECT_POLLING",
            message=msg,
            error_type=et,
            s3_endpoint_reachable=bool(probe.get("s3_endpoint_reachable")),
            s3_auth_ok=bool(probe.get("s3_auth_ok")),
            s3_bucket_exists=bool(probe.get("s3_bucket_exists")),
            s3_object_count_preview=int(probe.get("s3_object_count_preview") or 0),
            s3_sample_keys=list(probe.get("s3_sample_keys") or []),
        )

    if _is_remote_file_connector_auth_config(source_config):
        rf_sc = dict(payload.remote_file_stream_config or {})
        if not str(rf_sc.get("remote_directory") or "").strip():
            raise PreviewRequestError(
                400,
                {
                    "ok": False,
                    "error_type": "remote_directory_required",
                    "message": "remote_file_stream_config.remote_directory is required for REMOTE_FILE_POLLING connectivity test",
                },
            )
        cfg = _normalize_remote_file_source_for_runtime(dict(source_config))
        probe = probe_remote_file_source(cfg, rf_sc)
        ok = bool(probe.get("ok"))
        et = None if ok else str(probe.get("error_type") or "remote_file_probe_failed")
        pol = str(probe.get("host_key_status") or probe.get("host_key_policy") or "")
        return ConnectorAuthTestResponse(
            ok=ok,
            auth_type="REMOTE_FILE_POLLING",
            message=str(probe.get("message") or ("ok" if ok else "failed")),
            error_type=et,
            ssh_reachable=bool(probe.get("ssh_reachable")),
            ssh_auth_ok=bool(probe.get("ssh_auth_ok")),
            sftp_available=bool(probe.get("sftp_available")),
            remote_directory_accessible=bool(probe.get("remote_directory_accessible")),
            matched_file_count=int(probe.get("matched_file_count") or 0),
            sample_remote_paths=list(probe.get("sample_remote_paths") or []),
            host_key_status=pol or None,
        )

    base_url = str(_lookup(source_config, ["base_url", "host"], "")).strip()
    if not base_url:
        raise PreviewRequestError(
            400,
            {"ok": False, "error_type": "backend_error", "message": "source_config.base_url is required"},
        )

    method = str(payload.method or "GET").strip().upper()
    if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        raise PreviewRequestError(
            400,
            {"ok": False, "error_type": "invalid_method", "message": f"Unsupported HTTP method: {method}"},
        )

    target_url = _resolve_connector_auth_test_url(base_url, payload.test_path, payload.test_url)

    verify_ssl = bool(_lookup(source_config, ["verify_ssl"], True))
    proxy_url = _lookup(source_config, ["http_proxy", "proxy_url"], None)
    timeout_seconds = 45.0
    auth = _normalize_auth(source_config)
    auth_type = str(auth.get("auth_type") or "NO_AUTH").strip().upper()
    common_headers = dict(_lookup(source_config, ["headers", "common_headers"], {}) or {})
    extra_headers = {str(k): str(v) for k, v in (payload.extra_headers or {}).items()}
    query_params: dict[str, Any] = dict(payload.query_params or {})

    def merged_headers() -> dict[str, str]:
        h = {str(k): str(v) for k, v in common_headers.items()}
        h.update(extra_headers)
        return h

    json_body: Any | None = payload.json_body

    if auth_type == "VENDOR_JWT_EXCHANGE":
        return _vendor_jwt_connector_auth_test(
            auth=auth,
            base_url=base_url,
            method=method,
            target_url=target_url,
            verify_ssl=verify_ssl,
            proxy_url=str(proxy_url).strip() if proxy_url else None,
            timeout_seconds=timeout_seconds,
            common_headers=common_headers,
            extra_headers=extra_headers,
            query_params=query_params,
            json_body=json_body,
        )

    if auth_type == "SESSION_LOGIN":
        try:
            httpx_timeout = outbound_httpx_timeout(timeout_seconds)
            with httpx.Client(verify=verify_ssl, proxy=proxy_url, timeout=httpx_timeout) as client:
                login_resp, login_dbg = _perform_session_login(client, auth, base_url)
                cookie_names = [str(k) for k in client.cookies.keys()]
                session_cookie_obtained = len(cookie_names) > 0
                hdrs = merged_headers()
                hdrs = {k: v for k, v in hdrs.items() if str(k).lower() != "cookie"}
                try:
                    resp = client.request(
                        method,
                        target_url,
                        headers=hdrs,
                        params=query_params if query_params else None,
                        follow_redirects=False,
                        **httpx_body_kwargs(json_body, hdrs),
                    )
                except httpx.TimeoutException:
                    return _connector_auth_response_from_probe(
                        auth_type=auth_type,
                        method=method,
                        request_url=target_url,
                        headers_sent=hdrs,
                        response=None,
                        login_http_status=int(login_resp.status_code),
                        login_final_url=str(login_resp.url),
                        redirect_chain=_redirect_chain_urls(login_resp),
                        session_cookie_obtained=session_cookie_obtained,
                        cookie_names=cookie_names,
                        session_message=(
                            f"body_mode={login_dbg.body_mode}; "
                            f"follow_redirects={'true' if login_dbg.login_allow_redirects else 'false'}; "
                            f"login_http_reason={login_dbg.login_http_reason}; "
                            f"cookies={','.join(cookie_names) if cookie_names else 'none'}; "
                            f"final_url={login_dbg.login_final_url}"
                        ),
                        transport_error="Request timed out",
                        transport_error_type="timeout",
                        session_login_body_mode=login_dbg.body_mode,
                        session_login_follow_redirects=login_dbg.login_allow_redirects,
                        login_http_reason=login_dbg.login_http_reason,
                        session_login_body_preview=login_dbg.session_login_body_preview,
                        session_login_content_type=login_dbg.session_login_content_type,
                        session_login_request_encoding=login_dbg.session_login_request_encoding,
                        preflight_http_status=login_dbg.preflight_http_status,
                        preflight_final_url=login_dbg.preflight_final_url,
                        preflight_cookies=login_dbg.preflight_cookies,
                        extracted_variables=login_dbg.extracted_variables,
                        template_render_preview=login_dbg.template_render_preview,
                        computed_login_request_url=login_dbg.computed_login_request_url,
                        login_url_resolution_warnings=login_dbg.login_url_resolution_warnings,
                    )
                except httpx.ConnectError as exc:
                    lowered = str(exc).lower()
                    et = "ssl_error" if "ssl" in lowered or "certificate" in lowered else "network_error"
                    return _connector_auth_response_from_probe(
                        auth_type=auth_type,
                        method=method,
                        request_url=target_url,
                        headers_sent=hdrs,
                        response=None,
                        login_http_status=int(login_resp.status_code),
                        login_final_url=str(login_resp.url),
                        redirect_chain=_redirect_chain_urls(login_resp),
                        session_cookie_obtained=session_cookie_obtained,
                        cookie_names=cookie_names,
                        session_message=(
                            f"body_mode={login_dbg.body_mode}; "
                            f"follow_redirects={'true' if login_dbg.login_allow_redirects else 'false'}; "
                            f"login_http_reason={login_dbg.login_http_reason}; "
                            f"cookies={','.join(cookie_names) if cookie_names else 'none'}; "
                            f"final_url={login_dbg.login_final_url}"
                        ),
                        transport_error=str(exc),
                        transport_error_type=et,
                        session_login_body_mode=login_dbg.body_mode,
                        session_login_follow_redirects=login_dbg.login_allow_redirects,
                        login_http_reason=login_dbg.login_http_reason,
                        session_login_body_preview=login_dbg.session_login_body_preview,
                        session_login_content_type=login_dbg.session_login_content_type,
                        session_login_request_encoding=login_dbg.session_login_request_encoding,
                        preflight_http_status=login_dbg.preflight_http_status,
                        preflight_final_url=login_dbg.preflight_final_url,
                        preflight_cookies=login_dbg.preflight_cookies,
                        extracted_variables=login_dbg.extracted_variables,
                        template_render_preview=login_dbg.template_render_preview,
                        computed_login_request_url=login_dbg.computed_login_request_url,
                        login_url_resolution_warnings=login_dbg.login_url_resolution_warnings,
                    )
                return _connector_auth_response_from_probe(
                    auth_type=auth_type,
                    method=method,
                    request_url=target_url,
                    headers_sent=hdrs,
                    response=resp,
                    login_http_status=int(login_resp.status_code),
                    login_final_url=str(login_resp.url),
                    redirect_chain=_redirect_chain_urls(login_resp),
                    session_cookie_obtained=session_cookie_obtained,
                    cookie_names=cookie_names,
                    session_message=(
                        f"body_mode={login_dbg.body_mode}; "
                        f"follow_redirects={'true' if login_dbg.login_allow_redirects else 'false'}; "
                        f"login_http_reason={login_dbg.login_http_reason}; "
                        f"cookies={','.join(cookie_names) if cookie_names else 'none'}; "
                        f"final_url={login_dbg.login_final_url}"
                    ),
                    session_login_body_mode=login_dbg.body_mode,
                    session_login_follow_redirects=login_dbg.login_allow_redirects,
                    login_http_reason=login_dbg.login_http_reason,
                    session_login_body_preview=login_dbg.session_login_body_preview,
                    session_login_content_type=login_dbg.session_login_content_type,
                    session_login_request_encoding=login_dbg.session_login_request_encoding,
                    preflight_http_status=login_dbg.preflight_http_status,
                    preflight_final_url=login_dbg.preflight_final_url,
                    preflight_cookies=login_dbg.preflight_cookies,
                    extracted_variables=login_dbg.extracted_variables,
                    template_render_preview=login_dbg.template_render_preview,
                    computed_login_request_url=login_dbg.computed_login_request_url,
                    login_url_resolution_warnings=login_dbg.login_url_resolution_warnings,
                )
        except PreviewRequestError as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            return ConnectorAuthTestResponse(
                ok=False,
                auth_type=auth_type,
                message=str(detail.get("message") or exc),
                error_type=str(detail.get("error_type") or "session_login_failed"),
                session_cookie_obtained=False,
                request_method=method,
                request_url=target_url,
                request_headers_masked=mask_http_headers(merged_headers()),
                login_http_status=int(detail["login_http_status"])
                if detail.get("login_http_status") is not None
                else None,
                login_final_url=str(detail.get("login_final_url")) if detail.get("login_final_url") else None,
                redirect_chain=list(detail.get("redirect_chain") or []),
                session_login_body_mode=str(detail.get("session_login_body_mode")) if detail.get("session_login_body_mode") else None,
                session_login_follow_redirects=detail.get("session_login_follow_redirects"),
                login_failure_reason=str(detail.get("login_failure_reason") or detail.get("message") or ""),
                login_http_reason=str(detail.get("login_http_reason") or detail.get("message") or ""),
                session_login_body_preview=str(detail.get("session_login_body_preview"))
                if detail.get("session_login_body_preview")
                else None,
                session_login_content_type=str(detail.get("session_login_content_type"))
                if detail.get("session_login_content_type")
                else None,
                session_login_request_encoding=str(detail.get("session_login_request_encoding"))
                if detail.get("session_login_request_encoding")
                else None,
                preflight_http_status=int(detail["preflight_http_status"])
                if detail.get("preflight_http_status") is not None
                else None,
                preflight_final_url=str(detail.get("preflight_final_url")) if detail.get("preflight_final_url") else None,
                preflight_cookies=dict(detail["preflight_cookies"]) if isinstance(detail.get("preflight_cookies"), dict) else None,
                extracted_variables=dict(detail["extracted_variables"]) if isinstance(detail.get("extracted_variables"), dict) else None,
                template_render_preview=str(detail.get("template_render_preview"))
                if detail.get("template_render_preview")
                else None,
                computed_login_request_url=str(detail.get("computed_login_request_url"))
                if detail.get("computed_login_request_url")
                else None,
                login_url_resolution_warnings=list(detail["login_url_resolution_warnings"])
                if isinstance(detail.get("login_url_resolution_warnings"), list)
                else [],
            )

    headers = merged_headers()
    params = dict(query_params)
    if auth_type not in {"", "NO_AUTH"}:
        try:
            headers, params = _apply_auth_to_request(auth, headers, params, verify_ssl, proxy_url, timeout_seconds, base_url)
        except PreviewRequestError as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            return ConnectorAuthTestResponse(
                ok=False,
                auth_type=auth_type,
                message=str(detail.get("message") or exc),
                error_type=str(detail.get("error_type") or detail.get("code") or "auth_failed"),
                request_method=method,
                request_url=target_url,
                request_headers_masked=mask_http_headers(headers),
            )
    if auth_type in {"", "NO_AUTH"}:
        auth_type = auth_type or "NO_AUTH"

    try:
        httpx_timeout = outbound_httpx_timeout(timeout_seconds)
        with httpx.Client(verify=verify_ssl, proxy=proxy_url, timeout=httpx_timeout) as client:
            resp = client.request(
                method,
                target_url,
                headers=headers,
                params=params if params else None,
                follow_redirects=False,
                **httpx_body_kwargs(json_body, headers),
            )
    except httpx.TimeoutException:
        return _connector_auth_response_from_probe(
            auth_type=auth_type,
            method=method,
            request_url=target_url,
            headers_sent=headers,
            response=None,
            transport_error="Request timed out",
            transport_error_type="timeout",
        )
    except httpx.ConnectError as exc:
        lowered = str(exc).lower()
        et = "ssl_error" if "ssl" in lowered or "certificate" in lowered else "network_error"
        return _connector_auth_response_from_probe(
            auth_type=auth_type,
            method=method,
            request_url=target_url,
            headers_sent=headers,
            response=None,
            transport_error=str(exc),
            transport_error_type=et,
        )

    result = _connector_auth_response_from_probe(
        auth_type=auth_type,
        method=method,
        request_url=target_url,
        headers_sent=headers,
        response=resp,
    )
    if auth_type == "NO_AUTH":
        note = "No authentication configured; only common and extra headers are sent."
        merged_msg = f"{note} {result.message or ''}".strip()
        return result.model_copy(update={"message": merged_msg})
    return result


def _classify_target_http_failure(resp: httpx.Response) -> tuple[str, str]:
    code = int(resp.status_code)
    if code == 401:
        return ("target_401_unauthorized", "Target API returned 401 Unauthorized.")
    if code == 403:
        return ("target_403_forbidden", "Target API returned 403 Forbidden.")
    if code in (301, 302, 303, 307, 308) and _target_suggests_login_redirect(resp):
        return ("target_redirect_to_login", "Target redirected to a login/auth URL — session cookies may be missing or expired.")
    if code in (301, 302, 303, 307, 308):
        return ("target_http_error", f"Target API returned redirect HTTP {code}.")
    if code == 404:
        return ("target_404_not_found", "Target API returned 404 Not Found.")
    return ("target_http_error", f"Target API returned HTTP {code}.")


def _auth_config_for_lab(source_flat: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    from app.connectors.auth_execute import normalize_auth_type

    m = dict(source_flat or {})
    if isinstance(m.get("auth"), dict):
        m = {**m, **m["auth"]}
    strip = {
        "base_url",
        "host",
        "verify_ssl",
        "http_proxy",
        "proxy_url",
        "headers",
        "common_headers",
        "connector_type",
        "auth",
        "source_type",
    }
    auth_cfg = {k: v for k, v in m.items() if k not in strip}
    if auth_cfg.get("auth_type") is None or str(auth_cfg.get("auth_type")).strip() == "":
        auth_cfg["auth_type"] = "no_auth"
    auth_type = normalize_auth_type(str(auth_cfg.get("auth_type")))
    return auth_type, auth_cfg


def _stream_api_steps_from_lab(lab_steps: list[Any]) -> list[HttpApiTestStep]:
    rename = {"resource_request": "target_request", "session_cookie": "session_acquired"}
    return [
        HttpApiTestStep(
            name=rename.get(s.name, s.name),
            success=bool(s.success),
            status_code=s.status_code,
            message=str(s.message or ""),
        )
        for s in lab_steps
    ]


def _map_lab_failure_to_stream_code(lab: Any) -> str:
    code = str(lab.error_code or "")
    at = str(lab.auth_type or "")
    if code == "LOGIN_HTTP_ERROR":
        return "session_login_failed"
    if code == "LOGIN_COOKIE_MISSING":
        return "session_login_failed"
    if code == "TOKEN_HTTP_ERROR":
        if at == "jwt_refresh_token":
            return "jwt_refresh_failed"
        if at == "oauth2_client_credentials":
            return "oauth2_token_failed"
        if at == "vendor_jwt_exchange":
            return "vendor_jwt_exchange_failed"
        return "token_request_failed"
    if code == "TOKEN_MISSING":
        return "access_token_not_found"
    if code == "TOKEN_EXTRACTION_FAILED":
        return "token_extraction_failed"
    if code == "vendor_jwt_exchange_failed":
        return "vendor_jwt_exchange_failed"
    if code == "TOKEN_PARSE_ERROR":
        if at == "jwt_refresh_token":
            return "jwt_refresh_failed"
        if at == "vendor_jwt_exchange":
            return "vendor_jwt_exchange_failed"
        return "oauth2_token_failed"
    if code == "CONFIG_INVALID":
        return "target_http_error"
    if code == "NETWORK_ERROR":
        msg = (str(lab.message or "")).lower()
        if "timeout" in msg or "timed out" in msg:
            return "timeout"
        if "ssl" in msg or "certificate" in msg or "tls" in msg:
            return "ssl_error"
        return "connection_error"
    if code == "RESOURCE_HTTP_ERROR":
        sc = int(lab.status_code or 0)
        if sc == 401:
            return "target_401_unauthorized"
        if sc == 403:
            return "target_403_forbidden"
        if sc == 404:
            return "target_404_not_found"
        if sc in (301, 302, 303, 307, 308):
            return "target_redirect_to_login"
        return "target_http_error"
    if code == "UNSUPPORTED_AUTH_TYPE":
        return "target_http_error"
    return "target_http_error"


def _session_not_acquired(lab: Any) -> bool:
    for s in lab.steps:
        if s.name == "session_cookie" and not s.success:
            return True
    return False


def run_http_api_test(payload: HttpApiTestRequest, db: Session | None = None, *, api_origin: str | None = None) -> HttpApiTestResponse:
    stream_config = dict(payload.stream_config or {})

    if payload.connector_id is not None:
        if db is None:
            raise PreviewRequestError(
                400,
                {"ok": False, "error_type": "backend_error", "message": "connector_id requires database session"},
            )
        loaded = _load_source_config_for_connector(db, int(payload.connector_id))
        if loaded is None:
            raise PreviewRequestError(
                404,
                {
                    "ok": False,
                    "error_type": "connector_not_found",
                    "message": f"No Source row found for connector_id={payload.connector_id}",
                },
            )
        source_config = loaded
    else:
        source_config = dict(payload.source_config or {})

    if _is_database_query_connector_auth_config(source_config):
        query = str(_lookup(stream_config, ["query"], "")).strip()
        if not query:
            raise PreviewRequestError(
                400,
                {"code": "QUERY_REQUIRED", "message": "stream_config.query is required for DATABASE_QUERY sample fetch"},
            )
        started = time.perf_counter()
        try:
            rows = preview_limited_rows(source_config=source_config, stream_config=stream_config, limit=25)
        except SourceFetchError as exc:
            raise PreviewRequestError(
                400,
                {
                    "ok": False,
                    "error_type": "database_query_failed",
                    "message": str(exc),
                    "error_code": "database_query_failed",
                },
            ) from exc
        latency_ms = int((time.perf_counter() - started) * 1000)
        host = str(source_config.get("host") or "")
        dbn = str(source_config.get("database") or "")
        dt = str(source_config.get("db_type") or "DATABASE").lower()
        meta_url = f"{dt}://{host}/{dbn}"
        timeout_seconds = float(_lookup(stream_config, ["query_timeout_seconds"], 30) or 30)
        raw_out = json.dumps(rows, default=str, ensure_ascii=False)
        if len(raw_out) > 150_000:
            raw_out = raw_out[:150_000] + "\n...truncated..."
        return HttpApiTestResponse(
            ok=True,
            request=HttpApiTestRequestMeta(method="DATABASE_QUERY", url=meta_url, headers_masked={}),
            actual_request_sent=HttpApiTestActualRequestMeta(
                method="DATABASE_QUERY",
                url=meta_url,
                endpoint=None,
                query_params={},
                headers_masked={},
                json_body_masked=None,
                timeout_seconds=timeout_seconds,
            ),
            response=HttpApiTestResponseMeta(
                status_code=200,
                latency_ms=latency_ms,
                headers={},
                raw_body=raw_out,
                parsed_json=rows,
                content_type="application/json",
            ),
            database_query_row_count=len(rows),
            database_query_sample_rows=rows,
        )

    if _is_remote_file_connector_auth_config(source_config):
        rd = str(_lookup(stream_config, ["remote_directory"], "")).strip()
        if not rd:
            raise PreviewRequestError(
                400,
                {"code": "REMOTE_DIRECTORY_REQUIRED", "message": "stream_config.remote_directory is required"},
            )
        from app.sources.adapters.remote_file_polling import RemoteFilePollingAdapter, normalize_remote_file_transfer_protocol

        cfg = _normalize_remote_file_source_for_runtime(dict(source_config))
        sc = dict(stream_config)
        mf = int(sc.get("max_files_per_run") or 5)
        sc["max_files_per_run"] = max(1, min(mf, 10))
        started = time.perf_counter()
        try:
            events = RemoteFilePollingAdapter().fetch(cfg, sc, payload.checkpoint)
        except SourceFetchError as exc:
            raise PreviewRequestError(
                400,
                {
                    "ok": False,
                    "error_type": "remote_file_fetch_failed",
                    "message": str(exc),
                    "error_code": "remote_file_fetch_failed",
                },
            ) from exc
        latency_ms = int((time.perf_counter() - started) * 1000)
        host = str(cfg.get("host") or "")
        proto = normalize_remote_file_transfer_protocol(str(cfg.get("protocol") or "sftp"))
        meta_url = f"{proto}://{host}/{rd.lstrip('/')}"
        cap = events[:100]
        raw_out = json.dumps(cap, default=str, ensure_ascii=False)
        if len(raw_out) > 150_000:
            raw_out = raw_out[:150_000] + "\n...truncated..."
        return HttpApiTestResponse(
            ok=True,
            request=HttpApiTestRequestMeta(method="REMOTE_FILE_POLLING", url=meta_url, headers_masked={}),
            actual_request_sent=HttpApiTestActualRequestMeta(
                method="REMOTE_FILE_POLLING",
                url=meta_url,
                endpoint=None,
                query_params={},
                headers_masked={},
                json_body_masked=None,
                timeout_seconds=float(cfg.get("connection_timeout_seconds") or 30),
            ),
            response=HttpApiTestResponseMeta(
                status_code=200,
                latency_ms=latency_ms,
                headers={},
                raw_body=raw_out,
                parsed_json=cap,
                content_type="application/json",
            ),
            remote_file_event_count=len(events),
        )

    if _is_s3_connector_auth_config(source_config):
        from app.sources.adapters.s3_object_polling import S3ObjectPollingAdapter

        sc = dict(stream_config)
        try:
            max_objects = int(sc.get("max_objects_per_run") or 5)
        except (TypeError, ValueError):
            max_objects = 5
        sc["max_objects_per_run"] = max(1, min(max_objects, 10))
        started = time.perf_counter()
        try:
            events = S3ObjectPollingAdapter().fetch(dict(source_config), sc, payload.checkpoint)
        except SourceFetchError as exc:
            raise PreviewRequestError(
                400,
                {
                    "ok": False,
                    "error_type": "s3_sample_fetch_failed",
                    "message": str(exc),
                    "error_code": "s3_sample_fetch_failed",
                },
            ) from exc
        if not isinstance(events, list):
            events = []
        latency_ms = int((time.perf_counter() - started) * 1000)
        bucket = str(source_config.get("bucket") or "")
        prefix = str(source_config.get("prefix") or "").strip("/")
        meta_url = f"s3://{bucket}/{prefix}".rstrip("/") if bucket else str(source_config.get("endpoint_url") or "s3")
        cap = events[:100]
        raw_out = json.dumps(cap, default=str, ensure_ascii=False)
        if len(raw_out) > 150_000:
            raw_out = raw_out[:150_000] + "\n...truncated..."
        sample_keys: list[str] = []
        seen_keys: set[str] = set()
        for ev in cap:
            if not isinstance(ev, dict):
                continue
            key = str(ev.get("s3_key") or "").strip()
            if key and key not in seen_keys:
                seen_keys.add(key)
                sample_keys.append(key)
        return HttpApiTestResponse(
            ok=True,
            request=HttpApiTestRequestMeta(method="S3_OBJECT_POLLING", url=meta_url, headers_masked={}),
            actual_request_sent=HttpApiTestActualRequestMeta(
                method="S3_OBJECT_POLLING",
                url=meta_url,
                endpoint=None,
                query_params={},
                headers_masked={},
                json_body_masked=None,
                timeout_seconds=30.0,
            ),
            response=HttpApiTestResponseMeta(
                status_code=200,
                latency_ms=latency_ms,
                headers={},
                raw_body=raw_out,
                parsed_json=cap,
                content_type="application/json",
            ),
            s3_event_count=len(events),
            s3_sample_keys=sample_keys,
        )

    endpoint = str(_lookup(stream_config, ["endpoint"], "")).strip()
    method = str(_lookup(stream_config, ["method"], "GET")).upper()
    if not endpoint:
        raise PreviewRequestError(400, {"code": "ENDPOINT_REQUIRED", "message": "stream_config.endpoint is required"})

    base_url = str(_lookup(source_config, ["base_url", "host"], "")).strip()
    if not base_url:
        raise PreviewRequestError(400, {"code": "BASE_URL_REQUIRED", "message": "source_config.base_url is required"})

    connector_hdr_only = dict(_lookup(source_config, ["headers", "common_headers"], {}) or {})
    pre_request_url = join_base_url_endpoint(base_url, endpoint)

    def _invalid_json_body_hook(exc: json.JSONDecodeError) -> None:
        raise PreviewRequestError(
            400,
            {
                "ok": False,
                "error_type": "invalid_json_body",
                "message": f"Invalid JSON syntax in request body (line {exc.lineno}, column {exc.colno}): {exc.msg}",
                "json_line": exc.lineno,
                "json_column": exc.colno,
                "request": {"method": method, "url": pre_request_url, "headers_masked": mask_secrets(connector_hdr_only)},
            },
        )

    # Sample fetch in wizard/edit should never advance from persisted runtime checkpoint.
    # When no explicit checkpoint is provided, use a neutral baseline so
    # `{{checkpoint.*}}` templates resolve deterministically without inheriting live cursor state.
    api_test_checkpoint = payload.checkpoint
    if payload.fetch_sample and not isinstance(api_test_checkpoint, dict):
        api_test_checkpoint = {
            "cursor": "0",
            "value": "0",
            "last_seen": "0",
            "last_timestamp": "0",
            "last_timestamp_ms": "0",
            "last_event_id": "",
            "next_cursor": "0",
        }

    plan = build_shared_http_request(
        source_config=source_config,
        stream_config=stream_config,
        mode="api_test",
        api_test_checkpoint=api_test_checkpoint,
        invalid_json_body_exc_factory=_invalid_json_body_hook,
    )

    request_url = plan.url
    method = plan.method
    params = plan.params
    merged_headers = merge_shared_header_layers(plan.connector_headers, plan.stream_headers)

    verify_ssl = bool(_lookup(source_config, ["verify_ssl"], True))
    proxy_url = _lookup(source_config, ["http_proxy", "proxy_url"], None)
    timeout_seconds = float(
        _lookup(stream_config, ["timeout", "timeout_seconds"], _lookup(source_config, ["timeout", "timeout_seconds"], 30)),
    )

    auth_type, auth_cfg = _auth_config_for_lab(source_config)
    origin = (api_origin or "").rstrip("/") or "http://127.0.0.1:8000"

    stream_body = plan.normalized_json_body
    actual_request_sent = HttpApiTestActualRequestMeta(
        method=method,
        url=request_url,
        endpoint=endpoint,
        query_params=mask_secrets(params) if isinstance(params, dict) else {},
        headers_masked=mask_http_headers(merged_headers),
        json_body_masked=mask_secrets(stream_body) if stream_body is not None else None,
        timeout_seconds=timeout_seconds,
    )

    from app.connectors.auth_execute import run_stream_api_authenticated_request

    started = time.perf_counter()
    try:
        lab = run_stream_api_authenticated_request(
            api_origin=origin,
            connector_base_url=base_url,
            verify_ssl=verify_ssl,
            proxy=str(proxy_url).strip() if proxy_url else None,
            timeout=timeout_seconds,
            auth_type=auth_type,
            auth_config=auth_cfg,
            target_method=method,
            target_url=request_url,
            target_headers=merged_headers,
            target_params=params,
            target_body=stream_body,
        )
    except PreviewRequestError:
        raise
    except Exception as exc:
        raise PreviewRequestError(
            400,
            {
                "ok": False,
                "error_type": "connection_error",
                "error_code": "connection_error",
                "message": str(exc),
                "request": {"method": method, "url": request_url, "headers_masked": mask_secrets(merged_headers)},
                "actual_request_sent": actual_request_sent.model_dump(),
            },
        ) from exc

    latency_ms = int((time.perf_counter() - started) * 1000)
    steps = _stream_api_steps_from_lab(lab.steps)
    effective_actual_request = actual_request_sent.model_copy(
        update={
            "url": str(lab.effective_request.url or request_url),
            "headers_masked": dict(lab.effective_request.headers),
        }
    )

    if lab.success:
        raw_preview_full = lab.raw_body_preview or ""
        body_truncated = len(raw_preview_full) >= 79900
        resp_headers = dict(lab.target_response_headers or {})
        content_type = str(resp_headers.get("content-type") or "").lower() or None
        parsed_out = mask_secrets(lab.parsed_json_preview) if lab.parsed_json_preview is not None else None
        trimmed = raw_preview_full.strip()

        hint_path = str(_lookup(stream_config, ["event_array_path"], "") or "").strip() or None
        analysis_model = HttpApiTestAnalysis.model_validate(
            build_http_api_test_analysis_dict(
                parsed_out,
                raw_body=raw_preview_full,
                raw_body_length=len(raw_preview_full.encode("utf-8", errors="replace")),
                body_truncated=body_truncated,
                content_type=content_type,
                event_array_hint=hint_path,
            )
        )

        pe = analysis_model.preview_error
        if pe in ("invalid_json_response", "unsupported_content_type", "response_too_large"):
            pe_messages = {
                "invalid_json_response": "Response looks like JSON but could not be parsed.",
                "unsupported_content_type": "Response body is not JSON; Fetch Sample Data preview requires JSON.",
                "response_too_large": "Response body is too large to analyze safely in preview.",
            }
            raise PreviewRequestError(
                400,
                {
                    "ok": False,
                    "error_type": pe,
                    "error_code": pe,
                    "message": pe_messages.get(pe, pe),
                    "steps": [s.model_dump() for s in steps],
                    "request": {
                        "method": method,
                        "url": str(lab.effective_request.url or request_url),
                        "headers_masked": mask_secrets(merged_headers),
                    },
                    "actual_request_sent": effective_actual_request.model_dump(),
                },
            )

        max_raw_return = 150_000
        if parsed_out is not None:
            try:
                ser_raw = json.dumps(parsed_out, ensure_ascii=False)
            except (TypeError, ValueError):
                ser_raw = trimmed[:8000]
        else:
            ser_raw = trimmed
        raw_out = ser_raw if len(ser_raw) <= max_raw_return else f"{ser_raw[:max_raw_return]}\n...truncated..."

        return HttpApiTestResponse(
            ok=True,
            request=HttpApiTestRequestMeta(
                method=method,
                url=str(lab.effective_request.url or request_url),
                headers_masked=dict(lab.effective_request.headers),
            ),
            actual_request_sent=effective_actual_request,
            response=HttpApiTestResponseMeta(
                status_code=int(lab.status_code or 200),
                latency_ms=latency_ms,
                headers=resp_headers,
                raw_body=raw_out,
                parsed_json=parsed_out,
                content_type=content_type,
            ),
            steps=steps,
            analysis=analysis_model,
        )

    err_code = _map_lab_failure_to_stream_code(lab)
    if _session_not_acquired(lab) and not lab.success and lab.error_code == "RESOURCE_HTTP_ERROR":
        err_code = "session_not_acquired"

    eff = lab.effective_request
    sample = lab.response_sample
    raw_hint = ""
    if isinstance(sample, dict) and "_truncated_text" in sample:
        raw_hint = str(sample.get("_truncated_text") or "")[:8000]
    elif sample is not None:
        try:
            raw_hint = json.dumps(mask_secrets(sample), ensure_ascii=False)[:8000]
        except Exception:
            raw_hint = str(sample)[:8000]

    raise PreviewRequestError(
        400,
        {
            "ok": False,
            "error_type": err_code,
            "error_code": err_code,
            "message": lab.message or err_code,
            "steps": [s.model_dump() for s in steps],
            "response_sample": sample,
            "effective_request": eff.model_dump(),
            "request": {"method": eff.method, "url": eff.url or request_url, "headers_masked": dict(eff.headers)},
            "actual_request_sent": effective_actual_request.model_dump(),
            "target_status_code": lab.status_code,
            "target_response_body": raw_hint,
            "hint": "Check connector auth, endpoint, and stream headers.",
        },
    )


def run_mapping_preview(payload: MappingPreviewRequest) -> MappingPreviewResponse:
    try:
        events = extract_events(
            payload.raw_response, payload.event_array_path, payload.event_root_path
        )
    except (MappingError, ParserError) as exc:
        raise PreviewRequestError(400, {"code": "EVENT_EXTRACTION_FAILED", "message": str(exc)}) from exc

    try:
        mapped_events = apply_mappings(events, payload.field_mappings)
    except MappingError as exc:
        raise PreviewRequestError(400, {"code": "MAPPING_FAILED", "message": str(exc)}) from exc

    try:
        preview_events = apply_enrichments(mapped_events, payload.enrichment, payload.override_policy)
    except EnrichmentError as exc:
        raise PreviewRequestError(400, {"code": "ENRICHMENT_FAILED", "message": str(exc)}) from exc

    return MappingPreviewResponse(
        input_event_count=len(events),
        mapped_event_count=len(mapped_events),
        preview_events=preview_events,
    )


def _json_value_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def extract_mapping_json_paths(payload: MappingJsonPathsRequest) -> MappingJsonPathsResponse:
    max_depth = payload.max_depth if payload.max_depth is not None else 8
    max_paths = payload.max_paths if payload.max_paths is not None else 500
    out: list[MappingJsonPathItem] = []

    def _walk(value: Any, path: str, depth: int, under_array: bool) -> None:
        if depth > max_depth:
            return
        if isinstance(value, dict):
            if not payload.scalars_only:
                out.append(
                    MappingJsonPathItem(
                        path=path,
                        value_type="object",
                        sample_value=None,
                        is_array=under_array,
                        depth=depth,
                    )
                )
            for k, v in value.items():
                _walk(v, f"{path}.{k}", depth + 1, under_array)
            return

        if isinstance(value, list):
            if not payload.scalars_only:
                out.append(
                    MappingJsonPathItem(
                        path=path,
                        value_type="array",
                        sample_value=None,
                        is_array=under_array,
                        depth=depth,
                    )
                )
            if value:
                _walk(value[0], f"{path}[0]", depth + 1, True)
            return

        out.append(
            MappingJsonPathItem(
                path=path,
                value_type=_json_value_type(value),
                sample_value=value,
                is_array=under_array,
                depth=depth,
            )
        )

    if isinstance(payload.payload, dict):
        for k, v in payload.payload.items():
            _walk(v, f"$.{k}", 1, False)
    elif isinstance(payload.payload, list):
        if payload.payload:
            _walk(payload.payload[0], "$[0]", 1, True)

    total = len(out)
    return MappingJsonPathsResponse(total=total, paths=out[:max_paths])


def _run_mapping_draft_core(
    payload_obj: dict[str, Any] | list[Any],
    event_array_path: str | None,
    event_root_path: str | None,
    field_mappings: dict[str, Any],
    max_events: int,
) -> tuple[int, list[dict[str, Any]], list[MappingDraftPreviewMissingFieldItem]]:
    try:
        events = extract_events(payload_obj, event_array_path, event_root_path)
    except (MappingError, ParserError) as exc:
        raise PreviewRequestError(400, {"code": "EVENT_EXTRACTION_FAILED", "message": str(exc)}) from exc

    preview_events = events[:max_events]
    basic_mappings = extract_basic_jsonpath_mappings(field_mappings)
    pass_unmapped = should_pass_through_unmapped(field_mappings)
    try:
        compiled = compile_mappings(basic_mappings)
        mapped_events = apply_compiled_mappings(
            preview_events,
            compiled,
            source_json_paths=tuple(basic_mappings.values()) if pass_unmapped else None,
        )
    except MappingError as exc:
        raise PreviewRequestError(400, {"code": "MAPPING_FAILED", "message": str(exc)}) from exc

    missing_fields: list[MappingDraftPreviewMissingFieldItem] = []
    for idx, event in enumerate(preview_events):
        for output_field, json_path in basic_mappings.items():
            compiled_expr = compiled.get(output_field)
            if compiled_expr is None:
                continue
            if not compiled_expr.find(event):
                missing_fields.append(
                    MappingDraftPreviewMissingFieldItem(
                        output_field=output_field,
                        json_path=json_path,
                        event_index=idx,
                    )
                )

    return len(events), mapped_events, missing_fields


def run_mapping_draft_preview(payload: MappingDraftPreviewRequest) -> MappingDraftPreviewResponse:
    input_count, mapped_events, missing_fields = _run_mapping_draft_core(
        payload.payload,
        payload.event_array_path,
        payload.event_root_path,
        payload.field_mappings,
        payload.max_events,
    )
    return MappingDraftPreviewResponse(
        input_event_count=input_count,
        preview_event_count=len(mapped_events),
        mapped_events=mapped_events,
        missing_fields=missing_fields,
        message="Mapping draft preview generated successfully",
    )


def run_mapping_validate(payload: MappingValidateRequest) -> MappingValidateResponse:
    """Return operational mapping validation warnings without persisting config."""

    from app.parsers.extraction_paths import validate_mapping_paths_for_extraction

    warnings: list[MappingValidationWarning] = []
    field_mappings = dict(payload.field_mappings or {})

    for violation in validate_mapping_paths_for_extraction(
        field_mappings,
        payload.event_array_path,
        payload.event_root_path,
    ):
        warnings.append(
            MappingValidationWarning(
                code=str(violation.get("code") or "ENVELOPE_RELATIVE_MAPPING_PATH"),
                severity="error",
                message=str(violation.get("message") or "Invalid mapping path"),
                output_field=violation.get("output_field"),
                json_path=violation.get("json_path"),
            )
        )

    seen_output: dict[str, str] = {}
    for output_field, json_path in field_mappings.items():
        out_trim = str(output_field).strip()
        path_trim = str(json_path).strip()
        if not out_trim:
            warnings.append(
                MappingValidationWarning(
                    code="EMPTY_OUTPUT_FIELD",
                    severity="warning",
                    message="Mapping row has an empty destination field name.",
                    output_field=output_field or None,
                    json_path=path_trim or None,
                )
            )
        if not path_trim:
            warnings.append(
                MappingValidationWarning(
                    code="EMPTY_SOURCE_PATH",
                    severity="warning",
                    message="Mapping row has an empty source JSONPath.",
                    output_field=out_trim or None,
                    json_path=json_path or None,
                )
            )
        if out_trim:
            key = out_trim.lower()
            if key in seen_output:
                warnings.append(
                    MappingValidationWarning(
                        code="DUPLICATE_OUTPUT_FIELD",
                        severity="warning",
                        message=(
                            f"Destination field {out_trim!r} is mapped more than once "
                            f"(also used by {seen_output[key]!r})."
                        ),
                        output_field=out_trim,
                    )
                )
            else:
                seen_output[key] = out_trim
        if path_trim:
            try:
                compile_mappings({out_trim or output_field: path_trim})
            except MappingError as exc:
                warnings.append(
                    MappingValidationWarning(
                        code="INVALID_JSONPATH",
                        severity="error",
                        message=str(exc),
                        output_field=out_trim or output_field,
                        json_path=path_trim,
                    )
                )

    if payload.payload is None:
        if field_mappings:
            warnings.append(
                MappingValidationWarning(
                    code="MISSING_PREVIEW_PAYLOAD",
                    severity="warning",
                    message="Load a source sample before validating extraction against live payload shape.",
                )
            )
        ok = not any(w.severity == "error" for w in warnings)
        return MappingValidateResponse(ok=ok, warnings=warnings)

    try:
        events = extract_events(payload.payload, payload.event_array_path, payload.event_root_path)
    except (MappingError, ParserError) as exc:
        warnings.append(
            MappingValidationWarning(
                code="EVENT_EXTRACTION_FAILED",
                severity="error",
                message=str(exc),
            )
        )
        return MappingValidateResponse(ok=False, warnings=warnings)

    if not events and field_mappings:
        arr = (payload.event_array_path or "").strip() or "$"
        warnings.append(
            MappingValidationWarning(
                code="EVENT_ARRAY_PATH_MISMATCH",
                severity="error",
                message=(
                    f"Event extraction returned 0 events for event_array_path={arr!r}. "
                    "Adjust event array path or use a sample where the array exists."
                ),
            )
        )

    if field_mappings and events:
        try:
            _, _, missing_fields = _run_mapping_draft_core(
                payload.payload,
                payload.event_array_path,
                payload.event_root_path,
                field_mappings,
                min(5, len(events)),
            )
        except PreviewRequestError as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            code = str(detail.get("code", "MAPPING_PREVIEW_FAILED"))
            message = str(detail.get("message", code))
            severity = "error" if code in {"EVENT_EXTRACTION_FAILED", "MAPPING_FAILED"} else "warning"
            warnings.append(MappingValidationWarning(code=code, severity=severity, message=message))
        else:
            for item in missing_fields:
                warnings.append(
                    MappingValidationWarning(
                        code="EMPTY_EXTRACTION",
                        severity="warning",
                        message=(
                            f"No value extracted for {item.output_field!r} at {item.json_path!r} "
                            f"on event index {item.event_index}."
                        ),
                        output_field=item.output_field,
                        json_path=item.json_path,
                        event_index=item.event_index,
                    )
                )

    ok = not any(w.severity == "error" for w in warnings)
    return MappingValidateResponse(ok=ok, warnings=warnings)


def _normalize_checkpoint_path(path: str | None) -> str:
    raw = (path or "").strip()
    if not raw:
        return ""
    if raw.startswith("$."):
        return raw
    if raw.startswith("$"):
        tail = raw[1:].lstrip(".")
        return f"$.{tail}" if tail else ""
    return f"$.{raw.lstrip('.')}"


def run_extraction_validate(payload: ExtractionValidateRequest) -> ExtractionValidateResponse:
    """Validate custom extraction paths against one sample payload (read-only)."""

    warnings: list[ExtractionValidationIssue] = []
    errors: list[ExtractionValidationIssue] = []

    normalized_event_array_path = normalize_event_array_path(payload.event_array_path)
    normalized_event_root_path = normalize_event_root_path(payload.event_root_path)
    normalized_checkpoint_path = _normalize_checkpoint_path(payload.checkpoint_path)

    raw_event_array_path = (payload.event_array_path or "").strip()
    if raw_event_array_path and is_preview_only_array_path(raw_event_array_path):
        warnings.append(
            ExtractionValidationIssue(
                code="PREVIEW_INDEX_NORMALIZED",
                severity="warning",
                message=(
                    f"Event array path {raw_event_array_path!r} included preview index; "
                    f"normalized to {normalized_event_array_path!r} for persistence."
                ),
            )
        )

    try:
        events = extract_events(
            payload.payload,
            normalized_event_array_path or None,
            normalized_event_root_path or None,
        )
    except (MappingError, ParserError) as exc:
        errors.append(
            ExtractionValidationIssue(
                code="EVENT_EXTRACTION_FAILED",
                severity="error",
                message=str(exc),
            )
        )
        return ExtractionValidateResponse(
            ok=False,
            normalized_event_array_path=normalized_event_array_path or None,
            normalized_event_root_path=normalized_event_root_path or None,
            normalized_checkpoint_path=normalized_checkpoint_path or None,
            event_count=0,
            preview_events=[],
            checkpoint_values_preview=[],
            warnings=warnings,
            errors=errors,
        )

    preview_events = events[: payload.max_preview_events]
    if not events:
        warnings.append(
            ExtractionValidationIssue(
                code="EVENT_ARRAY_PATH_MISMATCH",
                severity="warning",
                message=(
                    "Event extraction returned 0 events for the selected paths. "
                    "Adjust event array/root path or use a sample where matching records exist."
                ),
            )
        )

    checkpoint_values_preview: list[Any] = []
    if normalized_checkpoint_path:
        missing_seen = False
        multiple_seen = False
        non_scalar_seen = False
        for event in preview_events:
            try:
                matches = find_values(event, normalized_checkpoint_path)
            except ParserError as exc:
                errors.append(
                    ExtractionValidationIssue(
                        code="INVALID_CHECKPOINT_PATH",
                        severity="error",
                        message=str(exc),
                    )
                )
                break
            if not matches:
                missing_seen = True
                continue
            if len(matches) > 1:
                multiple_seen = True
            value = matches[0]
            if isinstance(value, dict | list):
                non_scalar_seen = True
                continue
            checkpoint_values_preview.append(value)

        if missing_seen:
            warnings.append(
                ExtractionValidationIssue(
                    code="CHECKPOINT_NOT_FOUND",
                    severity="warning",
                    message="Checkpoint path did not resolve on one or more preview events.",
                )
            )
        if multiple_seen:
            warnings.append(
                ExtractionValidationIssue(
                    code="CHECKPOINT_MULTIPLE_MATCHES",
                    severity="warning",
                    message="Checkpoint path resolved multiple values; first value per event is used in preview.",
                )
            )
        if non_scalar_seen:
            warnings.append(
                ExtractionValidationIssue(
                    code="CHECKPOINT_NOT_SCALAR",
                    severity="warning",
                    message="Checkpoint path resolved object/array on one or more events; choose a scalar field.",
                )
            )

    return ExtractionValidateResponse(
        ok=not errors,
        normalized_event_array_path=normalized_event_array_path or None,
        normalized_event_root_path=normalized_event_root_path or None,
        normalized_checkpoint_path=normalized_checkpoint_path or None,
        event_count=len(events),
        preview_events=preview_events,
        checkpoint_values_preview=checkpoint_values_preview,
        warnings=warnings,
        errors=errors,
    )


_TRANSFORM_PREVIEW_MAX_KEYS = 40
_TRANSFORM_PREVIEW_MAX_VALUE_LEN = 128


def _transform_preview_sample_summary(event: dict[str, Any] | None) -> TransformPreviewSampleSummary:
    if not isinstance(event, dict):
        return TransformPreviewSampleSummary(is_object=False)

    keys = [str(k) for k in event.keys()]
    nested = 0
    for value in event.values():
        if isinstance(value, dict):
            nested += len(value)
        elif isinstance(value, list) and value and isinstance(value[0], dict):
            nested += len(value[0])

    preview_values: dict[str, Any] = {}
    for key in keys[:_TRANSFORM_PREVIEW_MAX_KEYS]:
        raw = event.get(key)
        if isinstance(raw, str) and len(raw) > _TRANSFORM_PREVIEW_MAX_VALUE_LEN:
            preview_values[key] = f"{raw[:_TRANSFORM_PREVIEW_MAX_VALUE_LEN]}…"
        elif isinstance(raw, (dict, list)):
            text = str(raw)
            preview_values[key] = (
                f"{text[:_TRANSFORM_PREVIEW_MAX_VALUE_LEN]}…"
                if len(text) > _TRANSFORM_PREVIEW_MAX_VALUE_LEN
                else raw
            )
        else:
            preview_values[key] = raw

    return TransformPreviewSampleSummary(
        is_object=True,
        top_level_keys=keys[:_TRANSFORM_PREVIEW_MAX_KEYS],
        top_level_key_count=len(keys),
        keys_truncated=len(keys) > _TRANSFORM_PREVIEW_MAX_KEYS,
        nested_key_estimate=nested,
        value_preview=preview_values,
    )


def _transform_preview_advanced_unavailable(
    rule: dict[str, Any],
    *,
    stage: str,
) -> tuple[TransformPreviewIssueItem, TransformPreviewFieldResultItem]:
    output_field = str(rule.get("output_field") or rule.get("field") or "").strip()
    mode = str(rule.get("mode") or "unknown").strip().lower()
    rule_id = str(rule.get("rule_id") or rule.get("id") or "").strip() or None
    message = (
        f"Advanced transform mode {mode!r} is not available in this runtime build; "
        "use JSONPath/static enrichment or deploy the full transform engine."
    )
    issue = TransformPreviewIssueItem(
        level="field",
        output_field=output_field or None,
        rule_id=rule_id,
        code="TRANSFORM_ENGINE_UNAVAILABLE",
        message=message,
        error_code="TRANSFORM_ENGINE_UNAVAILABLE",
        error_message=message,
    )
    field_result = TransformPreviewFieldResultItem(
        success=False,
        value=None,
        error_code="TRANSFORM_ENGINE_UNAVAILABLE",
        error_message=message,
        rule_id=rule_id,
        output_field=output_field,
        mode=mode or stage,
        recovered_via_default=False,
    )
    return issue, field_result


def _iter_transform_preview_rules(
    payload: TransformPreviewRequest,
) -> list[dict[str, Any]]:
    rules: list[dict[str, Any]] = [r for r in (payload.rules or []) if isinstance(r, dict)]
    if payload.stage == "mapping" and isinstance(payload.field_mappings, dict):
        nested = payload.field_mappings.get("transform_rules")
        if isinstance(nested, list):
            rules.extend(item for item in nested if isinstance(item, dict))
    if payload.stage == "enrichment" and isinstance(payload.enrichment, dict):
        nested = payload.enrichment.get("advanced_fields")
        if isinstance(nested, list):
            rules.extend(item for item in nested if isinstance(item, dict))
    return rules


def run_enrichment_exec_preview(payload: EnrichmentExecPreviewRequest) -> EnrichmentExecPreviewResponse:
    mapped = payload.mapped_event if isinstance(payload.mapped_event, dict) else {}
    enrichment = payload.enrichment if isinstance(payload.enrichment, dict) else {}
    try:
        result = execute_enrichment(
            mapped,
            enrichment,
            override_policy=payload.override_policy,
            emit_logs=False,
        )
    except EnrichmentError as exc:
        raise PreviewRequestError(400, {"code": "ENRICHMENT_FAILED", "message": str(exc)}) from exc

    warnings = [
        EnrichmentExecPreviewWarning(
            code=w.code,
            message=w.message,
            rule_type=w.rule_type,
            target_field=w.target_field,
        )
        for w in result.warnings
    ]
    return EnrichmentExecPreviewResponse(
        final_event=result.event,
        warnings=warnings,
        duration_ms=result.duration_ms,
        message="Enrichment preview executed successfully",
    )


def run_enrichment_validate(payload: EnrichmentValidateRequest) -> EnrichmentValidateResponse:
    enrichment = payload.enrichment if isinstance(payload.enrichment, dict) else {}
    if not isinstance(payload.enrichment, dict) and payload.enrichment is not None:
        return EnrichmentValidateResponse(
            ok=False,
            issues=[
                EnrichmentValidationIssueItem(
                    code="invalid_enrichment_type",
                    severity="error",
                    message="enrichment must be a JSON object",
                )
            ],
        )
    result = validate_enrichment_json(enrichment)
    return EnrichmentValidateResponse(
        ok=result.ok,
        issues=[
            EnrichmentValidationIssueItem(
                code=i.code,
                severity=i.severity,
                message=i.message,
                rule_type=i.rule_type,
                target_field=i.target_field,
            )
            for i in result.issues
        ],
    )


def run_transform_preview(payload: TransformPreviewRequest) -> TransformPreviewResponse:
    """Preview transform rules; JSONPath/static via mapper/enricher, advanced modes return warnings."""

    started = time.monotonic()
    sample = payload.sample_event if isinstance(payload.sample_event, dict) else {}
    summary = _transform_preview_sample_summary(sample)
    warnings: list[TransformPreviewIssueItem] = []
    errors: list[TransformPreviewIssueItem] = []
    field_results: list[TransformPreviewFieldResultItem] = []
    transformed: dict[str, Any] = dict(sample)
    save_blocked = False

    advanced_rules = _iter_transform_preview_rules(payload)
    for rule in advanced_rules:
        mode = str(rule.get("mode") or "").strip().lower()
        if mode in {"jsonata", "regex_extract"}:
            issue, field_result = _transform_preview_advanced_unavailable(rule, stage=payload.stage)
            warnings.append(issue)
            field_results.append(field_result)
            save_blocked = True

    if payload.stage == "mapping":
        if isinstance(payload.field_mappings, dict):
            fm = payload.field_mappings
            if is_full_event_mapping(fm):
                try:
                    transformed, fe_errors, fe_warnings = apply_full_event_mapping(sample, fm)
                    for message in fe_errors:
                        code = (
                            "JSONATA_RESULT_NOT_OBJECT"
                            if "JSONata must return a JSON object" in message
                            else "FULL_EVENT_MAPPING_FAILED"
                        )
                        errors.append(
                            TransformPreviewIssueItem(
                                level="event",
                                code=code,
                                message=message,
                                error_code=code,
                                error_message=message,
                            )
                        )
                    for message in fe_warnings:
                        warnings.append(
                            TransformPreviewIssueItem(
                                level="field",
                                code="FULL_EVENT_MAPPING_WARNING",
                                message=message,
                            )
                        )
                    if fe_errors:
                        save_blocked = True
                except MappingError as exc:
                    transformed = {}
                    msg = str(exc)
                    errors.append(
                        TransformPreviewIssueItem(
                            level="event",
                            code="MAPPING_FAILED",
                            message=msg,
                            error_code="MAPPING_FAILED",
                            error_message=msg,
                        )
                    )
                    save_blocked = True
            else:
                try:
                    transformed = apply_mapping(sample, fm)
                except MappingError as exc:
                    msg = str(exc)
                    errors.append(
                        TransformPreviewIssueItem(
                            level="event",
                            code="MAPPING_FAILED",
                            message=msg,
                            error_code="MAPPING_FAILED",
                            error_message=msg,
                        )
                    )
    elif payload.stage == "enrichment":
        enrichment = payload.enrichment if isinstance(payload.enrichment, dict) else {}
        if enrichment and not save_blocked:
            try:
                result = execute_enrichment(sample, enrichment, override_policy="KEEP_EXISTING", emit_logs=False)
                transformed = result.event
                for w in result.warnings:
                    warnings.append(
                        TransformPreviewIssueItem(
                            level="field",
                            code=w.code,
                            message=w.message,
                            rule_type=w.rule_type,
                            target_field=w.target_field,
                        )
                    )
            except EnrichmentError as exc:
                msg = str(exc)
                errors.append(
                    TransformPreviewIssueItem(
                        level="event",
                        code="ENRICHMENT_FAILED",
                        message=msg,
                        error_code="ENRICHMENT_FAILED",
                        error_message=msg,
                    )
                )
        elif enrichment and save_blocked:
            try:
                result = execute_enrichment(sample, enrichment, override_policy="KEEP_EXISTING", emit_logs=False)
                transformed = result.event
            except EnrichmentError:
                pass

    duration_ms = max(0, int((time.monotonic() - started) * 1000))
    if errors:
        message = "Transform preview completed with errors"
    elif save_blocked:
        message = "Transform preview completed; advanced transform rules are not executed in this build"
    else:
        message = "Transform preview completed successfully"

    return TransformPreviewResponse(
        stage=payload.stage,
        input_sample_summary=summary,
        transformed_result=transformed,
        field_results=field_results,
        warnings=warnings,
        errors=errors,
        save_blocked=save_blocked,
        duration_ms=duration_ms,
        message=message,
    )


def run_final_event_draft_preview(
    payload: FinalEventDraftPreviewRequest,
    db: Any | None = None,
) -> FinalEventDraftPreviewResponse:
    input_count, mapped_events, missing_fields = _run_mapping_draft_core(
        payload.payload,
        payload.event_array_path,
        payload.event_root_path,
        payload.field_mappings,
        payload.max_events,
    )
    try:
        final_events = apply_enrichments(mapped_events, payload.enrichment, payload.override_policy)
    except EnrichmentError as exc:
        raise PreviewRequestError(400, {"code": "ENRICHMENT_FAILED", "message": str(exc)}) from exc

    matched_policies: list[dict[str, str]] = []
    selected_destinations: list[str] = []
    would_quarantine = False
    classification_level: str | None = None
    if db is not None and payload.stream_id is not None:
        from app.classification.service import classify_events_for_preview
        from app.dynamic_routing.dynamic_routing_service import evaluate_dynamic_routes_for_preview
        from app.protection.policy_engine import evaluate_batch as evaluate_policy_batch
        from app.protection.policy_service import evaluate_policies_for_preview
        from app.protection.service import commit_identity_vault_after_preview, protect_events_for_delivery
        from app.quarantine.policy_integration import should_quarantine_batch
        from app.sensitive_detection.context import build_sensitive_detection_context

        detection_context = build_sensitive_detection_context(
            stream_id=int(payload.stream_id),
            events=final_events,
        )
        classification_level = classify_events_for_preview(
            db,
            stream_id=int(payload.stream_id),
            enriched_events=final_events,
            detection_context=detection_context,
        )
        final_events, _ = protect_events_for_delivery(
            db,
            stream_id=int(payload.stream_id),
            enriched_events=final_events,
        )
        commit_identity_vault_after_preview(db, int(payload.stream_id))
        policy_result = evaluate_policy_batch(
            db,
            stream_id=int(payload.stream_id),
            events=final_events,
            findings=detection_context.findings if detection_context else None,
        )
        matched_policies = evaluate_policies_for_preview(
            db,
            stream_id=int(payload.stream_id),
            enriched_events=final_events,
            policy_result=policy_result,
        )
        would_quarantine = should_quarantine_batch(policy_result)
        selected_destinations = evaluate_dynamic_routes_for_preview(
            db,
            stream_id=int(payload.stream_id),
            enriched_events=final_events,
            detection_context=detection_context,
        )
        from app.failover_routing.failover_engine import build_failover_plan_for_preview

        failover_plan_raw = build_failover_plan_for_preview(db, int(payload.stream_id))
    else:
        failover_plan_raw = []

    return FinalEventDraftPreviewResponse(
        input_event_count=input_count,
        preview_event_count=len(mapped_events),
        mapped_events=mapped_events,
        final_events=final_events,
        missing_fields=missing_fields,
        classification_level=classification_level,
        matched_policies=matched_policies,
        selected_destinations=selected_destinations,
        failover_plan=failover_plan_raw,
        would_quarantine=would_quarantine,
        message="Final event draft preview generated successfully",
    )


def run_delivery_format_draft_preview(
    payload: DeliveryFormatDraftPreviewRequest,
) -> DeliveryFormatDraftPreviewResponse:
    preview_events = payload.final_events[: payload.max_events]
    try:
        formatted = run_format_preview(
            FormatPreviewRequest(
                events=preview_events,
                destination_type=payload.destination_type,
                formatter_config=payload.formatter_config,
                payload_mode=payload.payload_mode,
                webhook_batch_size=payload.webhook_batch_size,
            )
        )
    except PreviewRequestError as exc:
        detail = exc.detail
        code = detail.get("error_code", "FORMAT_PREVIEW_FAILED")
        raise PreviewRequestError(400, {"code": code, "message": detail.get("message", str(detail))}) from exc

    return DeliveryFormatDraftPreviewResponse(
        input_event_count=len(payload.final_events),
        preview_event_count=len(preview_events),
        destination_type=formatted.destination_type,
        preview_messages=formatted.preview_messages,
        message="Delivery format draft preview generated successfully",
    )


def run_e2e_draft_preview(
    payload: E2EDraftPreviewRequest,
    db: Any | None = None,
) -> E2EDraftPreviewResponse:
    final_preview = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload=payload.payload,
            event_array_path=payload.event_array_path,
            event_root_path=payload.event_root_path,
            field_mappings=payload.field_mappings,
            enrichment=payload.enrichment,
            override_policy=payload.override_policy,
            max_events=payload.max_events,
            stream_id=payload.stream_id,
        ),
        db=db,
    )
    formatted_preview = run_delivery_format_draft_preview(
        DeliveryFormatDraftPreviewRequest(
            final_events=final_preview.final_events,
            destination_type=payload.destination_type,
            formatter_config=payload.formatter_config,
            max_events=payload.max_events,
            payload_mode=payload.payload_mode,
            webhook_batch_size=payload.webhook_batch_size,
        )
    )
    return E2EDraftPreviewResponse(
        input_event_count=final_preview.input_event_count,
        preview_event_count=final_preview.preview_event_count,
        mapped_events=final_preview.mapped_events,
        final_events=final_preview.final_events,
        preview_messages=formatted_preview.preview_messages,
        missing_fields=final_preview.missing_fields,
        destination_type=formatted_preview.destination_type,
        message="E2E draft preview generated successfully",
    )


def run_format_preview(payload: FormatPreviewRequest) -> FormatPreviewResponse:
    if payload.destination_type not in {"SYSLOG_UDP", "SYSLOG_TCP", "SYSLOG_TLS", "WEBHOOK_POST"}:
        raise PreviewRequestError(
            400,
            {
                "error_code": "UNSUPPORTED_DESTINATION_TYPE",
                "message": f"Unsupported destination_type: {payload.destination_type}",
            },
        )

    formatter_config = payload.formatter_config

    try:
        if payload.destination_type in {"SYSLOG_UDP", "SYSLOG_TCP", "SYSLOG_TLS"}:
            preview_messages: list[Any] = [
                format_syslog(event=event, formatter_config=formatter_config) for event in payload.events
            ]
        else:
            cfg: dict[str, Any] = {}
            if payload.payload_mode is not None:
                cfg["payload_mode"] = payload.payload_mode
            pm = resolve_webhook_payload_mode(cfg)
            preview_messages = build_webhook_http_preview_messages(
                payload.events,
                pm,
                batch_size=payload.webhook_batch_size,
            )
    except Exception as exc:
        raise PreviewRequestError(400, {"error_code": "FORMAT_PREVIEW_FAILED", "message": str(exc)}) from exc

    return FormatPreviewResponse(
        destination_type=payload.destination_type,
        message_count=len(preview_messages),
        preview_messages=preview_messages,
    )


def _coerce_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def run_delivery_prefix_format_preview(
    payload: DeliveryPrefixFormatPreviewRequest,
) -> DeliveryPrefixFormatPreviewResponse:
    route_fc = dict(payload.formatter_config or {})
    dst = str(payload.destination_type or "").strip().upper()
    sample = dict(payload.sample_event or {})
    stream_m = dict(payload.stream or {})
    dest_m = dict(payload.destination or {})
    route_m = dict(payload.route or {})
    dest_type_ctx = str(dest_m.get("type") or dest_m.get("destination_type") or dst)

    pfx_ctx = build_message_prefix_context(
        stream_name=str(stream_m.get("name") or ""),
        stream_id=_coerce_int(stream_m.get("id")),
        destination_name=str(dest_m.get("name") or ""),
        destination_type=dest_type_ctx,
        route_id=_coerce_int(route_m.get("id")),
    )

    if dst not in {"SYSLOG_UDP", "SYSLOG_TCP", "SYSLOG_TLS", "WEBHOOK_POST"}:
        raise PreviewRequestError(
            400,
            {
                "error_code": "UNSUPPORTED_DESTINATION_TYPE",
                "message": f"Unsupported destination_type: {dst}",
            },
        )

    if not effective_message_prefix_enabled(route_fc, dst):
        if dst == "WEBHOOK_POST":
            merged_cfg: dict[str, Any] = {}
            if payload.payload_mode is not None:
                merged_cfg["payload_mode"] = payload.payload_mode
            elif dest_m.get("payload_mode") is not None:
                merged_cfg["payload_mode"] = dest_m.get("payload_mode")
            pm = resolve_webhook_payload_mode(merged_cfg)
            if pm == WEBHOOK_PAYLOAD_MODE_BATCH:
                final_payload = json.dumps(format_webhook_events([sample]), separators=(",", ":"))
            else:
                final_payload = json.dumps(sample, separators=(",", ":"))
        else:
            final_payload = compact_event_json(sample)
        return DeliveryPrefixFormatPreviewResponse(
            resolved_prefix="",
            final_payload=final_payload,
            message_prefix_enabled=False,
        )

    template = effective_message_prefix_template(route_fc)
    resolved_prefix = resolve_message_prefix_template(template, event=sample, context=pfx_ctx)
    final_payload = format_single_delivery_line(sample, route_fc, dst, prefix_context=pfx_ctx)
    return DeliveryPrefixFormatPreviewResponse(
        resolved_prefix=resolved_prefix,
        final_payload=final_payload,
        message_prefix_enabled=True,
    )


def _route_formatter_override(route: Route) -> dict[str, Any] | None:
    raw = route.formatter_config_json if isinstance(route.formatter_config_json, dict) else {}
    return raw if raw else None


def build_route_delivery_preview_messages(
    *,
    route: Route,
    destination: Destination,
    stream_row: Stream | None,
    events: list[dict[str, Any]],
) -> tuple[list[Any], dict[str, Any]]:
    """Format wire delivery preview messages without sending or persisting logs."""

    destination_config = destination.config_json or {}
    try:
        resolved = resolve_formatter_config(destination_config, _route_formatter_override(route))
    except ValueError as exc:
        raise PreviewRequestError(
            400, {"error_code": "ROUTE_DELIVERY_PREVIEW_FAILED", "message": str(exc)}
        ) from exc

    destination_type = str(destination.destination_type or "").strip().upper()
    route_fc = dict(route.formatter_config_json or {})
    pfx_ctx = build_message_prefix_context(
        stream_name=str(stream_row.name) if stream_row else "",
        stream_id=int(route.stream_id),
        destination_name=str(destination.name or ""),
        destination_type=destination_type,
        route_id=int(route.id),
    )

    if destination_type.startswith("SYSLOG"):
        msg_fmt = resolved.get("message_format", "json")
        if msg_fmt != "json":
            raise PreviewRequestError(
                400,
                {
                    "error_code": "ROUTE_DELIVERY_PREVIEW_FAILED",
                    "message": f"Unsupported message_format for syslog delivery: {msg_fmt}",
                },
            )
        preview_messages = format_delivery_lines_syslog(
            events,
            route_fc,
            destination_type,
            prefix_context=pfx_ctx,
        )
    elif destination_type == "WEBHOOK_POST":
        if effective_message_prefix_enabled(route_fc, "WEBHOOK_POST"):
            preview_messages = [
                format_single_delivery_line(
                    e,
                    route_fc,
                    "WEBHOOK_POST",
                    prefix_context=pfx_ctx,
                )
                for e in events
            ]
        else:
            pm = resolve_webhook_payload_mode(dict(destination_config))
            bs = _coerce_int(destination_config.get("batch_size"))
            if bs is not None:
                bs = max(1, bs)
            preview_messages = build_webhook_http_preview_messages(
                events,
                pm,
                batch_size=bs,
            )
    else:
        raise PreviewRequestError(
            400,
            {
                "error_code": "UNSUPPORTED_DESTINATION_TYPE",
                "message": f"Unsupported destination_type: {destination_type}",
            },
        )

    resolved_out = {
        **resolved,
        "message_prefix_enabled": effective_message_prefix_enabled(route_fc, destination_type),
        "message_prefix_template": effective_message_prefix_template(route_fc),
    }
    return preview_messages, resolved_out


def run_route_delivery_preview(
    db: Session,
    payload: RouteDeliveryPreviewRequest,
) -> RouteDeliveryPreviewResponse:
    route = db.query(Route).filter(Route.id == payload.route_id).first()
    if route is None:
        raise PreviewRequestError(
            404,
            {"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {payload.route_id}"},
        )

    if not bool(route.enabled):
        raise PreviewRequestError(
            400,
            {"error_code": "ROUTE_DISABLED", "message": "route is disabled"},
        )

    destination = get_destination_by_id(db, int(route.destination_id))
    if destination is None:
        raise PreviewRequestError(
            404,
            {
                "error_code": "DESTINATION_NOT_FOUND",
                "message": f"destination not found for route: {payload.route_id}",
            },
        )

    if not bool(destination.enabled):
        raise PreviewRequestError(
            400,
            {"error_code": "DESTINATION_DISABLED", "message": "destination is disabled"},
        )

    stream_row = db.query(Stream).filter(Stream.id == int(route.stream_id)).first()
    destination_type = str(destination.destination_type or "").strip().upper()

    try:
        preview_messages, resolved_out = build_route_delivery_preview_messages(
            route=route,
            destination=destination,
            stream_row=stream_row,
            events=payload.events,
        )
    except PreviewRequestError:
        raise
    except Exception as exc:
        raise PreviewRequestError(400, {"error_code": "ROUTE_DELIVERY_PREVIEW_FAILED", "message": str(exc)}) from exc

    return RouteDeliveryPreviewResponse(
        route_id=int(route.id),
        destination_id=int(destination.id),
        destination_type=destination_type,
        route_enabled=bool(route.enabled),
        destination_enabled=bool(destination.enabled),
        message_count=len(preview_messages),
        resolved_formatter_config=resolved_out,
        preview_messages=preview_messages,
    )


def run_sensitive_detection_preview(
    payload: SensitiveDetectionPreviewRequest,
) -> SensitiveDetectionPreviewResponse:
    """Suggestion-only preview using the existing Sensitive Detection Engine."""

    from app.sensitive_detection.suggestions import suggest_sensitive_fields_for_events

    events = [event for event in payload.events if isinstance(event, dict)]
    raw = suggest_sensitive_fields_for_events(events)
    suggestions = [SensitiveSuggestionEntry.model_validate(item) for item in raw]
    return SensitiveDetectionPreviewResponse(
        suggestions=suggestions,
        suggestion_count=len(suggestions),
        auto_protection_applied=False,
    )
