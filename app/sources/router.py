"""Source HTTP routes."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db
from app.security.secrets import mask_secrets, preserve_masked_secrets
from app.sources.models import Source
from app.sources.schemas import SourceCreate, SourceRead, SourceUpdate

router = APIRouter()


def _source_read_masked(row: Source) -> SourceRead:
    item = SourceRead.model_validate(row).model_dump()
    item["config_json"] = mask_secrets(item.get("config_json"))
    item["auth_json"] = mask_secrets(item.get("auth_json"))
    return SourceRead.model_validate(item)


@router.get("/", response_model=list[SourceRead])
async def list_sources(db: Session = Depends(get_db)) -> list[SourceRead]:
    rows = db.query(Source).order_by(Source.id.asc()).all()
    return [_source_read_masked(row) for row in rows]


@router.post("/", response_model=SourceRead, status_code=status.HTTP_201_CREATED)
async def create_source(payload: SourceCreate, db: Session = Depends(get_db)) -> SourceRead:
    connector = db.query(Connector).filter(Connector.id == payload.connector_id).first()
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "CONNECTOR_NOT_FOUND", "message": f"connector not found: {payload.connector_id}"},
        )
    row = Source(
        connector_id=payload.connector_id,
        source_type=payload.source_type,
        config_json=dict(payload.config_json or {}),
        auth_json=dict(payload.auth_json or {}),
        enabled=True if payload.enabled is None else bool(payload.enabled),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _source_read_masked(row)


@router.get("/{source_id}", response_model=SourceRead)
async def get_source(source_id: int, db: Session = Depends(get_db)) -> SourceRead:
    row = db.query(Source).filter(Source.id == source_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {source_id}"},
        )
    return _source_read_masked(row)


@router.put("/{source_id}", response_model=SourceRead)
async def update_source(source_id: int, payload: SourceUpdate, db: Session = Depends(get_db)) -> SourceRead:
    row = db.query(Source).filter(Source.id == source_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {source_id}"},
        )
    update = payload.model_dump(exclude_unset=True)
    if "connector_id" in update:
        connector = db.query(Connector).filter(Connector.id == int(update["connector_id"])).first()
        if connector is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error_code": "CONNECTOR_NOT_FOUND", "message": f"connector not found: {update['connector_id']}"},
            )
    if "config_json" in update and update["config_json"] is not None:
        update["config_json"] = preserve_masked_secrets(dict(update["config_json"]), dict(row.config_json or {}))
    if "auth_json" in update and update["auth_json"] is not None:
        update["auth_json"] = preserve_masked_secrets(dict(update["auth_json"]), dict(row.auth_json or {}))
    for key, value in update.items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    return _source_read_masked(row)


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(source_id: int, db: Session = Depends(get_db)) -> None:
    row = db.query(Source).filter(Source.id == source_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {source_id}"},
        )
    db.delete(row)
    db.commit()
