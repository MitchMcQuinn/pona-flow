"""Public tab icon, and the instance-admin label that replaces the wave."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import Response

from .. import auth, branding
from ..auth import Principal
from ..http_utils import bad_request, json_body

router = APIRouter()


@router.get("/favicon.svg")
def favicon():
    return Response(
        content=branding.icon_svg(),
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/api/instance/branding")
def get_branding(_p: Principal = Depends(auth.require_instance_admin)):
    return branding.public_chrome()


@router.post("/api/instance/branding")
async def set_branding(request: Request, _p: Principal = Depends(auth.require_instance_admin)):
    if not auth.same_origin_request(request):
        raise HTTPException(403, "Cross-site request rejected.")
    body = await json_body(request)
    if "icon_label" not in body:
        raise bad_request("icon_label is required")
    value = body.get("icon_label")
    if not isinstance(value, str):
        raise bad_request("icon_label must be a string")
    try:
        branding.set_icon_label(value)
    except ValueError as exc:
        raise bad_request(str(exc)) from exc
    return branding.public_chrome()
