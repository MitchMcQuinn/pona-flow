"""Agent API key routes (space managers)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from .. import agent_keys, auth
from ..auth import Principal
from ..http_utils import (
    bad_request,
    domain_500,
    json_body,
    require_path_space_id,
    value_400_domain_500,
)

router = APIRouter()


@router.get("/api/spaces/{space_id}/agent-keys")
def agent_keys_list(
    space_id: str, principal: Principal = Depends(auth.current_principal)
):
    """List a space's agent keys (metadata only; the token is never returned)."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    with domain_500():
        return {"space_id": sid, "keys": agent_keys.list_keys(sid)}


@router.post("/api/spaces/{space_id}/agent-keys")
async def agent_keys_create(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Mint a new agent key. The plaintext token is returned ONCE (only its hash is
    stored); an optional ``role_id`` sets which sequences the agent may run."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    name = str(body.get("name") or "").strip()
    if not name:
        raise bad_request("name is required")
    role_id = str(body.get("role_id") or "").strip() or None
    with value_400_domain_500():
        return agent_keys.mint_key(sid, name, role_id=role_id)


@router.delete("/api/spaces/{space_id}/agent-keys/{key_id}")
def agent_keys_delete(
    space_id: str,
    key_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    """Revoke an agent key (idempotent)."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    with value_400_domain_500():
        return agent_keys.revoke_key(sid, key_id)
