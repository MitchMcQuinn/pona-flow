"""Catalog query routes — saved packages, descriptions, ordering, sequence delete."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, catalog, config, schema_workflow, spaces
from ..auth import Principal
from ..http_utils import (
    bad_request,
    domain_500,
    json_body,
    require_body_space_id,
    value_400_domain_500,
)

router = APIRouter()


@router.get("/api/queries")
def queries(_p: Principal = Depends(auth.current_principal)):
    with domain_500():
        saved = catalog.fetch_saved_queries()
    return {
        "catalog_sqlite_env_key": config.catalog_sqlite_env_key(),
        "queries": saved,
    }


@router.post("/api/queries/upsert")
async def queries_upsert(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    row_id = str(body.get("id") or "").strip()
    if not row_id:
        raise bad_request("id is required")
    cypher = body.get("cypher") or []
    sqlite_stmts = body.get("sqlite") or []
    parameters = body.get("parameters") or []
    if not isinstance(cypher, list) or not isinstance(sqlite_stmts, list):
        raise bad_request("cypher and sqlite must be arrays")
    # Declarative builder snapshot for round-trip editing; serialize to a JSON string
    # (the catalog column enforces json_valid). Absent/invalid -> "{}".
    builder_config_raw = body.get("builder_config")
    builder_config_json = (
        json.dumps(builder_config_raw) if builder_config_raw is not None else None
    )
    space_id = str(body.get("space_id") or "").strip()
    group_title = str(body.get("group_title") or "").strip()
    kind = str(body.get("kind") or "user").strip().lower()
    if space_id:
        auth.require_space_access(principal, space_id)
        # A sequence's name becomes its STEP node's attributive_label, which must be unique
        # within the underlying graph. Reject names already used by another sequence in any
        # space that shares this space's graph.
        if kind == "sequence":
            conflict = spaces.sequence_name_conflict(
                space_id, str(body.get("name") or ""), exclude_id=row_id
            )
            if conflict:
                raise bad_request(
                    f"A sequence named {conflict!r} already exists in a space sharing "
                    "this graph. Choose a different name."
                )
        # Group titles are unique within a space; collapse case-only variants onto the
        # existing canonical title so the nav files this query under one group.
        if group_title:
            group_title = spaces.canonical_group_title(space_id, group_title)
    with domain_500():
        result = catalog.upsert_queries_catalog_row(
            row_id,
            str(body.get("name") or ""),
            [str(s) for s in cypher],
            [str(s) for s in sqlite_stmts],
            parameters if isinstance(parameters, list) else [],
            kind=kind,
            operation=str(body.get("operation") or "read"),
            runtime_enabled=catalog.queries_catalog_runtime_enabled_int(body),
            author_selectable=catalog.queries_catalog_author_selectable_int(body),
            group_title=group_title or None,
            triggerable=catalog.queries_catalog_triggerable_int(body),
            builder_config=builder_config_json,
            description=str(body.get("description") or ""),
        )
        if space_id and group_title:
            spaces.append_space_group(space_id, group_title)
    # Re-saving an INSTANCE operation may bring it (and any sequence that uses it) back into
    # conformance with its SCHEMA; release any suspended op/sequence that no longer drifts.
    if space_id and kind == "operation":
        released = schema_workflow.refresh_after_operation_save(space_id)
        if released is not None:
            result["suspension"] = released
    return result


@router.get("/api/queries/{query_id}")
def query_package(query_id: str, _p: Principal = Depends(auth.current_principal)):
    """Load one catalog query's full package, including builder_config, so the builder
    can round-trip an operation-backed STEP back into a (locked) edit view."""
    with domain_500():
        package = catalog.fetch_query_package(query_id)
    if package is None:
        raise HTTPException(404, "query not found")
    return package


@router.post("/api/queries/{query_id}/description")
async def queries_update_description(
    query_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Post-hoc edit of a saved sequence's (or operation's) description only.

    Kept separate from the full upsert so editing prose can't clobber the composed
    cypher/parameters/builder_config. Requires access to the named space, mirroring
    the upsert route's gate.
    """
    body = await json_body(request)
    space_id = require_body_space_id(body)
    auth.require_space_access(principal, space_id)
    with value_400_domain_500():
        return catalog.update_query_description(
            query_id, str(body.get("description") or "")
        )


@router.post("/api/sequence/delete")
async def sequence_delete(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    """Remove a sequence's definition only (its catalog row + composed state packages),
    leaving the underlying STEP nodes/graph intact. This is the "remove from the nav"
    delete; the cascading variant lives at ``/api/step/delete``. Gated on access to the
    named space, mirroring the sequence upsert route."""
    body = await json_body(request)
    sequence_id = str(body.get("id") or "").strip()
    space_id = str(body.get("space_id") or "").strip()
    if not sequence_id:
        raise bad_request("id is required")
    if not space_id:
        raise bad_request("space_id is required")
    auth.require_space_access(principal, space_id)
    with value_400_domain_500():
        return catalog.delete_sequence(sequence_id)


@router.post("/api/queries/reorder")
async def queries_reorder(
    request: Request, _p: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    items = body.get("items")
    if not isinstance(items, list):
        raise bad_request("items must be an array")
    normalized = [item for item in items if isinstance(item, dict)]
    with domain_500():
        return catalog.reorder_queries(normalized)


@router.get("/api/generate-id")
def generate_id(_p: Principal = Depends(auth.current_principal)):
    try:
        return {"id": config.generate_entity_id()}
    except (ImportError, OSError) as e:
        raise HTTPException(500, str(e))
