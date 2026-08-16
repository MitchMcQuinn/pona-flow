"""Vector search routes (local Ollama embeddings over INSTANCE records).

Two operations, deliberately not QUERY-builder operations: **reindex** (maintenance, so
space-manage) and **search** (a read, so the ordinary ``read:INSTANCE`` flow). A sequence
that wants "find similar, then traverse" calls search, takes the ids, and does its own
``MATCH`` — the search itself never walks ``POINTS_TO``.

See Docs/VECTORIZATION-VISION.md. Embedding work is an engine primitive rather than an
authorable sequence: it reads SCHEMA payloads from SQLite, writes reserved graph
properties, and talks to a localhost service that endpoint STEPs are barred from (D7).
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, embeddings
from ..auth import Principal
from ..http_utils import (
    DOMAIN_ERRORS,
    bad_request,
    json_body,
    require_path_space_id,
)

router = APIRouter()

# Ollama being down is a dependency failure, not a bug in the request.
_UNAVAILABLE_STATUS = 503


@router.get("/api/spaces/{space_id}/embeddings/config")
async def embeddings_config_get(
    space_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    """The space's effective vector-search settings.

    ``source`` says whether they are the space's own or inherited from the instance
    environment; ``dimensions`` is probed on save, never typed.
    """
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    try:
        return await asyncio.to_thread(embeddings.resolve_config, sid)
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@router.post("/api/spaces/{space_id}/embeddings/config")
async def embeddings_config_set(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Save vector-search settings and reconcile the index: ``{enabled, ollama_url?, embed_model?}``.

    Enabling probes the model, so a wrong model name or a down Ollama is rejected here
    rather than discovered on the first reindex.
    """
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    if "enabled" not in body:
        raise bad_request("enabled is required")
    ollama_url = body.get("ollama_url")
    embed_model = body.get("embed_model")
    try:
        return await asyncio.to_thread(
            embeddings.apply_space_config,
            sid,
            enabled=bool(body.get("enabled")),
            ollama_url=str(ollama_url).strip() if ollama_url is not None else None,
            embed_model=str(embed_model).strip() if embed_model is not None else None,
        )
    except embeddings.EmbeddingsUnavailable as e:
        raise HTTPException(_UNAVAILABLE_STATUS, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.get("/api/spaces/{space_id}/embeddings/health")
async def embeddings_health(
    space_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    """Report whether Ollama answers, and the configured model's vector width.

    Never raises for a down/misconfigured Ollama — the failure is the payload, so the UI
    can show it as status rather than an error toast.
    """
    sid = require_path_space_id(space_id)
    auth.require_space_access(principal, sid)
    return await asyncio.to_thread(embeddings.health, sid)


@router.post("/api/spaces/{space_id}/embeddings/reindex")
async def embeddings_reindex(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Embed INSTANCE records and return counts.

    With ``attributive_label`` this indexes one type; without it, every vectorized SCHEMA in
    the space. Dimensions are probed before any graph write, so a down Ollama or a
    non-embedding model fails here instead of half-filling the index.
    """
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    attributive_label = str(body.get("attributive_label") or "").strip()
    kind = str(body.get("kind") or embeddings.KIND_NODE).strip()
    try:
        if not attributive_label:
            return await asyncio.to_thread(embeddings.reindex_space, sid)
        return await asyncio.to_thread(
            embeddings.reindex_label, sid, attributive_label, kind=kind
        )
    except embeddings.EmbeddingsUnavailable as e:
        raise HTTPException(_UNAVAILABLE_STATUS, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.post("/api/spaces/{space_id}/embeddings/search")
async def embeddings_search(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Nearest-neighbour search: ``{text, k?, attributive_label?, kind?}``.

    Passing ``attributive_label`` is recommended. The shared ``:INSTANCE`` index mixes
    every vectorized type, so an unfiltered search ranks CUSTOMERs against NOTEs.
    """
    sid = require_path_space_id(space_id)
    auth.require_flow(principal, sid, "read", "INSTANCE")
    body = await json_body(request)
    text = str(body.get("text") or "").strip()
    if not text:
        raise bad_request("text is required")
    kind = str(body.get("kind") or embeddings.KIND_NODE).strip()
    attributive_label = str(body.get("attributive_label") or "").strip()
    raw_k = body.get("k")
    k = embeddings.SEARCH_DEFAULT_K if raw_k in (None, "") else raw_k
    try:
        return await asyncio.to_thread(
            embeddings.search,
            sid,
            text,
            k=k,
            attributive_label=attributive_label or None,
            kind=kind,
        )
    except embeddings.EmbeddingsUnavailable as e:
        # A similarity query cannot degrade the way a write can: the query text has to be
        # embedded with the same model, so there is no partial answer to return.
        raise HTTPException(_UNAVAILABLE_STATUS, str(e))
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
