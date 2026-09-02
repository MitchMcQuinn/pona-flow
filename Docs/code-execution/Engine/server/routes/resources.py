"""Code resource routes (space members).

User-authored scripts behind code-execution STEPs. The code text lives in the
gitignored resources folder; the catalog ``resources`` table maps UID -> file +
name/description. Saving code here never executes it — execution happens only in the
sandbox runner during a sequence run.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, resources
from ..auth import Principal
from ..http_utils import (
    DOMAIN_ERRORS,
    bad_request,
    domain_500,
    json_body,
    require_path_space_id,
    value_400_domain_500,
)

router = APIRouter()


@router.get("/api/spaces/{space_id}/resources")
def resources_list(
    space_id: str, principal: Principal = Depends(auth.current_principal)
):
    """List a space's code resources (metadata only)."""
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    with domain_500():
        return {"space_id": sid, "resources": resources.list_resources(sid)}


@router.get("/api/spaces/{space_id}/resources/{resource_id}")
def resources_get(
    space_id: str,
    resource_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    """Fetch one resource including its code text (for the builder editor)."""
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    try:
        return resources.get_resource(sid, resource_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.put("/api/spaces/{space_id}/resources")
async def resources_upsert(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Create/update a code resource (writes the gitignored file + catalog row)."""
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    body = await json_body(request)
    try:
        return resources.upsert_resource(
            sid,
            name=str(body.get("name") or ""),
            code=str(body.get("code") or ""),
            language=str(body.get("language") or ""),
            description=str(body.get("description") or ""),
            resource_id=(str(body.get("resource_id") or "").strip() or None),
        )
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.delete("/api/spaces/{space_id}/resources/{resource_id}")
def resources_delete(
    space_id: str,
    resource_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    """Delete a resource's file and catalog row (idempotent)."""
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    with value_400_domain_500():
        return resources.delete_resource(sid, resource_id)
