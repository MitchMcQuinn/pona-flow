"""Space registry routes — CRUD plus per-space record/connections/labels/groups."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import HTTPException

from .. import auth, config, rbac, spaces
from ..auth import Principal
from ..http_utils import (
    DOMAIN_ERRORS,
    bad_request,
    domain_500,
    json_body,
    require_body_space_id,
    require_query_space_id,
    value_400_domain_500,
)

router = APIRouter()


@router.get("/api/spaces")
def list_spaces(principal: Principal = Depends(auth.current_principal)):
    with domain_500():
        space_list = spaces.fetch_spaces()
    if not principal.is_instance_admin:
        allowed = auth.member_space_ids(principal.user_id)
        space_list = [s for s in space_list if s.get("id") in allowed]
    return {
        "catalog_sqlite_env_key": config.catalog_sqlite_env_key(),
        "spaces": space_list,
    }


@router.post("/api/spaces/create")
async def create_space(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    auth.require_can_create_spaces(principal)
    body = await json_body(request)
    name = str(body.get("name") or "").strip()
    if not name:
        raise bad_request("name is required")
    endpoint = None
    if body.get("endpoint") is not None:
        endpoint = str(body.get("endpoint")).strip() or None
    labels: list[str] | None = None
    if body.get("labels") is not None:
        if not isinstance(body.get("labels"), list):
            raise bad_request("labels must be an array")
        labels = [str(i).strip() for i in body["labels"] if str(i).strip()]
    description = str(body.get("description") or "") if body.get("description") is not None else None
    with value_400_domain_500():
        result = spaces.create_space(name, endpoint, labels, description=description)
    # Seed the space's default roles (Admin/Member); the creator becomes the owner
    # and is assigned the Admin role.
    new_id = str(result.get("id") or "").strip()
    if new_id:
        roles = rbac.seed_default_roles(new_id)
        auth.add_space_member(
            new_id,
            principal.user_id,
            is_owner=True,
            role_id=roles.get(rbac.ADMIN_ROLE_NAME),
        )
    return result


@router.post("/api/spaces/update")
async def update_space(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    space_id = require_body_space_id(body, allow_id=True)
    auth.require_space_manage(principal, space_id)
    name = str(body.get("name") or "").strip()
    if not name:
        raise bad_request("name is required")
    endpoint = None
    if body.get("endpoint") is not None:
        endpoint = str(body.get("endpoint")).strip() or None
    set_labels = "labels" in body
    labels: list[str] | None = None
    if set_labels:
        if body.get("labels") is not None and not isinstance(body.get("labels"), list):
            raise bad_request("labels must be an array")
        labels = [str(i).strip() for i in (body.get("labels") or []) if str(i).strip()]
    set_description = "description" in body
    description = str(body.get("description") or "") if set_description else None
    set_dev_mode = "dev_mode" in body
    dev_mode = False
    if set_dev_mode:
        raw_dev_mode = body.get("dev_mode")
        if isinstance(raw_dev_mode, bool):
            dev_mode = raw_dev_mode
        elif raw_dev_mode in (0, 1):
            dev_mode = bool(raw_dev_mode)
        else:
            raise bad_request("dev_mode must be a boolean")
    set_hide_empty = "hide_empty_sequence_groups" in body
    hide_empty = False
    if set_hide_empty:
        raw_hide_empty = body.get("hide_empty_sequence_groups")
        if isinstance(raw_hide_empty, bool):
            hide_empty = raw_hide_empty
        elif raw_hide_empty in (0, 1):
            hide_empty = bool(raw_hide_empty)
        else:
            raise bad_request("hide_empty_sequence_groups must be a boolean")
    with value_400_domain_500():
        return spaces.update_space(
            space_id,
            name,
            endpoint,
            labels,
            set_labels=set_labels,
            description=description,
            set_description=set_description,
            dev_mode=dev_mode,
            set_dev_mode=set_dev_mode,
            hide_empty_sequence_groups=hide_empty,
            set_hide_empty_sequence_groups=set_hide_empty,
        )


@router.post("/api/spaces/delete")
async def delete_space(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    space_id = require_body_space_id(body, allow_id=True)
    auth.require_space_manage(principal, space_id)
    with value_400_domain_500():
        return spaces.delete_space(space_id)


@router.get("/api/space/record")
def space_record(
    space_id: str = Query(...), principal: Principal = Depends(auth.current_principal)
):
    sid = require_query_space_id(space_id)
    auth.require_space_access(principal, sid)
    try:
        return spaces.fetch_space_record(sid)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.get("/api/space/connections")
def space_connections(
    space_id: str = Query(...), principal: Principal = Depends(auth.current_principal)
):
    sid = require_query_space_id(space_id)
    auth.require_space_access(principal, sid)
    with domain_500():
        return spaces.space_connections_payload(sid)


@router.get("/api/spaces/shared-sequence-labels")
def shared_sequence_labels(_p: Principal = Depends(auth.current_principal)):
    with domain_500():
        return {"labels": spaces.fetch_shared_sequence_labels()}


@router.get("/api/space/labels")
def space_labels(
    space_id: str = Query(...), principal: Principal = Depends(auth.current_principal)
):
    sid = require_query_space_id(space_id)
    auth.require_space_access(principal, sid)
    with domain_500():
        return {"space_id": sid, "labels": spaces.fetch_space_labels(sid)}


@router.get("/api/space/groups")
def space_groups(
    space_id: str = Query(...), principal: Principal = Depends(auth.current_principal)
):
    sid = require_query_space_id(space_id)
    auth.require_space_access(principal, sid)
    with domain_500():
        return {"space_id": sid, "groups": spaces.fetch_space_groups(sid)}


@router.post("/api/space/groups")
async def set_space_groups(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    space_id = require_body_space_id(body)
    auth.require_space_access(principal, space_id)
    groups = body.get("groups")
    if not isinstance(groups, list):
        raise bad_request("groups must be an array")
    with domain_500():
        result = spaces.set_space_groups(space_id, [str(g) for g in groups])
    return {"space_id": space_id, **result}
