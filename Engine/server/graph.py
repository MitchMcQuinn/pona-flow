"""
Neo4j graph access and validation for the React QUERY builder.

Purpose in the project
----------------------
The QUERY package builder must enforce graph conventions before CREATE:

- Globally unique ``attributive_label`` across STEP, SCHEMA, and POINTS_TO relationships
- Globally unique ``id`` on STEP/SCHEMA nodes and POINTS_TO relationships
- Pick-lists of existing STEP/SCHEMA/INSTANCE nodes for relationship wiring

This module runs parameterized Cypher against the **per-space** Neo4j database
(resolved via ``spaces.neo4j_config_for_space``). It also executes arbitrary Cypher
statement lists when the user submits a package via ``POST /api/execute-create``.

Importance
----------
Graph logic is isolated here so HTTP code stays thin and Neo4j can be optional at
install time (``pip install neo4j``). If the driver is missing, graph endpoints and
package execution fail with a clear runtime error while catalog/SQLite APIs still work.
"""

from __future__ import annotations

import json
import re
from typing import Any

try:
    from neo4j import GraphDatabase
    from neo4j.exceptions import Neo4jError
except ImportError:
    GraphDatabase = None  # type: ignore[misc, assignment]
    Neo4jError = Exception  # type: ignore[misc, assignment]

from . import cypher_utils, spaces

NEO4J_AVAILABLE = GraphDatabase is not None

GRAPH_REL_TYPE = "POINTS_TO"


def _require_neo4j() -> None:
    if GraphDatabase is None:
        raise RuntimeError("Missing dependency: install with `pip install neo4j`.")


def _record_data(record) -> dict[str, Any]:
    if hasattr(record, "data"):
        return dict(record.data())
    return {key: record[key] for key in record.keys()}


def _collect_graph_entities(value, nodes: dict[str, Any], rels: dict[str, Any]) -> None:
    """
    Walk a returned Cypher value and accumulate Neo4j Node/Relationship/Path entities,
    keyed by element_id, so the UI can render an actual graph (with edges) via d3.

    ``record.data()`` flattens nodes/relationships into plain property maps and loses
    identity + connectivity, so we inspect the live driver objects instead.
    """
    try:
        from neo4j.graph import Node, Relationship, Path
    except Exception:  # noqa: BLE001 - neo4j missing/older; skip structured graph.
        return

    if isinstance(value, Node):
        nodes.setdefault(
            value.element_id,
            {
                "element_id": value.element_id,
                "labels": list(value.labels),
                "properties": dict(value),
            },
        )
    elif isinstance(value, Relationship):
        if value.start_node is not None:
            _collect_graph_entities(value.start_node, nodes, rels)
        if value.end_node is not None:
            _collect_graph_entities(value.end_node, nodes, rels)
        rels.setdefault(
            value.element_id,
            {
                "element_id": value.element_id,
                "type": value.type,
                "start": value.start_node.element_id if value.start_node else None,
                "end": value.end_node.element_id if value.end_node else None,
                "properties": dict(value),
            },
        )
    elif isinstance(value, Path):
        for node in value.nodes:
            _collect_graph_entities(node, nodes, rels)
        for rel in value.relationships:
            _collect_graph_entities(rel, nodes, rels)
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            _collect_graph_entities(item, nodes, rels)
    elif isinstance(value, dict):
        for item in value.values():
            _collect_graph_entities(item, nodes, rels)


def run_cypher_for_space(
    space_id: str, cypher: str, params: dict[str, Any] | None = None
) -> dict[str, Any]:
    """
    Execute one Cypher statement for a space; return records and summary counters.

    Used by validation helpers and by package execution (``packages.execute_create_package``).
    """
    _require_neo4j()
    cfg = spaces.neo4j_config_for_space(space_id)
    params = params or {}
    driver = GraphDatabase.driver(cfg["uri"], auth=(cfg["user"], cfg["password"]))
    try:
        with driver.session() as session:
            result = session.run(cypher, params)
            records: list[dict[str, Any]] = []
            graph_nodes: dict[str, Any] = {}
            graph_rels: dict[str, Any] = {}
            for record in result:
                records.append(_record_data(record))
                for value in record.values():
                    _collect_graph_entities(value, graph_nodes, graph_rels)
            _enrich_graph_nodes_display_labels(space_id, graph_nodes)
            summary = result.consume()
            return {
                "records": records,
                "graph": {
                    "nodes": list(graph_nodes.values()),
                    "relationships": list(graph_rels.values()),
                },
                "summary": {
                    "query_type": summary.query_type,
                    "counters": {
                        "nodes_created": summary.counters.nodes_created,
                        "nodes_deleted": summary.counters.nodes_deleted,
                        "relationships_created": summary.counters.relationships_created,
                        "relationships_deleted": summary.counters.relationships_deleted,
                    },
                },
            }
    except Neo4jError as e:
        raise RuntimeError(f"Neo4j error: {e}") from e
    finally:
        driver.close()


def attributive_label_exists(
    space_id: str,
    node_label: str,
    attributive_label: str,
    exclude_id: str | None = None,
) -> bool:
    """Return True if any STEP/SCHEMA node or POINTS_TO rel already uses this attributive_label.

    Uniqueness is global across STEP and SCHEMA (node_label is accepted for API
    compatibility but not used to scope the query).
    """
    del node_label  # unused; kept for call-site / query-param compatibility
    al = (attributive_label or "").strip()
    if not al:
        return False
    exclude = (exclude_id or "").strip() or None
    if exclude:
        cypher = (
            "OPTIONAL MATCH (n:STEP {attributive_label: $attributive_label}) "
            "WHERE n IS NULL OR n.id <> $exclude_id "
            "OPTIONAL MATCH (m:SCHEMA {attributive_label: $attributive_label}) "
            "WHERE m IS NULL OR m.id <> $exclude_id "
            f"OPTIONAL MATCH ()-[r:{GRAPH_REL_TYPE} {{attributive_label: $attributive_label}}]-() "
            "WHERE r IS NULL OR r.id <> $exclude_id "
            "RETURN (count(n) + count(m) + count(r)) > 0 AS exists"
        )
        params: dict[str, Any] = {
            "attributive_label": al,
            "exclude_id": exclude,
        }
    else:
        cypher = (
            "OPTIONAL MATCH (n:STEP {attributive_label: $attributive_label}) "
            "OPTIONAL MATCH (m:SCHEMA {attributive_label: $attributive_label}) "
            f"OPTIONAL MATCH ()-[r:{GRAPH_REL_TYPE} {{attributive_label: $attributive_label}}]-() "
            "RETURN (count(n) + count(m) + count(r)) > 0 AS exists"
        )
        params = {"attributive_label": al}
    out = run_cypher_for_space(space_id, cypher, params)
    if not out["records"]:
        return False
    val = out["records"][0].get("exists")
    return bool(val)


def _label_property_key_for_schema(space_id: str, schema_attributive_label: str) -> str | None:
    """Property key marked is_label on the SCHEMA for INSTANCE target display."""
    al = (schema_attributive_label or "").strip()
    if not al:
        return None
    try:
        defn = fetch_schema_definition(space_id, al)
        schemata = defn.get("schemata") or []
    except ValueError:
        schemata = []
    for entry in schemata:
        if entry.get("is_label"):
            key = (entry.get("key") or "").strip()
            if key and key not in ("id", "attributive_label"):
                return _validate_property_key(key)
    return None


def _instance_label_value_from_payload(
    payload: dict[str, Any] | None, label_key: str | None
) -> str:
    if not label_key or not payload:
        return ""
    props = payload.get("properties")
    if not isinstance(props, dict):
        return ""
    val = props.get(label_key)
    if val is None:
        return ""
    return str(val).strip()


def _instance_display_label_from_properties(
    space_id: str, properties: dict[str, Any]
) -> str:
    """Human-readable INSTANCE label from the SCHEMA is_label property value."""
    schema_al = str(properties.get("attributive_label") or "").strip()
    if not schema_al:
        return ""
    label_key = _label_property_key_for_schema(space_id, schema_al)
    if not label_key:
        return ""
    val = properties.get(label_key)
    if val is not None and str(val).strip():
        return str(val).strip()
    nested = properties.get("properties")
    if isinstance(nested, dict):
        nval = nested.get(label_key)
        if nval is not None and str(nval).strip():
            return str(nval).strip()
    return ""


def _enrich_graph_nodes_display_labels(
    space_id: str, graph_nodes: dict[str, Any]
) -> None:
    for node in graph_nodes.values():
        labels = node.get("labels") or []
        if "INSTANCE" not in labels:
            continue
        props = node.get("properties") or {}
        if not isinstance(props, dict):
            continue
        display = _instance_display_label_from_properties(space_id, props)
        if display:
            node["display_label"] = display


def list_instance_targets(space_id: str, schema_attributive_label: str) -> list[dict[str, Any]]:
    """
    INSTANCE nodes for one SCHEMA type, with human-readable display_label from is_label.

    Picker values use graph id; display_label is the is_label property when set.
    """
    al = (schema_attributive_label or "").strip()
    if not al:
        return []
    label_key = _label_property_key_for_schema(space_id, al)
    if label_key:
        prop_ref = _cypher_property_ref("n", label_key)
        cypher = (
            "MATCH (n:INSTANCE {attributive_label: $attributive_label}) "
            "WHERE n.id IS NOT NULL "
            f"RETURN n.id AS id, n.attributive_label AS attributive_label, "
            f"{prop_ref} AS label_value "
            "ORDER BY toLower(coalesce(toString(label_value), n.id)), n.id"
        )
    else:
        cypher = (
            "MATCH (n:INSTANCE {attributive_label: $attributive_label}) "
            "WHERE n.id IS NOT NULL "
            "RETURN n.id AS id, n.attributive_label AS attributive_label, "
            "null AS label_value "
            "ORDER BY toLower(n.id)"
        )
    out = run_cypher_for_space(space_id, cypher, {"attributive_label": al})
    nodes: list[dict[str, Any]] = []
    for row in out.get("records") or []:
        entity_id = (row.get("id") or "").strip()
        if not entity_id:
            continue
        attributive_label = (row.get("attributive_label") or al).strip()
        label_value = row.get("label_value")
        display = (
            str(label_value).strip()
            if label_value is not None and str(label_value).strip() != ""
            else ""
        )
        if not display and label_key:
            payload = _fetch_entity_payload(space_id, entity_id, "INSTANCE")
            display = _instance_label_value_from_payload(payload, label_key)
        if not display:
            display = entity_id
        nodes.append(
            {
                "id": entity_id,
                "attributive_label": attributive_label,
                "display_label": display,
            }
        )
    return nodes


def list_graph_nodes_by_label(space_id: str, node_label: str) -> list[dict[str, Any]]:
    """Return STEP/SCHEMA/INSTANCE nodes with id/label and optional payload-backed metadata."""
    label = (node_label or "").strip()
    if label not in ("STEP", "SCHEMA", "INSTANCE"):
        return []
    cypher = (
        f"MATCH (n:{label}) "
        "WHERE n.attributive_label IS NOT NULL AND n.id IS NOT NULL "
        "RETURN n.id AS id, n.attributive_label AS attributive_label "
        "ORDER BY toLower(n.attributive_label), n.id"
    )
    out = run_cypher_for_space(space_id, cypher, {})
    nodes: list[dict[str, Any]] = []
    for row in out.get("records") or []:
        entity_id = (row.get("id") or "").strip()
        attributive_label = (row.get("attributive_label") or "").strip()
        if entity_id and attributive_label:
            node: dict[str, Any] = {"id": entity_id, "attributive_label": attributive_label}
            if label == "STEP":
                payload = _fetch_entity_payload(space_id, entity_id, "STEP") or {}
                query_id = str(payload.get("query_id") or "").strip()
                if query_id:
                    node["sequencial_properties"] = {"query_id": query_id}
                elif str(payload.get("kind") or "").strip() == "code":
                    # Code-execution STEP: the payload references the script by
                    # resource UID only; the builder fetches the code text (plus
                    # name/description/language) from the resources API on edit.
                    node["sequencial_properties"] = {
                        "step_type": "code",
                        "resource_id": str(payload.get("resource_id") or ""),
                        "response_parameters": payload.get("response_parameters") or [],
                    }
                    node["parameters"] = _fetch_entity_parameters(space_id, entity_id, "STEP")
                else:
                    headers = payload.get("headers")
                    # Custom-endpoint STEP nodes are editable in the update flow, so
                    # the full HTTP template (method/headers included) plus the input
                    # parameters are returned to pre-fill the config card.
                    node["sequencial_properties"] = {
                        "endpoint": str(payload.get("endpoint") or ""),
                        "method": str(payload.get("method") or "POST"),
                        "headers": headers if isinstance(headers, dict) else {},
                        "body": payload.get("body", {}),
                        "response_parameters": payload.get("response_parameters") or [],
                    }
                    node["parameters"] = _fetch_entity_parameters(space_id, entity_id, "STEP")
            nodes.append(node)
    return nodes


def fetch_step_wrap_entity_id(space_id: str, operation_id: str) -> str | None:
    """Return the STEP entity id that wraps a catalog operation (payload.query_id), if any."""
    op_id = (operation_id or "").strip()
    if not op_id:
        return None
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        node_label_col = spaces.entities_node_label_column(conn)
        cur = conn.execute(
            f"SELECT id FROM entities WHERE {node_label_col} = 'STEP' "
            "AND json_extract(payload, '$.query_id') = ? LIMIT 1",
            (op_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        eid = (row[0] or "").strip()
        return eid or None
    finally:
        conn.close()


def _parse_entity_payload(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8")
    text = str(raw).strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _fetch_step_entity_payloads(
    space_id: str, entity_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Batch-load JSON payloads for STEP entities (nodes and POINTS_TO rows)."""
    ids = sorted({(eid or "").strip() for eid in entity_ids if (eid or "").strip()})
    if not ids:
        return {}
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        node_label_col = spaces.entities_node_label_column(conn)
        placeholders = ",".join("?" * len(ids))
        cur = conn.execute(
            f"SELECT id, payload FROM entities "
            f"WHERE {node_label_col} = 'STEP' AND id IN ({placeholders})",
            ids,
        )
        out: dict[str, dict[str, Any]] = {}
        for row in cur.fetchall():
            eid = (row[0] or "").strip()
            if eid:
                out[eid] = _parse_entity_payload(row[1])
        return out
    finally:
        conn.close()


_CYPHER_STEP_NODE_ID_RE = re.compile(r"\(?(ID_[0-9a-f]{32}):STEP\b", re.IGNORECASE)
_SQLITE_STEP_NODE_ID_RE = re.compile(
    r"VALUES\s*\(\s*['\"]?(ID_[0-9a-f]{32})['\"]?\s*,\s*'STEP'\s*,\s*'[^']*'\s*,\s*'\{",
    re.IGNORECASE,
)


def extract_step_seed_ids(cypher: list[Any], sqlite: list[Any]) -> list[str]:
    """Entity ids for STEP nodes referenced in a query package."""
    seeds: set[str] = set()
    for stmt in cypher or []:
        text = str(stmt or "")
        for match in _CYPHER_STEP_NODE_ID_RE.finditer(text):
            seeds.add(match.group(1))
    for stmt in sqlite or []:
        text = str(stmt or "")
        for match in _SQLITE_STEP_NODE_ID_RE.finditer(text):
            seeds.add(match.group(1))
    return sorted(seeds)


def _step_flow_connected_component(
    graph: dict[str, Any], seed_ids: list[str]
) -> dict[str, Any]:
    """Keep nodes/rels in the connected STEP component that contains seed ids."""
    nodes: list[dict[str, Any]] = graph.get("nodes") or []
    relationships: list[dict[str, Any]] = graph.get("relationships") or []
    node_ids = {node["id"] for node in nodes if node.get("id")}
    seeds = [seed for seed in seed_ids if seed in node_ids]
    if not seeds:
        return {"nodes": [], "relationships": []}

    adjacency: dict[str, set[str]] = {}
    for rel in relationships:
        source = (rel.get("source") or "").strip()
        target = (rel.get("target") or "").strip()
        if not source or not target:
            continue
        adjacency.setdefault(source, set()).add(target)
        adjacency.setdefault(target, set()).add(source)

    component: set[str] = set()
    queue = list(seeds)
    while queue:
        current = queue.pop()
        if current in component:
            continue
        component.add(current)
        for neighbor in adjacency.get(current, set()):
            if neighbor not in component:
                queue.append(neighbor)

    filtered_nodes = [node for node in nodes if node.get("id") in component]
    filtered_rels = [
        rel
        for rel in relationships
        if rel.get("source") in component and rel.get("target") in component
    ]
    return {"nodes": filtered_nodes, "relationships": filtered_rels}


def _build_step_flow_graph(space_id: str) -> dict[str, Any]:
    """
    Return the STEP workflow graph for a space: nodes, POINTS_TO edges, and
    SQLite ``entities.payload`` for each entity id.
    """
    node_cypher = (
        "MATCH (n:STEP) "
        "WHERE n.id IS NOT NULL AND n.attributive_label IS NOT NULL "
        "RETURN n.id AS id, n.attributive_label AS attributive_label "
        "ORDER BY toLower(n.attributive_label), n.id"
    )
    rel_cypher = (
        "MATCH (a:STEP)-[r:POINTS_TO]->(b:STEP) "
        "WHERE r.id IS NOT NULL AND r.attributive_label IS NOT NULL "
        "AND a.id IS NOT NULL AND b.id IS NOT NULL "
        "RETURN r.id AS id, r.attributive_label AS attributive_label, "
        "a.id AS source, b.id AS target "
        "ORDER BY toLower(r.attributive_label), r.id"
    )
    node_out = run_cypher_for_space(space_id, node_cypher, {})
    rel_out = run_cypher_for_space(space_id, rel_cypher, {})

    nodes: list[dict[str, Any]] = []
    node_ids: list[str] = []
    for row in node_out.get("records") or []:
        entity_id = (row.get("id") or "").strip()
        attributive_label = (row.get("attributive_label") or "").strip()
        if not entity_id or not attributive_label:
            continue
        node_ids.append(entity_id)
        nodes.append({"id": entity_id, "attributive_label": attributive_label})

    relationships: list[dict[str, Any]] = []
    rel_ids: list[str] = []
    for row in rel_out.get("records") or []:
        entity_id = (row.get("id") or "").strip()
        attributive_label = (row.get("attributive_label") or "").strip()
        source = (row.get("source") or "").strip()
        target = (row.get("target") or "").strip()
        if not entity_id or not attributive_label or not source or not target:
            continue
        rel_ids.append(entity_id)
        relationships.append(
            {
                "id": entity_id,
                "attributive_label": attributive_label,
                "source": source,
                "target": target,
                "type": GRAPH_REL_TYPE,
            }
        )

    payloads = _fetch_step_entity_payloads(space_id, node_ids + rel_ids)
    for node in nodes:
        node["payload"] = payloads.get(node["id"], {})
    for rel in relationships:
        rel["payload"] = payloads.get(rel["id"], {})

    return {"nodes": nodes, "relationships": relationships}


def fetch_step_flow_graph(space_id: str, query_id: str | None = None) -> dict[str, Any]:
    """
    Return STEP workflow nodes/edges for a space.

    When ``query_id`` is provided, restrict to the connected component that
    contains STEP nodes referenced in that catalog query package.
    """
    graph = _build_step_flow_graph(space_id)
    qid = (query_id or "").strip()
    if not qid:
        return graph

    from . import catalog

    package = catalog.fetch_query_package(qid)
    if not package:
        return {"nodes": [], "relationships": []}

    seed_ids = extract_step_seed_ids(
        package.get("cypher") or [], package.get("sqlite") or []
    )
    if not seed_ids:
        return {"nodes": [], "relationships": []}

    return _step_flow_connected_component(graph, seed_ids)


def _list_points_to_relationships(
    space_id: str, endpoint_pattern: str, *, include_condition: bool
) -> list[dict[str, Any]]:
    """
    One representative POINTS_TO edge per attributive_label for picker lists.

    A relationship attributive_label is a reusable type — multiple edges may share it
    (each with its own id), so results are deduped by label. ``endpoint_pattern`` scopes
    the MATCH endpoints (e.g. ``(:STEP)`` / ``(:SCHEMA)`` / ``()``); ``include_condition``
    additionally returns non-empty condition / condition_type properties.
    """
    condition_return = (
        ", r.condition AS condition, r.condition_type AS condition_type"
        if include_condition
        else ""
    )
    cypher = (
        f"MATCH {endpoint_pattern}-[r:{GRAPH_REL_TYPE}]->{endpoint_pattern} "
        "WHERE r.attributive_label IS NOT NULL AND r.id IS NOT NULL "
        f"RETURN r.id AS id, r.attributive_label AS attributive_label{condition_return} "
        "ORDER BY toLower(r.attributive_label), r.id"
    )
    out = run_cypher_for_space(space_id, cypher, {})
    rels: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in out.get("records") or []:
        entity_id = (row.get("id") or "").strip()
        attributive_label = (row.get("attributive_label") or "").strip()
        if not entity_id or not attributive_label or attributive_label in seen:
            continue
        seen.add(attributive_label)
        rel: dict[str, Any] = {"id": entity_id, "attributive_label": attributive_label}
        if include_condition:
            condition = (row.get("condition") or "").strip()
            condition_type = (row.get("condition_type") or "").strip()
            if condition:
                rel["condition"] = condition
            if condition_type:
                rel["condition_type"] = condition_type
        rels.append(rel)
    return rels


def list_step_graph_relationships(space_id: str) -> list[dict[str, Any]]:
    """Return POINTS_TO relationships between STEP nodes (workflow edges only)."""
    return _list_points_to_relationships(space_id, "(:STEP)", include_condition=True)


def list_schema_graph_relationships(space_id: str) -> list[dict[str, Any]]:
    """Return SCHEMA relationship types, one representative edge per attributive_label."""
    return _list_points_to_relationships(space_id, "(:SCHEMA)", include_condition=False)


def list_step_outgoing(space_id: str, attributive_label: str) -> list[dict[str, Any]]:
    """Outgoing POINTS_TO edges from a STEP node to other STEP nodes."""
    al = (attributive_label or "").strip()
    if not al:
        raise ValueError("attributive_label is required")
    cypher = (
        "MATCH (s:STEP {attributive_label: $attributive_label})"
        f"-[r:{GRAPH_REL_TYPE}]->(t:STEP) "
        "WHERE r.attributive_label IS NOT NULL AND r.id IS NOT NULL "
        "AND t.attributive_label IS NOT NULL AND t.id IS NOT NULL "
        "RETURN r.id AS rel_id, r.attributive_label AS rel_attributive_label, "
        "t.id AS target_id, t.attributive_label AS target_attributive_label, "
        "r.condition AS condition, r.condition_type AS condition_type "
        "ORDER BY toLower(r.attributive_label), toLower(t.attributive_label)"
    )
    out = run_cypher_for_space(space_id, cypher, {"attributive_label": al})
    edges: list[dict[str, Any]] = []
    for row in out.get("records") or []:
        rel_id = (row.get("rel_id") or "").strip()
        rel_al = (row.get("rel_attributive_label") or "").strip()
        target_id = (row.get("target_id") or "").strip()
        target_al = (row.get("target_attributive_label") or "").strip()
        if not rel_id or not rel_al or not target_id or not target_al:
            continue
        # Guard conditions now live in the relationship's entities payload (SQLite);
        # fall back to the Neo4j-stored value for edges created before the migration.
        rel_payload = _fetch_entity_payload(space_id, rel_id, "STEP") or {}
        condition = str(rel_payload.get("condition") or row.get("condition") or "").strip()
        condition_type = str(
            rel_payload.get("condition_type") or row.get("condition_type") or ""
        ).strip()
        edge: dict[str, Any] = {
            "rel_id": rel_id,
            "rel_attributive_label": rel_al,
            "target_id": target_id,
            "target_attributive_label": target_al,
            "condition": condition,
            "condition_type": condition_type,
        }
        # The expected-result branch flag only applies to parameter conditions and
        # only lives in the SQLite payload (never mirrored to Neo4j).
        if isinstance(rel_payload.get("condition_expected"), bool):
            edge["condition_expected"] = rel_payload["condition_expected"]
        edges.append(edge)
    return edges


def list_graph_relationships_by_label(space_id: str) -> list[dict[str, Any]]:
    """Return POINTS_TO relationships with id/attributive_label and optional condition."""
    return _list_points_to_relationships(space_id, "()", include_condition=True)


# Match QUERY form property keys: letters, numbers, spaces, underscores.
_ALPHANUM_SPACE_KEY_RE = re.compile(r"^[A-Za-z0-9_ ]+$")
_SIMPLE_CYPHER_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_property_key(property_key: str) -> str:
    key = (property_key or "").strip()
    if not key or not _ALPHANUM_SPACE_KEY_RE.match(key):
        raise ValueError(f"Invalid property_key: {property_key!r}")
    return key


def _cypher_property_ref(variable: str, property_key: str) -> str:
    """Return ``n.key`` or ``n.`key with spaces` `` for safe Cypher interpolation."""
    key = _validate_property_key(property_key)
    if _SIMPLE_CYPHER_KEY_RE.match(key):
        return f"{variable}.{key}"
    return f"{variable}.`{cypher_utils.escape_identifier(key)}`"


def _fetch_entity_payload(space_id: str, entity_id: str, label: str) -> dict[str, Any] | None:
    """Load JSON payload from per-space SQLite ``entities`` for one id and node_label."""
    eid = (entity_id or "").strip()
    if not eid:
        return None
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        node_label_col = spaces.entities_node_label_column(conn)
        cur = conn.execute(
            f"SELECT payload FROM entities WHERE id = ? AND {node_label_col} = ?",
            (eid, label),
        )
        row = cur.fetchone()
        if row is None or row[0] is None:
            return None
        return _parse_entity_payload(row[0])
    except json.JSONDecodeError:
        return {}
    finally:
        conn.close()


def _fetch_entity_parameters(space_id: str, entity_id: str, label: str) -> list[Any]:
    """Load the JSON ``parameters`` array from per-space SQLite ``entities`` for one id."""
    eid = (entity_id or "").strip()
    if not eid:
        return []
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        node_label_col = spaces.entities_node_label_column(conn)
        cur = conn.execute(
            f"SELECT parameters FROM entities WHERE id = ? AND {node_label_col} = ?",
            (eid, label),
        )
        row = cur.fetchone()
        if row is None or row[0] is None:
            return []
        try:
            data = json.loads(row[0])
        except (ValueError, TypeError):
            return []
        return data if isinstance(data, list) else []
    finally:
        conn.close()


def _normalize_choice_options(raw: Any) -> list[str]:
    """Trim/dedupe configured radio/checkbox options, dropping empties."""
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for opt in raw:
        text = str(opt or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _normalize_choice_count(raw: Any) -> int | None:
    """Coerce a checkbox min/max choice count to a non-negative int, else None."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw >= 0 else None
    if isinstance(raw, float) and raw.is_integer() and raw >= 0:
        return int(raw)
    if isinstance(raw, str) and raw.strip().isdigit():
        return int(raw.strip())
    return None


def _normalize_property_schema(entry: dict[str, Any]) -> dict[str, Any] | None:
    ps = entry.get("property_schema") if isinstance(entry, dict) else None
    if not isinstance(ps, dict):
        return None
    name = (ps.get("name") or "").strip()
    if not name:
        return None
    value_type = (ps.get("value_type") or "string").strip()
    if value_type not in (
        "string",
        "number",
        "integer",
        "boolean",
        "array",
        "UID",
        "radio",
        "checkbox",
    ):
        value_type = "string"
    out: dict[str, Any] = {
        "key": name,
        "value_type": value_type,
        "is_required": bool(ps.get("is_required")),
        "is_key": bool(ps.get("is_key")),
        "is_label": bool(ps.get("is_label")),
        "is_indexed": bool(ps.get("is_indexed")),
    }
    if value_type == "string" and ps.get("format"):
        out["format"] = str(ps.get("format"))
    if value_type in ("radio", "checkbox"):
        out["options"] = _normalize_choice_options(ps.get("options"))
        if value_type == "checkbox":
            min_choices = _normalize_choice_count(ps.get("min_choices"))
            if min_choices is not None:
                out["min_choices"] = min_choices
            max_choices = _normalize_choice_count(ps.get("max_choices"))
            if max_choices is not None:
                out["max_choices"] = max_choices
    default_value = ps.get("default_value")
    if default_value is not None and str(default_value).strip() != "":
        out["default_value"] = str(default_value)
    return out


DEFAULT_SCHEMA_KEY_PROPERTY_NAME = "id"


def _apply_schema_schemata_defaults(schemata: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ensure a UID is_key property exists when the SCHEMA author omitted is_key."""
    out = list(schemata)
    if not any(s.get("is_key") for s in out):
        out.insert(
            0,
            {
                "key": DEFAULT_SCHEMA_KEY_PROPERTY_NAME,
                "value_type": "UID",
                "is_required": True,
                "is_key": True,
                "is_label": False,
                "is_indexed": False,
            },
        )
    return out


def _schemata_from_payload(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not payload:
        return _apply_schema_schemata_defaults([])
    schemata_raw = payload.get("schemata")
    if not isinstance(schemata_raw, list):
        return _apply_schema_schemata_defaults([])
    out: list[dict[str, Any]] = []
    for entry in schemata_raw:
        if not isinstance(entry, dict):
            continue
        norm = _normalize_property_schema(entry)
        if norm:
            out.append(norm)
    return _apply_schema_schemata_defaults(out)


def _resolve_schema_relationship_id(space_id: str, attributive_label: str) -> str | None:
    """Resolve a relationship-SCHEMA pattern id (POINTS_TO edge) by its attributive_label.

    Relationship schemas are POINTS_TO edges between SCHEMA nodes, not SCHEMA nodes themselves;
    their config payload lives in the SQLite ``entities`` row keyed by the rel id. A relationship
    attributive_label is a reusable type: multiple edges may share it, but each carries an
    identical payload copy, so resolving to any one edge id (lowest, for determinism) is
    equivalent. Returns None when no relationship pattern carries this label.
    """
    al = (attributive_label or "").strip()
    if not al:
        return None
    out = run_cypher_for_space(
        space_id,
        f"MATCH ()-[r:{GRAPH_REL_TYPE} {{attributive_label: $attributive_label}}]->() "
        "RETURN DISTINCT r.id AS id ORDER BY r.id",
        {"attributive_label": al},
    )
    records = out.get("records") or []
    if not records:
        return None
    rel_id = (records[0].get("id") or "").strip()
    return rel_id or None


def fetch_schema_definition(space_id: str, attributive_label: str) -> dict[str, Any]:
    """
    Resolve one SCHEMA pattern by attributive_label and return its property schemata.

    Resolves a SCHEMA *node* first; if none matches, falls back to a relationship-SCHEMA
    pattern (a POINTS_TO edge carrying that label) so node- and relationship-schemas behave
    identically. Node/STEP attributive_labels are globally unique; relationship
    attributive_labels are reusable types whose edges all carry identical payload copies,
    so any matching edge resolves to the same definition. Raises ValueError if nothing
    matches or if multiple SCHEMA nodes share the label.
    """
    al = (attributive_label or "").strip()
    if not al:
        raise ValueError("attributive_label is required")
    cypher = (
        "MATCH (s:SCHEMA {attributive_label: $attributive_label}) "
        "RETURN s.id AS id "
        "ORDER BY s.id"
    )
    out = run_cypher_for_space(space_id, cypher, {"attributive_label": al})
    records = out.get("records") or []
    if not records:
        rel_id = _resolve_schema_relationship_id(space_id, al)
        if rel_id:
            payload = _fetch_entity_payload(space_id, rel_id, "SCHEMA")
            return {
                "schema_id": rel_id,
                "attributive_label": al,
                "schemata": _schemata_from_payload(payload),
            }
        raise ValueError(f"No SCHEMA node with attributive_label {al!r}")
    if len(records) > 1:
        raise ValueError(
            f"Multiple SCHEMA nodes with attributive_label {al!r} "
            f"({len(records)} found)"
        )
    schema_id = (records[0].get("id") or "").strip()
    if not schema_id:
        raise ValueError(f"SCHEMA node missing id for attributive_label {al!r}")
    payload = _fetch_entity_payload(space_id, schema_id, "SCHEMA")
    return {
        "schema_id": schema_id,
        "attributive_label": al,
        "schemata": _schemata_from_payload(payload),
    }


def list_schema_outgoing(
    space_id: str, attributive_label: str, include_incoming: bool = False
) -> list[dict[str, Any]]:
    """POINTS_TO edges connected to a SCHEMA node, with rel/target schemata from SQLite.

    Outgoing edges always; incoming edges (where the node is the edge's target) when
    ``include_incoming`` is set. Edges are normalized from the node's perspective —
    ``target_*`` always names the node on the *other end* — and each edge carries a
    ``direction`` tag so match builders can compose reverse-direction hops.
    """
    al = (attributive_label or "").strip()
    if not al:
        raise ValueError("attributive_label is required")
    patterns = [("outgoing", f"-[r:{GRAPH_REL_TYPE}]->")]
    if include_incoming:
        patterns.append(("incoming", f"<-[r:{GRAPH_REL_TYPE}]-"))
    edges: list[dict[str, Any]] = []
    for direction, hop in patterns:
        cypher = (
            "MATCH (s:SCHEMA {attributive_label: $attributive_label})"
            f"{hop}(t:SCHEMA) "
            "RETURN r.id AS rel_id, r.attributive_label AS rel_attributive_label, "
            "t.id AS target_id, t.attributive_label AS target_attributive_label "
            "ORDER BY toLower(r.attributive_label), toLower(t.attributive_label)"
        )
        out = run_cypher_for_space(space_id, cypher, {"attributive_label": al})
        for row in out.get("records") or []:
            rel_id = (row.get("rel_id") or "").strip()
            rel_al = (row.get("rel_attributive_label") or "").strip()
            target_id = (row.get("target_id") or "").strip()
            target_al = (row.get("target_attributive_label") or "").strip()
            if not rel_id or not rel_al or not target_id or not target_al:
                continue
            rel_payload = _fetch_entity_payload(space_id, rel_id, "SCHEMA")
            target_payload = _fetch_entity_payload(space_id, target_id, "SCHEMA")
            edges.append(
                {
                    "rel_id": rel_id,
                    "rel_attributive_label": rel_al,
                    "target_id": target_id,
                    "target_attributive_label": target_al,
                    "rel_schemata": _schemata_from_payload(rel_payload),
                    "target_schemata": _schemata_from_payload(target_payload),
                    "direction": direction,
                }
            )
    return edges


def instance_property_exists(
    space_id: str,
    attributive_label: str,
    property_key: str,
    value: Any,
    exclude_id: str | None = None,
) -> bool:
    """Return True if another INSTANCE with the same attributive_label has property_key = value."""
    al = (attributive_label or "").strip()
    key = _validate_property_key(property_key)
    if not al:
        return False
    # Avoid noisy Neo4j warnings (`label does not exist`) when INSTANCE has not
    # been created yet in this space.
    label_probe = run_cypher_for_space(
        space_id,
        "CALL db.labels() YIELD label RETURN count(CASE WHEN label = 'INSTANCE' THEN 1 END) > 0 AS exists",
        {},
    )
    if not label_probe.get("records") or not bool(label_probe["records"][0].get("exists")):
        return False
    exclude = (exclude_id or "").strip() or None
    prop_ref = _cypher_property_ref("n", key)
    if exclude:
        cypher = (
            "MATCH (n:INSTANCE {attributive_label: $attributive_label}) "
            f"WHERE {prop_ref} = $value AND n.id <> $exclude_id "
            "RETURN count(n) > 0 AS exists"
        )
        params: dict[str, Any] = {
            "attributive_label": al,
            "value": value,
            "exclude_id": exclude,
        }
    else:
        cypher = (
            "MATCH (n:INSTANCE {attributive_label: $attributive_label}) "
            f"WHERE {prop_ref} = $value "
            "RETURN count(n) > 0 AS exists"
        )
        params = {"attributive_label": al, "value": value}
    out = run_cypher_for_space(space_id, cypher, params)
    if not out["records"]:
        return False
    return bool(out["records"][0].get("exists"))


# Internal graph keys hidden from the STEP/SCHEMA/relationship key listing. INSTANCE
# keys come from the SCHEMA schemata instead (see list_schema_property_keys_from_entities),
# where the engine-minted ``id`` IS surfaced so RUD WHERE filters can target it.
_RESERVED_WHERE_PROPERTY_KEYS = frozenset({"id"})


def _entity_cypher_label(entity_label: str, entity_role: str) -> str:
    role = (entity_role or "node").strip().lower()
    if role == "relationship":
        return GRAPH_REL_TYPE
    label = (entity_label or "").strip()
    if label in ("STEP", "SCHEMA", "INSTANCE"):
        return label
    raise ValueError(f"Invalid entity_label: {entity_label!r}")


def list_schema_property_keys_from_entities(
    space_id: str, attributive_label: str
) -> list[str]:
    """
    Property keys declared on a SCHEMA entity from the per-space ``entities`` payload.

    Used for read INSTANCE WHERE filters: the path ``attributive_label`` is the
    associated SCHEMA label (``common_label`` on the SCHEMA row).

    Includes the implicit engine-minted ``id`` key (injected into the schemata when the
    author defined no ``is_key``), so RUD operations can filter instances by their
    automatic ID alongside the user-defined properties.
    """
    al = (attributive_label or "").strip()
    if not al:
        return []
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        node_label_col = spaces.entities_node_label_column(conn)
        cur = conn.execute(
            f"SELECT payload FROM entities WHERE {node_label_col} = 'SCHEMA' AND common_label = ? "
            "ORDER BY id",
            (al,),
        )
        rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        try:
            defn = fetch_schema_definition(space_id, al)
            schemata = defn.get("schemata") or []
        except ValueError:
            return []
    else:
        raw = rows[0][0]
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8")
        text = str(raw or "").strip()
        if not text:
            return []
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return []
        if not isinstance(payload, dict):
            return []
        schemata = _schemata_from_payload(payload)
    keys: list[str] = []
    for entry in schemata:
        key = (entry.get("key") or "").strip()
        if key:
            keys.append(key)
    return sorted(keys, key=lambda k: k.lower())


def list_entity_property_keys(
    space_id: str,
    entity_label: str,
    attributive_label: str,
    entity_role: str = "node",
) -> list[str]:
    """Distinct property keys on graph entities with the given attributive_label."""
    al = (attributive_label or "").strip()
    if not al:
        return []
    label = (entity_label or "").strip()
    if label == "INSTANCE":
        return list_schema_property_keys_from_entities(space_id, al)
    label = _entity_cypher_label(entity_label, entity_role)
    role = (entity_role or "node").strip().lower()
    if role == "relationship":
        cypher = (
            f"MATCH ()-[r:{label} {{attributive_label: $attributive_label}}]->() "
            "UNWIND keys(r) AS k "
            "RETURN DISTINCT k AS key ORDER BY toLower(k)"
        )
    else:
        cypher = (
            f"MATCH (n:{label} {{attributive_label: $attributive_label}}) "
            "UNWIND keys(n) AS k "
            "RETURN DISTINCT k AS key ORDER BY toLower(k)"
        )
    out = run_cypher_for_space(space_id, cypher, {"attributive_label": al})
    keys: list[str] = []
    for row in out.get("records") or []:
        key = (row.get("key") or "").strip()
        if key and key not in _RESERVED_WHERE_PROPERTY_KEYS:
            keys.append(key)
    return keys


def _value_to_where_option(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"))
    return str(value)


def list_entity_property_values(
    space_id: str,
    entity_label: str,
    attributive_label: str,
    property_key: str,
    entity_role: str = "node",
    limit: int = 500,
) -> list[str]:
    """Distinct stored values for one property on entities with the given attributive_label."""
    al = (attributive_label or "").strip()
    key = _validate_property_key(property_key)
    if not al or not key:
        return []
    label = _entity_cypher_label(entity_label, entity_role)
    role = (entity_role or "node").strip().lower()
    var = "r" if role == "relationship" else "n"
    prop_ref = _cypher_property_ref(var, key)
    lim = max(1, min(int(limit or 500), 2000))
    if role == "relationship":
        match = f"MATCH ()-[{var}:{label} {{attributive_label: $attributive_label}}]->()"
    else:
        match = f"MATCH ({var}:{label} {{attributive_label: $attributive_label}})"
    cypher = (
        f"{match} "
        f"WHERE {prop_ref} IS NOT NULL "
        f"RETURN DISTINCT {prop_ref} AS value ORDER BY toLower(toString(value)) "
        f"LIMIT {lim}"
    )
    out = run_cypher_for_space(space_id, cypher, {"attributive_label": al})
    values: list[str] = []
    seen: set[str] = set()
    for row in out.get("records") or []:
        text = _value_to_where_option(row.get("value"))
        if text in seen:
            continue
        seen.add(text)
        values.append(text)
    return values


def graph_id_exists(space_id: str, entity_id: str) -> bool:
    """Return True if any STEP/SCHEMA node or POINTS_TO rel already uses this id."""
    eid = (entity_id or "").strip()
    if not eid:
        return False
    cypher = (
        "OPTIONAL MATCH (n:STEP {id: $entity_id}) "
        "OPTIONAL MATCH (m:SCHEMA {id: $entity_id}) "
        f"OPTIONAL MATCH ()-[r:{GRAPH_REL_TYPE} {{id: $entity_id}}]-() "
        "RETURN (count(n) + count(m) + count(r)) > 0 AS exists"
    )
    params = {"entity_id": eid}
    out = run_cypher_for_space(space_id, cypher, params)
    if not out["records"]:
        return False
    val = out["records"][0].get("exists")
    return bool(val)
