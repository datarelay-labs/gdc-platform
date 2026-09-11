"""Destination HTTP routes."""

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session, joinedload
from starlette.status import HTTP_422_UNPROCESSABLE_CONTENT

from app.database import get_db, get_db_read_bounded, utcnow
from app.destinations.config_validation import validate_destination_config
from app.destinations.models import Destination
from app.destinations.schemas import (
    DestinationCreate,
    DestinationListItem,
    DestinationPreviewTest,
    DestinationRead,
    DestinationRouteUsage,
    DestinationTestResult,
    DestinationUpdate,
)
from app.destinations.test_service import run_destination_connectivity_probe, run_destination_connectivity_test
from app.platform_admin import journal
from app.platform_admin.config_entity_snapshots import serialize_destination_config
from app.routes.models import Route
from app.security.secrets import mask_secrets, preserve_masked_secrets

router = APIRouter()


def _destination_read_masked(row: Destination) -> DestinationRead:
    item = DestinationRead.model_validate(row).model_dump()
    item["config_json"] = mask_secrets(item.get("config_json") or {})
    return DestinationRead.model_validate(item)


def _usage_by_destination(db: Session, destination_ids: list[int]) -> dict[int, list[DestinationRouteUsage]]:
    if not destination_ids:
        return {}
    rows = (
        db.query(Route)
        .options(joinedload(Route.stream))
        .filter(Route.destination_id.in_(destination_ids))
        .order_by(Route.id.asc())
        .all()
    )
    out: dict[int, list[DestinationRouteUsage]] = defaultdict(list)
    for r in rows:
        stream_name = r.stream.name if r.stream is not None else f"Stream #{r.stream_id}"
        out[r.destination_id].append(
            DestinationRouteUsage(
                route_id=int(r.id),
                stream_id=int(r.stream_id),
                stream_name=stream_name,
                route_enabled=bool(r.enabled),
                route_status=str(r.status or ""),
            )
        )
    return out


@router.get("/", response_model=list[DestinationListItem])
async def list_destinations(db: Session = Depends(get_db_read_bounded)) -> list[DestinationListItem]:
    dest_rows = db.query(Destination).order_by(Destination.id.asc()).all()
    usage_map = _usage_by_destination(db, [int(d.id) for d in dest_rows])
    items: list[DestinationListItem] = []
    for row in dest_rows:
        routes = usage_map.get(int(row.id), [])
        distinct_streams = {r.stream_id for r in routes}
        base = _destination_read_masked(row)
        items.append(
            DestinationListItem(
                **base.model_dump(),
                streams_using_count=len(distinct_streams),
                routes=routes,
            )
        )
    return items


@router.post("/", response_model=DestinationRead, status_code=status.HTTP_201_CREATED)
async def create_destination(payload: DestinationCreate, request: Request, db: Session = Depends(get_db)) -> DestinationRead:
    try:
        validate_destination_config(payload.destination_type, dict(payload.config_json or {}))
    except ValueError as exc:
        raise HTTPException(
            status_code=HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"error_code": "INVALID_DESTINATION_CONFIG", "message": str(exc)},
        ) from exc
    row = Destination(
        name=payload.name,
        destination_type=payload.destination_type,
        config_json=dict(payload.config_json or {}),
        rate_limit_json=dict(payload.rate_limit_json or {}),
        enabled=True if payload.enabled is None else bool(payload.enabled),
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    journal.record_audit_event(
        db,
        action="DESTINATION_CREATED",
        entity_type="DESTINATION",
        entity_id=int(row.id),
        entity_name=str(row.name),
        details={"destination_type": str(row.destination_type)},
        request=request,
    )
    journal.record_config_version(
        db,
        entity_type="DESTINATION_CONFIG",
        entity_id=int(row.id),
        entity_name=str(row.name),
        summary="Destination created",
        snapshot_before=None,
        snapshot_after=serialize_destination_config(row),
    )
    db.commit()
    db.refresh(row)
    return _destination_read_masked(row)


@router.post("/preview-test", response_model=DestinationTestResult)
async def preview_test_destination(payload: DestinationPreviewTest) -> DestinationTestResult:
    """Connectivity probe using unsaved form values (does not persist results on a destination row)."""

    raw = run_destination_connectivity_probe(str(payload.destination_type), dict(payload.config_json or {}))
    return DestinationTestResult.model_validate(raw)


@router.post("/{destination_id}/test", response_model=DestinationTestResult)
async def test_destination(destination_id: int, request: Request, db: Session = Depends(get_db)) -> DestinationTestResult:
    """Send a small probe message to verify syslog/webhook connectivity (does not change runtime delivery)."""

    row = db.query(Destination).filter(Destination.id == destination_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "DESTINATION_NOT_FOUND", "message": f"destination not found: {destination_id}"},
        )
    raw = run_destination_connectivity_test(row, db=db)
    now = utcnow()
    row.last_connectivity_test_at = now
    row.last_connectivity_test_success = bool(raw.get("success"))
    row.last_connectivity_test_latency_ms = float(raw.get("latency_ms") or 0.0)
    msg = raw.get("message")
    row.last_connectivity_test_message = str(msg) if msg is not None else None
    db.add(row)
    journal.record_audit_event(
        db,
        action="DESTINATION_TESTED",
        entity_type="DESTINATION",
        entity_id=int(row.id),
        entity_name=str(row.name),
        result="success" if bool(raw.get("success")) else "failure",
        details={
            "destination_type": str(row.destination_type),
            "latency_ms": raw.get("latency_ms"),
            "message": raw.get("message"),
        },
        request=request,
    )
    db.commit()
    db.refresh(row)
    return DestinationTestResult.model_validate(raw)


@router.get("/{destination_id}", response_model=DestinationRead)
async def get_destination(destination_id: int, db: Session = Depends(get_db)) -> DestinationRead:
    row = db.query(Destination).filter(Destination.id == destination_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "DESTINATION_NOT_FOUND", "message": f"destination not found: {destination_id}"},
        )
    return _destination_read_masked(row)


@router.put("/{destination_id}", response_model=DestinationRead)
async def update_destination(
    destination_id: int, payload: DestinationUpdate, request: Request, db: Session = Depends(get_db)
) -> DestinationRead:
    row = db.query(Destination).filter(Destination.id == destination_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "DESTINATION_NOT_FOUND", "message": f"destination not found: {destination_id}"},
        )

    update = payload.model_dump(exclude_unset=True)
    merged_type = str(update.get("destination_type", row.destination_type))
    merged_cfg = dict(row.config_json or {})
    if "config_json" in update and update["config_json"] is not None:
        merged_cfg = preserve_masked_secrets(dict(update["config_json"]), dict(row.config_json or {}))
        update["config_json"] = merged_cfg
    try:
        validate_destination_config(merged_type, merged_cfg)
    except ValueError as exc:
        raise HTTPException(
            status_code=HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"error_code": "INVALID_DESTINATION_CONFIG", "message": str(exc)},
        ) from exc

    dest_before = serialize_destination_config(row)
    for key, value in update.items():
        if key in {"config_json", "rate_limit_json"} and value is not None:
            setattr(row, key, dict(value))
        else:
            setattr(row, key, value)
    journal.record_audit_event(
        db,
        action="DESTINATION_UPDATED",
        entity_type="DESTINATION",
        entity_id=destination_id,
        entity_name=str(row.name),
        details={"updated_fields": sorted(update.keys())},
        request=request,
    )
    journal.record_config_version(
        db,
        entity_type="DESTINATION_CONFIG",
        entity_id=destination_id,
        entity_name=str(row.name),
        summary=f"Destination updated ({','.join(sorted(update.keys()))})",
        snapshot_before=dest_before,
        snapshot_after=serialize_destination_config(row),
    )
    db.commit()
    db.refresh(row)
    return _destination_read_masked(row)


@router.delete("/{destination_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_destination(destination_id: int, request: Request, db: Session = Depends(get_db)) -> None:
    row = db.query(Destination).filter(Destination.id == destination_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "DESTINATION_NOT_FOUND", "message": f"destination not found: {destination_id}"},
        )
    if row.enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "DESTINATION_DELETE_BLOCKED_ENABLED",
                "message": "Disable the destination before deleting it.",
            },
        )
    route_count = db.query(Route).filter(Route.destination_id == destination_id).count()
    if route_count > 0:
        distinct_streams = (
            db.query(Route.stream_id).filter(Route.destination_id == destination_id).distinct().count()
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "DESTINATION_DELETE_BLOCKED_IN_USE",
                "message": (
                    f"Destination is still used by {distinct_streams} stream(s) "
                    f"via {route_count} route(s). Remove or reassign routes first."
                ),
                "route_count": route_count,
                "stream_count": distinct_streams,
            },
        )
    dest_name = str(row.name)
    db.delete(row)
    journal.record_audit_event(
        db,
        action="DESTINATION_DELETED",
        entity_type="DESTINATION",
        entity_id=int(destination_id),
        entity_name=dest_name,
        request=request,
    )
    db.commit()
