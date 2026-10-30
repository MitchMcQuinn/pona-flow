"""Factory reset and per-space data reset."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import JSONResponse

from .. import auth, local_auth, reset, spaces
from ..auth import Principal
from ..http_utils import json_body, require_body_space_id, value_400_domain_500

router = APIRouter()

INSTANCE_CONFIRM = "RESET INSTANCE"


def _clear_session_cookie(response: JSONResponse, request: Request) -> None:
    response.delete_cookie(
        key=local_auth.SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=auth.session_cookie_secure(request),
    )


@router.post("/api/spaces/reset")
async def reset_space(request: Request, principal: Principal = Depends(auth.current_principal)):
    """Clear one space's graph and authored records. Settings and accounts stay."""
    if not auth.same_origin_request(request):
        raise HTTPException(403, "Cross-site request rejected.")
    body = await json_body(request)
    space_id = require_body_space_id(body, allow_id=True)
    auth.require_space_manage(principal, space_id)
    confirm = str(body.get("confirm") or "").strip()
    with value_400_domain_500():
        stored = str(spaces.get_space_row(space_id)["name"] or "").strip()
        if confirm != stored:
            raise ValueError("Type the space name to confirm this reset.")
        return reset.reset_space(space_id)


@router.post("/api/instance/factory-reset")
async def factory_reset(
    request: Request, principal: Principal = Depends(auth.require_instance_admin)
):
    """Erase the instance and return the browser to first-run setup."""
    if not auth.same_origin_request(request):
        raise HTTPException(403, "Cross-site request rejected.")
    body = await json_body(request)
    if str(body.get("confirm") or "").strip() != INSTANCE_CONFIRM:
        raise HTTPException(400, f"Type {INSTANCE_CONFIRM} to confirm a factory reset.")
    with value_400_domain_500():
        result = reset.factory_reset()
    response = JSONResponse(result)
    if result.get("setup_required"):
        _clear_session_cookie(response, request)
    return response
