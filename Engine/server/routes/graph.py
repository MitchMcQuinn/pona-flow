"""Graph / schema read routes — pickers, existence checks, and step-flow reads.

These wrap Neo4j reads whose failures (driver missing, graph unreachable) are logged
and mapped to 500 via a catch-all, matching the original handler behavior.
"""

from __future__ import annotations

import sys
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.exceptions import HTTPException

from .. import auth, graph, schema_suspension, schema_update
from ..auth import Principal
from ..http_utils import (
    bad_request,
    node_label_in,
    require_read,
    require_space,
)

router = APIRouter()


@router.get("/api/graph/attributive-label-exists")
def attributive_label_exists(
    space_id: str = Query(""),
    node_label: str = Query(""),
    attributive_label: str = Query(""),
    exclude_id: str | None = Query(None),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_space(principal, space_id)
    al = (attributive_label or "").strip()
    if not al:
        return {"exists": False, "skipped": "empty attributive_label"}
    try:
        exists = graph.attributive_label_exists(
            sid, (node_label or "").strip(), al, (exclude_id or "").strip() or None
        )
    except Exception as e:
        sys.stderr.write(f"attributive-label-exists error: {e}\n")
        raise HTTPException(500, str(e))
    return {
        "space_id": sid,
        "node_label": (node_label or "").strip(),
        "attributive_label": al,
        "exists": exists,
    }


@router.get("/api/graph/id-exists")
def graph_id_exists(
    space_id: str = Query(""),
    id: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_space(principal, space_id)
    entity_id = (id or "").strip()
    if not entity_id:
        return {"exists": False, "skipped": "empty id"}
    try:
        exists = graph.graph_id_exists(sid, entity_id)
    except Exception as e:
        sys.stderr.write(f"graph-id-exists error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, "id": entity_id, "exists": exists}


@router.get("/api/graph/nodes-by-label")
def graph_nodes_by_label(
    space_id: str = Query(""),
    node_label: str = Query(""),
    attributive_label: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_space(principal, space_id)
    nl = (node_label or "").strip()
    if not nl:
        raise bad_request("Query parameter node_label is required")
    if node_label_in(nl):
        auth.require_flow(principal, sid, "read", nl)
    schema_al = (attributive_label or "").strip()
    try:
        if nl == "INSTANCE" and schema_al:
            nodes = graph.list_instance_targets(sid, schema_al)
        else:
            nodes = graph.list_graph_nodes_by_label(sid, nl)
    except Exception as e:
        sys.stderr.write(f"graph-nodes-by-label error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, "node_label": nl, "nodes": nodes}


@router.get("/api/graph/step-wrap-entity-id")
def graph_step_wrap_entity_id(
    space_id: str = Query(""),
    operation_id: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_space(principal, space_id)
    op_id = (operation_id or "").strip()
    if not op_id:
        raise bad_request("Query parameter operation_id is required")
    try:
        entity_id = graph.fetch_step_wrap_entity_id(sid, op_id)
    except Exception as e:
        sys.stderr.write(f"graph-step-wrap-entity-id error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, "operation_id": op_id, "entity_id": entity_id or ""}


@router.get("/api/graph/relationships-by-label")
def graph_relationships_by_label(
    space_id: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_space(principal, space_id)
    try:
        relationships = graph.list_graph_relationships_by_label(sid)
    except Exception as e:
        sys.stderr.write(f"graph-relationships-by-label error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, "relationships": relationships}


@router.get("/api/graph/step-relationships")
def graph_step_relationships(
    space_id: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "STEP")
    try:
        relationships = graph.list_step_graph_relationships(sid)
    except Exception as e:
        sys.stderr.write(f"graph-step-relationships error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, "relationships": relationships}


@router.get("/api/graph/schema-relationships")
def graph_schema_relationships(
    space_id: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "SCHEMA")
    try:
        relationships = graph.list_schema_graph_relationships(sid)
    except Exception as e:
        sys.stderr.write(f"graph-schema-relationships error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, "relationships": relationships}


@router.get("/api/graph/step-flow")
def graph_step_flow(
    space_id: str = Query(""),
    query_id: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "STEP")
    qid = (query_id or "").strip() or None
    try:
        step_graph = graph.fetch_step_flow_graph(sid, qid)
    except Exception as e:
        sys.stderr.write(f"graph-step-flow error: {e}\n")
        raise HTTPException(500, str(e))
    payload: dict[str, Any] = {"space_id": sid, "step_graph": step_graph}
    if qid:
        payload["query_id"] = qid
    # Surface which backing operations drifted from their SCHEMA so the client can highlight
    # the specific STEP nodes that need re-saving. ``affected_query_ids`` matches design-graph
    # step nodes via their payload.query_id; ``affected_step_labels`` matches result-graph STEP
    # nodes (single-step sequences) via attributive_label, since those carry no query_id.
    # Best-effort: never fail the graph fetch over it.
    try:
        payload["affected_query_ids"] = schema_suspension.affected_operation_ids(sid)
        payload["affected_step_labels"] = schema_suspension.affected_step_labels(sid)
    except Exception as e:
        sys.stderr.write(f"graph-step-flow affected-ids error: {e}\n")
        payload["affected_query_ids"] = []
        payload["affected_step_labels"] = []
    return payload


@router.get("/api/graph/step-outgoing")
def graph_step_outgoing(
    space_id: str = Query(""),
    attributive_label: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "STEP")
    al = (attributive_label or "").strip()
    if not al:
        raise bad_request("Query parameter attributive_label is required")
    try:
        edges = graph.list_step_outgoing(sid, al)
    except Exception as e:
        sys.stderr.write(f"graph-step-outgoing error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, "attributive_label": al, "edges": edges}


@router.get("/api/graph/property-keys")
def graph_property_keys(
    space_id: str = Query(""),
    entity_label: str = Query(""),
    entity_role: str = Query("node"),
    attributive_label: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "INSTANCE")
    el = (entity_label or "").strip()
    al = (attributive_label or "").strip()
    if not el or not al:
        raise bad_request(
            "Query parameters entity_label and attributive_label are required"
        )
    role = (entity_role or "node").strip()
    try:
        keys = graph.list_entity_property_keys(sid, el, al, role)
    except Exception as e:
        sys.stderr.write(f"graph-property-keys error: {e}\n")
        raise HTTPException(500, str(e))
    return {
        "space_id": sid,
        "entity_label": el,
        "entity_role": role,
        "attributive_label": al,
        "keys": keys,
    }


@router.get("/api/graph/property-values")
def graph_property_values(
    space_id: str = Query(""),
    entity_label: str = Query(""),
    entity_role: str = Query("node"),
    attributive_label: str = Query(""),
    property_key: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "INSTANCE")
    el = (entity_label or "").strip()
    al = (attributive_label or "").strip()
    pk = (property_key or "").strip()
    if not el or not al or not pk:
        raise bad_request(
            "Query parameters entity_label, attributive_label, and property_key are required"
        )
    role = (entity_role or "node").strip()
    try:
        values = graph.list_entity_property_values(sid, el, al, pk, role)
    except Exception as e:
        sys.stderr.write(f"graph-property-values error: {e}\n")
        raise HTTPException(500, str(e))
    return {
        "space_id": sid,
        "entity_label": el,
        "entity_role": role,
        "attributive_label": al,
        "property_key": pk,
        "values": values,
    }


@router.get("/api/graph/instance-property-exists")
def instance_property_exists(
    space_id: str = Query(""),
    attributive_label: str = Query(""),
    property_key: str = Query(""),
    value: str = Query(""),
    exclude_id: str | None = Query(None),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "INSTANCE")
    al = (attributive_label or "").strip()
    pk = (property_key or "").strip()
    if not al or not pk:
        return {"exists": False, "skipped": "missing attributive_label or property_key"}
    try:
        exists = graph.instance_property_exists(
            sid, al, pk, value or "", (exclude_id or "").strip() or None
        )
    except Exception as e:
        sys.stderr.write(f"instance-property-exists error: {e}\n")
        raise HTTPException(500, str(e))
    return {
        "space_id": sid,
        "attributive_label": al,
        "property_key": pk,
        "exists": exists,
    }


@router.get("/api/schema/definition")
def schema_definition(
    space_id: str = Query(""),
    attributive_label: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "SCHEMA")
    al = (attributive_label or "").strip()
    if not al:
        raise bad_request("Query parameter attributive_label is required")
    try:
        definition = graph.fetch_schema_definition(sid, al)
    except Exception as e:
        sys.stderr.write(f"schema-definition error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, **definition}


@router.get("/api/schema/outgoing")
def schema_outgoing(
    space_id: str = Query(""),
    attributive_label: str = Query(""),
    include_incoming: bool = Query(False),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "SCHEMA")
    al = (attributive_label or "").strip()
    if not al:
        raise bad_request("Query parameter attributive_label is required")
    try:
        edges = graph.list_schema_outgoing(sid, al, include_incoming)
    except Exception as e:
        sys.stderr.write(f"schema-outgoing error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, "attributive_label": al, "edges": edges}


@router.get("/api/schema/affected-operations")
def schema_affected_operations(
    space_id: str = Query(""),
    attributive_label: str = Query(""),
    principal: Principal = Depends(auth.current_principal),
):
    sid = require_read(principal, space_id, "SCHEMA")
    al = (attributive_label or "").strip()
    if not al:
        raise bad_request("Query parameter attributive_label is required")
    try:
        operations = schema_update.find_affected_create_instance_operations(al)
    except Exception as e:
        sys.stderr.write(f"schema-affected-operations error: {e}\n")
        raise HTTPException(500, str(e))
    return {"space_id": sid, "attributive_label": al, "operations": operations}
