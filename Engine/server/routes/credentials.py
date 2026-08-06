"""Credential routes (space managers).

Secure key/value secrets for a space, referenced from workflows as ``$secret.<NAME>``.
Values live in the credential store backend (locally the .env file); only metadata and
a ``configured`` flag are ever returned — never the secret value itself.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, credentials
from ..auth import Principal
from ..http_utils import (
    DOMAIN_ERRORS,
    bad_request,
    domain_500,
    json_body,
    require_path_space_id,
)

router = APIRouter()


@router.get("/api/spaces/{space_id}/credentials")
def credentials_list(
    space_id: str, principal: Principal = Depends(auth.current_principal)
):
    """List a space's credentials (metadata + ``configured``; the value is never returned)."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    with domain_500():
        return {
            "space_id": sid,
            "backend": credentials.active_backend(),
            "credentials": credentials.list_credentials(sid),
        }


@router.put("/api/spaces/{space_id}/credentials")
async def credentials_upsert(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Create/update a credential. ``value`` is written to the store (writable backends
    only) and never echoed back; omit it to register a slot for out-of-band injection."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    name = str(body.get("name") or "").strip()
    if not name:
        raise bad_request("name is required")
    value = body.get("value")
    description = body.get("description")
    try:
        return credentials.upsert_credential(
            sid, name, value=value, description=description
        )
    except ValueError as e:
        raise bad_request(str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.delete("/api/spaces/{space_id}/credentials/{name}")
def credentials_delete(
    space_id: str,
    name: str,
    principal: Principal = Depends(auth.current_principal),
):
    """Delete a credential's value and metadata (idempotent)."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    try:
        return credentials.delete_credential(sid, name)
    except ValueError as e:
        raise bad_request(str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))
