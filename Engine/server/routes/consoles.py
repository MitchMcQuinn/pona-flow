"""Console (dashboard) routes: catalog CRUD, refresh SSE, and form sequence runs."""

from __future__ import annotations

import asyncio
import queue

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import StreamingResponse

from .. import auth, catalog, console_hub, console_service
from ..auth import Principal
from ..console_service import ConsoleRunError
from ..http_utils import (
    bad_request,
    domain_500,
    json_body,
    require_body_space_id,
    require_query_space_id,
    value_400_domain_500,
)

router = APIRouter()


def _console_for_principal(console_id: str, principal: Principal) -> dict:
    with domain_500():
        console = catalog.get_console(console_id)
    if console is None:
        raise HTTPException(404, "console not found")
    auth.require_space_access(principal, str(console.get("space_id") or ""))
    return console


@router.get("/api/consoles")
def list_consoles(
    space_id: str = Query(""),
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    sid = require_query_space_id(space_id)
    auth.require_space_access(principal, sid)
    with domain_500():
        consoles = catalog.list_consoles(sid)
    return {"space_id": sid, "consoles": consoles}


@router.get("/api/consoles/{console_id}")
def get_console(
    console_id: str, principal: Principal = Depends(auth.current_principal_or_agent)
):
    console = _console_for_principal(console_id, principal)
    document = console.get("document")
    if isinstance(document, dict):
        console = {**console, "document": console_service.link_console_document(document)}
    return console


@router.post("/api/consoles/upsert")
async def consoles_upsert(
    request: Request, principal: Principal = Depends(auth.current_principal_or_agent)
):
    body = await json_body(request)
    console_id = str(body.get("id") or "").strip()
    if not console_id:
        raise bad_request("id is required")
    space_id = require_body_space_id(body)
    auth.require_space_manage(principal, space_id)
    name = str(body.get("name") or "").strip()
    if not name:
        raise bad_request("name is required")
    document = body.get("document")
    if document is not None and not isinstance(document, dict):
        raise bad_request("document must be an object")
    if isinstance(document, dict):
        document = console_service.link_console_document(document)
    with value_400_domain_500():
        result = catalog.upsert_console(
            console_id,
            space_id,
            name,
            trigger_kind=str(body.get("trigger_kind") or ""),
            listen_url=str(body.get("listen_url") or ""),
            trigger_event_id=str(body.get("trigger_event_id") or ""),
            document=document if isinstance(document, dict) else None,
        )
    return result


@router.post("/api/consoles/delete")
async def consoles_delete(
    request: Request, principal: Principal = Depends(auth.current_principal_or_agent)
):
    body = await json_body(request)
    console_id = str(body.get("id") or "").strip()
    if not console_id:
        raise bad_request("id is required")
    with domain_500():
        existing = catalog.get_console(console_id)
    if existing is None:
        raise HTTPException(404, "console not found")
    auth.require_space_manage(principal, str(existing.get("space_id") or ""))
    with value_400_domain_500():
        return catalog.delete_console(console_id)


@router.post("/api/consoles/reorder")
async def consoles_reorder(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    """Persist nav grouping: each item is ``{"id", "group_title", "sort_order"}``."""
    body = await json_body(request)
    items = body.get("items")
    if not isinstance(items, list):
        raise bad_request("items must be an array")
    normalized = [item for item in items if isinstance(item, dict)]
    ids = [str(item.get("id") or "").strip() for item in normalized]
    with value_400_domain_500():
        space_id = catalog.rows_space_id("consoles", ids)
    if space_id:
        auth.require_space_manage(principal, space_id)
    with value_400_domain_500():
        return catalog.reorder_nav_rows("consoles", normalized)


@router.get("/api/consoles/{console_id}/listen")
async def listen_console(
    console_id: str, principal: Principal = Depends(auth.current_principal_or_agent)
):
    """SSE stream. A named ``refresh`` event means the bound event fired."""
    console = _console_for_principal(console_id, principal)
    cid = str(console.get("id") or "")

    async def events():
        subscriber = console_hub.subscribe(cid)
        try:
            yield ": connected\n\n"
            while True:
                try:
                    await asyncio.to_thread(subscriber.get, True, 15.0)
                except queue.Empty:
                    yield ": keepalive\n\n"
                    continue
                yield "event: refresh\ndata: {}\n\n"
        finally:
            console_hub.unsubscribe(cid, subscriber)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/api/consoles/{console_id}/run")
async def run_console_sequence(
    console_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    console = _console_for_principal(console_id, principal)
    body = await json_body(request)
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    if body.get("params") is not None and not isinstance(body.get("params"), dict):
        raise bad_request("params must be an object")
    try:
        return console_service.execute_console_sequence(
            console,
            str(body.get("sequenceId") or body.get("sequence_id") or ""),
            str(body.get("viewId") or body.get("view_id") or ""),
            str(body.get("role") or ""),
            params,
            principal.user_id,
            state_id=str(body.get("stateId") or body.get("state_id") or ""),
        )
    except ConsoleRunError as err:
        raise HTTPException(err.status_code, str(err)) from err
