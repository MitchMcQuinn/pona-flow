"""Current-principal identity/settings + superadmin principal management."""

from __future__ import annotations

import sys

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, rbac
from ..auth import Principal
from ..http_utils import (
    bad_request,
    enrich_principal_identities,
    domain_500,
    is_valid_timezone,
    json_body,
    value_400_domain_500,
)

router = APIRouter()


@router.get("/api/me")
def whoami(principal: Principal = Depends(auth.current_principal)):
    """The authenticated principal's identity + server-level capabilities (UI gating)."""
    return {
        "principal_id": principal.user_id,
        "email": principal.email,
        "principal_type": principal.principal_type,
        "is_superadmin": principal.is_superadmin,
        "can_create_spaces": principal.can_create_spaces,
        "timezone": principal.timezone,
    }


@router.post("/api/me/settings")
async def update_my_settings(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    """Update the signed-in principal's own settings (currently: preferred timezone)."""
    body = await json_body(request)
    tz_raw = body.get("timezone")
    if tz_raw is not None and not isinstance(tz_raw, str):
        raise bad_request("timezone must be a string or null")
    tz = (tz_raw or "").strip() or None
    if tz is not None and not is_valid_timezone(tz):
        raise bad_request("Unknown timezone")
    try:
        return rbac.set_user_timezone(principal.user_id, tz)
    except Exception as e:
        sys.stderr.write(f"me-settings error: {e}\n")
        raise HTTPException(500, str(e))


@router.get("/api/principals")
def list_principals(_p: Principal = Depends(auth.require_instance_admin)):
    """Superadmin-only: all principals + their server-level capabilities."""
    enrich_principal_identities()
    with domain_500():
        return {"principals": rbac.list_principals()}


@router.post("/api/principals/update")
async def principals_update(
    request: Request, _p: Principal = Depends(auth.require_instance_admin)
):
    body = await json_body(request)
    principal_id = str(body.get("principal_id") or "").strip()
    if not principal_id:
        raise bad_request("principal_id is required")
    if not isinstance(body.get("can_create_spaces"), bool):
        raise bad_request("can_create_spaces (boolean) is required")
    with value_400_domain_500():
        return rbac.set_can_create_spaces(principal_id, bool(body.get("can_create_spaces")))
