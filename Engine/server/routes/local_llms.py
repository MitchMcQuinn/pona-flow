"""Local LLM config routes (named Ollama setups per space)."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, local_llms
from ..auth import Principal
from ..http_utils import (
    DOMAIN_ERRORS,
    bad_request,
    json_body,
    require_path_space_id,
    value_400_domain_500,
)

router = APIRouter()

_UNAVAILABLE_STATUS = 503


@router.get("/api/spaces/{space_id}/local-llms/health")
async def local_llms_health(
    space_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    """Whether Ollama answers for this space's configured URL (never raises on down)."""
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    return await asyncio.to_thread(local_llms.health, sid)


@router.get("/api/spaces/{space_id}/local-llms/models")
async def local_llms_models(
    space_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    """Models Ollama has pulled (for the editor dropdown)."""
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    try:
        models = await asyncio.to_thread(local_llms.list_models, sid)
        return {"space_id": sid, "models": models}
    except local_llms.LocalLlmUnavailable as e:
        raise HTTPException(_UNAVAILABLE_STATUS, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.get("/api/spaces/{space_id}/local-llms")
async def local_llms_list(
    space_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    with value_400_domain_500():
        configs = await asyncio.to_thread(local_llms.list_configs, sid)
        return {"space_id": sid, "configs": configs}


@router.post("/api/spaces/{space_id}/local-llms")
async def local_llms_create(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    try:
        return await asyncio.to_thread(local_llms.create_config, sid, body)
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.get("/api/spaces/{space_id}/local-llms/{config_id}")
async def local_llms_get(
    space_id: str,
    config_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    try:
        return await asyncio.to_thread(local_llms.get_config, sid, config_id)
    except local_llms.ConfigNotFound as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.put("/api/spaces/{space_id}/local-llms/{config_id}")
async def local_llms_replace(
    space_id: str,
    config_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    try:
        return await asyncio.to_thread(local_llms.replace_config, sid, config_id, body)
    except local_llms.ConfigNotFound as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.delete("/api/spaces/{space_id}/local-llms/{config_id}")
async def local_llms_delete(
    space_id: str,
    config_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    try:
        await asyncio.to_thread(local_llms.delete_config, sid, config_id)
        return {"ok": True, "id": config_id}
    except local_llms.ConfigNotFound as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.post("/api/spaces/{space_id}/local-llms/{config_id}/run")
async def local_llms_run(
    space_id: str,
    config_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Test-run a saved config: ``{"prompt": "..."}``."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    prompt = body.get("prompt")
    if prompt is None:
        raise bad_request("prompt is required")
    try:
        return await asyncio.to_thread(local_llms.run_config, sid, config_id, str(prompt))
    except local_llms.ConfigNotFound as e:
        raise HTTPException(404, str(e))
    except local_llms.LocalLlmUnavailable as e:
        raise HTTPException(_UNAVAILABLE_STATUS, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))
