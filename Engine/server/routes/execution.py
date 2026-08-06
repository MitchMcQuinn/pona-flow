"""Package execution routes — create/mutation packages and sequence compose/run."""

from __future__ import annotations

import sqlite3
import sys

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, catalog, cypher_utils, execution, packages, schema_currency
from ..auth import Principal
from ..http_utils import bad_request, infer_node_label, json_body, require_body_space_id

router = APIRouter()


@router.post("/api/execute-create")
async def execute_create(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    space_id = require_body_space_id(body)
    auth.require_flow(principal, space_id, "create", infer_node_label(body))
    cypher_statements = body.get("cypher") or []
    sqlite_statements = body.get("sqlite") or []
    if not isinstance(cypher_statements, list) or not isinstance(sqlite_statements, list):
        raise bad_request("cypher and sqlite must be arrays")
    cypher_params = body.get("cypher_params") or {}
    if not isinstance(cypher_params, dict):
        raise bad_request("cypher_params must be an object")
    queries_catalog = body.get("queries_catalog")
    if queries_catalog is not None and not isinstance(queries_catalog, dict):
        raise bad_request("queries_catalog must be an object")
    attributive_labels = body.get("attributive_labels")
    if attributive_labels is not None:
        if not isinstance(attributive_labels, list):
            raise bad_request("attributive_labels must be an array")
        attributive_labels = [
            str(i).strip() for i in attributive_labels if str(i).strip()
        ]
    try:
        result = packages.execute_create_package(
            space_id,
            [str(s) for s in cypher_statements],
            [str(s) for s in sqlite_statements],
            cypher_params,
            queries_catalog=queries_catalog,
            attributive_labels=attributive_labels,
        )
    except (RuntimeError, sqlite3.Error, KeyError, ValueError) as e:
        raise HTTPException(500, str(e))
    return {"space_id": space_id, "result": result}


@router.post("/api/execute-query")
async def execute_query(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    space_id = require_body_space_id(body)
    cypher_statements = body.get("cypher") or []
    sqlite_statements = body.get("sqlite") or []
    if not isinstance(cypher_statements, list) or not isinstance(sqlite_statements, list):
        raise bad_request("cypher and sqlite must be arrays")
    cypher_params = body.get("cypher_params") or {}
    if not isinstance(cypher_params, dict):
        raise bad_request("cypher_params must be an object")
    operation = str(body.get("operation") or "read").strip().lower()
    if operation not in ("read", "update", "delete"):
        raise bad_request("operation must be read, update, or delete")
    auth.require_flow(principal, space_id, operation, infer_node_label(body))
    try:
        result = packages.execute_mutation_package(
            space_id,
            [str(s) for s in cypher_statements],
            [str(s) for s in sqlite_statements],
            cypher_params,
            operation=operation,
        )
    except (RuntimeError, sqlite3.Error, KeyError, ValueError) as e:
        raise HTTPException(500, str(e))
    # After an INSTANCE update, release the is_current marker from any instance of the
    # touched label(s) that now fully conforms to its SCHEMA (filled in the required property).
    if operation == "update" and infer_node_label(body) == "INSTANCE":
        labels: set[str] = set()
        for stmt in cypher_statements:
            for m in cypher_utils.ATTR_LABEL_RE.finditer(str(stmt or "")):
                label = m.group(1).strip()
                if label:
                    labels.add(label)
        schema_currency.reconcile_labels(space_id, labels)
    return {"space_id": space_id, "result": result}


@router.post("/api/sequence/compose")
async def sequence_compose(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    space_id = require_body_space_id(body)
    query_id = (str(body.get("query_id") or "")).strip()
    if not query_id:
        raise bad_request("query_id is required")
    # Composing walks the STEP chain (a read), and the resulting package may only be
    # run if the principal can run that sequence.
    auth.require_flow(principal, space_id, "read", "STEP")
    auth.require_sequence_run(principal, space_id, query_id)
    try:
        return execution.compose_and_store(space_id, query_id, owner_id=principal.user_id)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except Exception as e:
        sys.stderr.write(f"sequence-compose error: {e}\n")
        raise HTTPException(500, str(e))


@router.post("/api/sequence/run")
async def sequence_run(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    space_id = require_body_space_id(body)
    state_id = (str(body.get("state_id") or "")).strip()
    params = body.get("params")
    if not isinstance(params, dict):
        params = {}
    if not state_id:
        raise bad_request("state_id is required")
    auth.require_space_access(principal, space_id)
    # Gate on the sequence behind this state package (superadmin/owner bypass inside).
    if not principal.is_superadmin:
        stored = catalog.fetch_state_package(state_id)
        seq_id = str((stored or {}).get("package", {}).get("sequence_query_id") or "").strip()
        if seq_id:
            auth.require_sequence_run(principal, space_id, seq_id)
    try:
        return execution.run_execution(
            space_id, state_id, params, principal_id=principal.user_id
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except Exception as e:
        sys.stderr.write(f"sequence-run error: {e}\n")
        raise HTTPException(500, str(e))
