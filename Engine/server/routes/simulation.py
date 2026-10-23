"""Session control for simulated events.

Authenticated routes (signed-in user or agent key) live under the event id.
Public routes use the event's ``sim_`` token the way external ingest uses
``evt_``: the token in the path is the secret. Both call ``server.simulation``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import JSONResponse

from .. import auth, catalog, simulation
from ..auth import Principal
from ..http_utils import domain_500, json_body, value_400_domain_500

router = APIRouter()


def _event_for_principal(event_id: str, principal: Principal) -> dict:
    with domain_500():
        event = catalog.get_event(event_id)
    if event is None:
        raise HTTPException(404, "event not found")
    auth.require_space_access(principal, str(event.get("space_id") or ""))
    return event


def _event_for_token(token: str) -> dict:
    with domain_500():
        event = catalog.get_event_by_simulation_token(token)
    if event is None or str(event.get("type") or "") != "simulated":
        raise HTTPException(404, "unknown simulation token")
    return event


def _call(action):
    """Map simulation failures onto the ``{"error": ...}`` HTTP contract.

    ``value_400_domain_500`` turns a bad ``world_start_at`` into 400 and leaves
    ``SimulationRejected`` / ``LookupError`` for the handlers below.
    """
    try:
        with value_400_domain_500():
            return action()
    except simulation.SimulationRejected as err:
        raise HTTPException(err.status_code, str(err))
    except LookupError as err:
        raise HTTPException(404, str(err))


def _world_start(body: dict) -> str:
    raw = body.get("world_start_at")
    if raw is None:
        raw = body.get("worldStartAt")
    return str(raw or "")


def _require_simulated(event: dict) -> None:
    if str(event.get("type") or "") != "simulated":
        raise HTTPException(409, "Event is not a simulated event")


@router.get("/api/events/{event_id}/sessions")
def list_sessions(
    event_id: str, principal: Principal = Depends(auth.current_principal_or_agent)
):
    event = _event_for_principal(event_id, principal)
    _require_simulated(event)
    with domain_500():
        sessions = catalog.list_simulation_sessions(event_id)
    return {"event_id": event_id, "sessions": sessions}


@router.get("/api/events/{event_id}/sessions/{session_id}")
def get_session(
    event_id: str,
    session_id: str,
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    event = _event_for_principal(event_id, principal)
    _require_simulated(event)
    with domain_500():
        detail = catalog.get_simulation_session_detail(session_id, event_id)
    if detail is None:
        raise HTTPException(404, "Session not found")
    return detail


@router.post("/api/events/{event_id}/sessions")
async def create_session(
    event_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    event = _event_for_principal(event_id, principal)
    body = await json_body(request)
    created = _call(lambda: simulation.create_session(event, _world_start(body)))
    return JSONResponse(content=created, status_code=201)


@router.post("/api/events/{event_id}/sessions/{session_id}/name")
async def rename_session(
    event_id: str,
    session_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    event = _event_for_principal(event_id, principal)
    body = await json_body(request)
    raw = body.get("name")
    return _call(lambda: simulation.rename_session(event, session_id, str(raw or "")))


@router.delete("/api/events/{event_id}/sessions/{session_id}")
def delete_session(
    event_id: str,
    session_id: str,
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    event = _event_for_principal(event_id, principal)
    _call(lambda: simulation.delete_session(event, session_id))
    return {"id": session_id, "deleted": True}


@router.post("/api/events/{event_id}/sessions/{session_id}/tic")
def advance_session(
    event_id: str,
    session_id: str,
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    event = _event_for_principal(event_id, principal)
    return _call(
        lambda: simulation.advance_session(
            event, session_id, principal_id=principal.user_id
        )
    )


@router.post("/api/events/{event_id}/sessions/{session_id}/clear-error")
def clear_session_error(
    event_id: str,
    session_id: str,
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    event = _event_for_principal(event_id, principal)
    return _call(lambda: simulation.clear_session_error(event, session_id))


@router.post("/api/sim/{token}/sessions")
async def public_create_session(token: str, request: Request):
    event = _event_for_token(token)
    body = await json_body(request)
    created = _call(lambda: simulation.create_session(event, _world_start(body)))
    return JSONResponse(content=created, status_code=201)


@router.delete("/api/sim/{token}/sessions/{session_id}")
def public_delete_session(token: str, session_id: str):
    event = _event_for_token(token)
    _call(lambda: simulation.delete_session(event, session_id))
    return {"id": session_id, "deleted": True}


@router.post("/api/sim/{token}/sessions/{session_id}/tic")
def public_advance_session(token: str, session_id: str):
    event = _event_for_token(token)
    return _call(lambda: simulation.advance_session(event, session_id, principal_id=None))


@router.post("/api/sim/{token}/sessions/{session_id}/clear-error")
def public_clear_session_error(token: str, session_id: str):
    event = _event_for_token(token)
    return _call(lambda: simulation.clear_session_error(event, session_id))
