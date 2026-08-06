"""Event (trigger) routes plus the audit log read."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import HTTPException

from .. import auth, catalog, external_triggers, scheduler
from ..auth import Principal
from ..http_utils import (
    bad_request,
    domain_500,
    is_valid_timezone,
    json_body,
    require_body_space_id,
    require_query_space_id,
    value_400_domain_500,
)

router = APIRouter()


@router.get("/api/events")
def list_events(
    space_id: str = Query(""),
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    sid = require_query_space_id(space_id)
    auth.require_space_access(principal, sid)
    with domain_500():
        events = catalog.list_events(sid)
    return {"space_id": sid, "events": events}


@router.get("/api/events/{event_id}")
def get_event(
    event_id: str, principal: Principal = Depends(auth.current_principal_or_agent)
):
    with domain_500():
        event = catalog.get_event(event_id)
    if event is None:
        raise HTTPException(404, "event not found")
    auth.require_space_access(principal, str(event.get("space_id") or ""))
    return event


@router.post("/api/events/upsert")
async def events_upsert(
    request: Request, principal: Principal = Depends(auth.current_principal_or_agent)
):
    body = await json_body(request)
    event_id = str(body.get("id") or "").strip()
    if not event_id:
        raise bad_request("id is required")
    space_id = require_body_space_id(body)
    auth.require_space_manage(principal, space_id)
    name = str(body.get("name") or "").strip()
    if not name:
        raise bad_request("name is required")
    event_package = body.get("event_package")
    if event_package is not None and not isinstance(event_package, dict):
        raise bad_request("event_package must be an object")
    if isinstance(event_package, dict):
        pkg_tz = str(event_package.get("timezone") or "").strip()
        if pkg_tz and pkg_tz.upper() != "UTC" and not is_valid_timezone(pkg_tz):
            raise bad_request("event_package.timezone is not a valid IANA timezone")
    external_package = body.get("external_package")
    if external_package is not None and not isinstance(external_package, dict):
        raise bad_request("external_package must be an object")
    sequences = body.get("sequences") or []
    recovery_sequences = body.get("recovery_sequences") or []
    if not isinstance(sequences, list) or not isinstance(recovery_sequences, list):
        raise bad_request("sequences and recovery_sequences must be arrays")
    enabled = 0 if body.get("enabled") is False else 1
    type_val = str(body.get("type") or "time").strip().lower()
    # External events need a stable inbound URL: mint an ingest token on first save
    # (or reuse the existing one), so the receiver can resolve the event by URL.
    if type_val == "external":
        ext = dict(external_package) if isinstance(external_package, dict) else {}
        existing = catalog.get_event(event_id) or {}
        existing_pkg = existing.get("external_package") or {}
        token = str(ext.get("ingest_token") or "").strip() or str(
            existing_pkg.get("ingest_token") or ""
        ).strip()
        ext["ingest_token"] = token or external_triggers.generate_ingest_token()
        external_package = ext
    with value_400_domain_500():
        result = catalog.upsert_event(
            event_id,
            space_id,
            name,
            event_package if isinstance(event_package, dict) else {},
            [str(s) for s in sequences],
            [str(s) for s in recovery_sequences],
            type=type_val,
            enabled=enabled,
            # Reset timers so the scheduler recomputes the next fire from the new rules.
            timers={},
            external_package=(
                external_package if isinstance(external_package, dict) else None
            ),
        )
    scheduler.request_reload()
    if isinstance(external_package, dict) and external_package.get("ingest_token"):
        result = {**result, "ingest_token": external_package["ingest_token"]}
    return result


@router.post("/api/events/delete")
async def events_delete(
    request: Request, principal: Principal = Depends(auth.current_principal_or_agent)
):
    body = await json_body(request)
    event_id = str(body.get("id") or "").strip()
    if not event_id:
        raise bad_request("id is required")
    with domain_500():
        existing = catalog.get_event(event_id)
    if existing is None:
        raise HTTPException(404, "event not found")
    auth.require_space_manage(principal, str(existing.get("space_id") or ""))
    with value_400_domain_500():
        result = catalog.delete_event(event_id)
    scheduler.request_reload()
    return result


@router.get("/api/audit-log")
def audit_log(
    space_id: str = Query(""),
    limit: int = Query(200),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_query_space_id(space_id)
    auth.require_space_access(principal, sid)
    with domain_500():
        entries = catalog.list_audit_log(sid, limit=limit)
    return {"space_id": sid, "entries": entries}
