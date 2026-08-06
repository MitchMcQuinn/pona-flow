"""RBAC routes — space permissions, members, and roles."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from .. import auth, rbac
from ..auth import Principal
from ..http_utils import (
    bad_request,
    domain_500,
    enrich_principal_identities,
    json_body,
    require_query_space_id,
    value_400_domain_500,
)

router = APIRouter()


@router.get("/api/space/permissions")
def space_permissions(
    space_id: str = Query(...), principal: Principal = Depends(auth.current_principal)
):
    """The caller's effective permissions in a space (drives UI gating)."""
    sid = require_query_space_id(space_id)
    auth.require_space_access(principal, sid)
    return {
        "space_id": sid,
        "permissions": auth.effective_permissions(principal, sid),
        "flows": list(rbac.ALL_FLOWS),
        "operations": list(rbac.OPERATIONS),
        "elements": list(rbac.ELEMENTS),
        "is_superadmin": principal.is_superadmin,
    }


@router.get("/api/space/members")
def space_members(
    space_id: str = Query(...), principal: Principal = Depends(auth.current_principal)
):
    sid = require_query_space_id(space_id)
    auth.require_space_manage(principal, sid)
    enrich_principal_identities()
    with domain_500():
        return {"space_id": sid, "members": rbac.list_members(sid)}


@router.post("/api/space/members/invite")
async def space_members_invite(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    sid = str(body.get("space_id") or "").strip()
    email = str(body.get("email") or "").strip()
    role_id = str(body.get("role_id") or "").strip() or None
    if not sid:
        raise bad_request("space_id is required")
    if not email:
        raise bad_request("email is required")
    auth.require_space_manage(principal, sid)
    with value_400_domain_500():
        return rbac.invite_member(sid, email, role_id=role_id)


@router.post("/api/space/members/update")
async def space_members_update(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    sid = str(body.get("space_id") or "").strip()
    member_id = str(body.get("member_id") or "").strip()
    if not sid or not member_id:
        raise bad_request("space_id and member_id are required")
    auth.require_space_manage(principal, sid)
    role_id = body.get("role_id")
    override = body.get("permissions_override")
    if override is not None and not isinstance(override, dict):
        raise bad_request("permissions_override must be an object")
    is_owner = body.get("is_owner")
    # Ownership changes (grant OR revoke) are owner-only; a non-owner manager must
    # not be able to promote themselves or demote owners.
    if isinstance(is_owner, bool):
        auth.require_space_owner(principal, sid)
    with value_400_domain_500():
        return rbac.update_member(
            sid,
            member_id,
            role_id=(str(role_id).strip() if role_id is not None else None),
            permissions_override=override if isinstance(override, dict) else None,
            is_owner=(bool(is_owner) if isinstance(is_owner, bool) else None),
            clear_override=bool(body.get("clear_override")),
        )


@router.post("/api/space/members/remove")
async def space_members_remove(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    sid = str(body.get("space_id") or "").strip()
    member_id = str(body.get("member_id") or "").strip()
    if not sid or not member_id:
        raise bad_request("space_id and member_id are required")
    auth.require_space_manage(principal, sid)
    with value_400_domain_500():
        return rbac.remove_member(sid, member_id)


@router.get("/api/space/roles")
def space_roles(
    space_id: str = Query(...), principal: Principal = Depends(auth.current_principal)
):
    sid = require_query_space_id(space_id)
    auth.require_space_manage(principal, sid)
    with domain_500():
        return {"space_id": sid, "roles": rbac.list_roles(sid)}


@router.post("/api/space/roles/upsert")
async def space_roles_upsert(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    sid = str(body.get("space_id") or "").strip()
    name = str(body.get("name") or "").strip()
    if not sid or not name:
        raise bad_request("space_id and name are required")
    auth.require_space_manage(principal, sid)
    permissions = body.get("permissions")
    if permissions is not None and not isinstance(permissions, dict):
        raise bad_request("permissions must be an object")
    with value_400_domain_500():
        return rbac.upsert_role(
            sid,
            name,
            permissions if isinstance(permissions, dict) else {},
            role_id=str(body.get("id") or "").strip() or None,
        )


@router.post("/api/space/roles/delete")
async def space_roles_delete(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    sid = str(body.get("space_id") or "").strip()
    role_id = str(body.get("role_id") or "").strip()
    if not sid or not role_id:
        raise bad_request("space_id and role_id are required")
    auth.require_space_manage(principal, sid)
    with value_400_domain_500():
        return rbac.delete_role(sid, role_id)
