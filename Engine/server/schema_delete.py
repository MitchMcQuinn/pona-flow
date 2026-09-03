"""
SCHEMA pattern delete cascade — resolution, preview, and execution.

Deleting a SCHEMA must avoid leaving the three pattern stores out of sync:

- Neo4j (the space's resolved store): STEP/SCHEMA/INSTANCE nodes + POINTS_TO.
- ``entities`` (per-space SQLite mirror): one row per node/relationship.
- ``queries`` (catalog ``data.db``): composed Cypher/SQLite/parameter arrays.

A delete always **purges** — physically removing the schema, its instances, its
relationship patterns, and every query/sequence/STEP/state package that references
them — then strips the affected labels from every space's nav index.

The flow is split into a read-only :func:`preview_schema_deletion` (dry run) and
:func:`execute_schema_deletion` which only mutates when ``confirm=True``.
"""

from __future__ import annotations

from typing import Any

from . import catalog, cypher_utils, graph, spaces

# Shared with schema_update / spaces / step_delete; kept as module aliases for
# existing call sites and tests.
_ATTR_LABEL_RE = cypher_utils.ATTR_LABEL_RE
_labels_in_cypher_array = cypher_utils.labels_in_cypher_array


def _graph_single_column(space_id: str, cypher: str, params: dict[str, Any], key: str) -> list[str]:
    out = graph.run_cypher_for_space(space_id, cypher, params)
    values: list[str] = []
    for row in out.get("records") or []:
        val = (row.get(key) or "").strip()
        if val:
            values.append(val)
    return values


def _resolve_graph_targets(space_id: str, attributive_label: str) -> dict[str, Any]:
    """
    Collect graph-side ids/labels for a SCHEMA delete from the space's Neo4j store.

    Returns schema node ids, the SCHEMA relationship patterns touching it (id + label),
    instance node ids, instance relationship ids, and the labels of schemas that depend on
    it (incoming POINTS_TO).
    """
    al = attributive_label

    schema_node_ids = _graph_single_column(
        space_id,
        "MATCH (s:SCHEMA {attributive_label: $al}) RETURN s.id AS id",
        {"al": al},
        "id",
    )

    rel_rows = graph.run_cypher_for_space(
        space_id,
        "MATCH (s:SCHEMA {attributive_label: $al})-[r:POINTS_TO]-(:SCHEMA) "
        "RETURN DISTINCT r.id AS id, r.attributive_label AS label",
        {"al": al},
    )
    rel_ids: list[str] = []
    rel_labels: set[str] = set()
    for row in rel_rows.get("records") or []:
        rid = (row.get("id") or "").strip()
        rlabel = (row.get("label") or "").strip()
        if rid:
            rel_ids.append(rid)
        if rlabel:
            rel_labels.add(rlabel)

    instance_ids = _graph_single_column(
        space_id,
        "MATCH (n:INSTANCE {attributive_label: $al}) RETURN n.id AS id",
        {"al": al},
        "id",
    )

    instance_rel_ids = _graph_single_column(
        space_id,
        "MATCH (n:INSTANCE {attributive_label: $al})-[r:POINTS_TO]-() "
        "RETURN DISTINCT r.id AS id",
        {"al": al},
        "id",
    )

    dependent_schemas = sorted(
        {
            label
            for label in _graph_single_column(
                space_id,
                "MATCH (o:SCHEMA)-[:POINTS_TO]->(s:SCHEMA {attributive_label: $al}) "
                "WHERE o.attributive_label <> $al "
                "RETURN DISTINCT o.attributive_label AS label",
                {"al": al},
                "label",
            )
        },
        key=str.casefold,
    )

    return {
        "schema_node_ids": schema_node_ids,
        "schema_rel_ids": rel_ids,
        "relationship_labels": sorted(rel_labels, key=str.casefold),
        "instance_ids": instance_ids,
        "instance_rel_ids": instance_rel_ids,
        "dependent_schemas": dependent_schemas,
    }


def _step_entities(space_id: str) -> list[dict[str, Any]]:
    """All STEP rows (nodes + relationships) from the per-space ``entities`` mirror."""
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        node_label_col = spaces.entities_node_label_column(conn)
        cur = conn.execute(
            f"SELECT id, common_label, payload FROM entities WHERE {node_label_col} = 'STEP'"
        )
        rows: list[dict[str, Any]] = []
        for row in cur.fetchall():
            payload = graph._parse_entity_payload(row[2])
            rows.append(
                {
                    "id": (row[0] or "").strip(),
                    "attributive_label": (row[1] or "").strip(),
                    "payload": payload,
                }
            )
        return rows
    finally:
        conn.close()


def _catalog_queries() -> list[dict[str, Any]]:
    conn = catalog.catalog_conn()
    try:
        cur = conn.execute(
            "SELECT id, name, kind, operation, cypher FROM queries"
        )
        return [
            {
                "id": (row[0] or "").strip(),
                "name": str(row[1] or ""),
                "kind": (row[2] or "").strip(),
                "operation": (row[3] or "").strip(),
                "cypher": row[4],
            }
            for row in cur.fetchall()
        ]
    finally:
        conn.close()


def _state_rows() -> list[dict[str, Any]]:
    conn = catalog.catalog_conn()
    try:
        cur = conn.execute("SELECT id, status, package FROM state")
        return [
            {
                "id": (row[0] or "").strip(),
                "status": (row[1] or "").strip(),
                "package": str(row[2] or ""),
            }
            for row in cur.fetchall()
        ]
    finally:
        conn.close()


def resolve_schema_deletion(space_id: str, attributive_label: str) -> dict[str, Any]:
    """
    Compute the full set of artifacts affected by deleting SCHEMA *attributive_label*.

    This is a pure read; it never mutates. The returned dict drives both the preview and
    the execution (which re-resolves to avoid acting on stale data).
    """
    sid = (space_id or "").strip()
    al = (attributive_label or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    if not al:
        raise ValueError("attributive_label is required")

    targets = _resolve_graph_targets(sid, al)
    if not targets["schema_node_ids"]:
        raise ValueError(
            f"No SCHEMA node with attributive_label {al!r} in space {sid!r}"
        )

    # Instances reuse the schema's attributive_label, so {al} already covers instance
    # references; relationship patterns add their own labels.
    affected_labels = {al} | set(targets["relationship_labels"])

    queries = _catalog_queries()
    affected_queries: list[dict[str, str]] = []
    affected_query_ids: set[str] = set()
    for q in queries:
        if q["kind"] == "sequence":
            continue
        if _labels_in_cypher_array(q["cypher"]) & affected_labels:
            affected_queries.append(
                {"id": q["id"], "name": q["name"], "operation": q["operation"]}
            )
            affected_query_ids.add(q["id"])

    # STEPs reference a pattern only through the query their payload.query_id points at.
    # A STEP relationship may also embed an affected instance label in its cypher condition.
    affected_step_labels: set[str] = set()
    affected_step_ids: set[str] = set()
    for step in _step_entities(sid):
        payload = step["payload"] or {}
        query_id = str(payload.get("query_id") or "").strip()
        condition = str(payload.get("condition") or "")
        references = bool(query_id and query_id in affected_query_ids)
        if not references and condition:
            for match in _ATTR_LABEL_RE.finditer(condition):
                if match.group(1).strip() in affected_labels:
                    references = True
                    break
        if references:
            if step["id"]:
                affected_step_ids.add(step["id"])
            if step["attributive_label"]:
                affected_step_labels.add(step["attributive_label"])

    affected_sequences: list[dict[str, str]] = []
    affected_sequence_ids: set[str] = set()
    for q in queries:
        if q["kind"] != "sequence":
            continue
        seq_step_labels = set(spaces._parse_sequence_cypher_labels(q["cypher"]))
        seq_labels = _labels_in_cypher_array(q["cypher"])
        if (seq_step_labels & affected_step_labels) or (seq_labels & affected_labels):
            affected_sequences.append({"id": q["id"], "name": q["name"]})
            affected_sequence_ids.add(q["id"])

    all_affected_labels = affected_labels | affected_step_labels

    # State packages that reference an affected query/sequence id or step label.
    ref_tokens = affected_query_ids | affected_sequence_ids | affected_step_labels
    affected_state: list[dict[str, str]] = []
    if ref_tokens:
        for state in _state_rows():
            package = state["package"]
            if any(token and token in package for token in ref_tokens):
                affected_state.append({"id": state["id"], "status": state["status"]})

    return {
        "space_id": sid,
        "attributive_label": al,
        "affected_labels": sorted(affected_labels, key=str.casefold),
        "relationship_labels": targets["relationship_labels"],
        "schema_node_ids": targets["schema_node_ids"],
        "schema_rel_ids": targets["schema_rel_ids"],
        "instance_ids": targets["instance_ids"],
        "instance_rel_ids": targets["instance_rel_ids"],
        "dependent_schemas": targets["dependent_schemas"],
        "affected_queries": affected_queries,
        "affected_query_ids": sorted(affected_query_ids),
        "affected_step_ids": sorted(affected_step_ids),
        "affected_step_labels": sorted(affected_step_labels, key=str.casefold),
        "affected_sequences": affected_sequences,
        "affected_sequence_ids": sorted(affected_sequence_ids),
        "affected_state": affected_state,
        "strip_labels": sorted(all_affected_labels, key=str.casefold),
    }


def _build_warnings(resolution: dict[str, Any]) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    dependents = resolution["dependent_schemas"]
    if dependents:
        joined = ", ".join(dependents)
        warnings.append(
            {
                "type": "dependent_schemas",
                "blocking": False,
                "requires_confirmation": True,
                "message": (
                    f"These schemas have a relationship to {resolution['attributive_label']!r} "
                    f"and may break: {joined}"
                ),
                "schemas": dependents,
            }
        )
    return warnings


def preview_schema_deletion(space_id: str, attributive_label: str) -> dict[str, Any]:
    """Read-only dry run: what a delete *would* do, plus warnings. Mutates nothing."""
    resolution = resolve_schema_deletion(space_id, attributive_label)
    warnings = _build_warnings(resolution)
    return {
        "space_id": resolution["space_id"],
        "attributive_label": resolution["attributive_label"],
        "requires_confirmation": True,
        "summary": {
            "instances": len(resolution["instance_ids"]),
            "relationship_patterns": len(resolution["relationship_labels"]),
            "queries": len(resolution["affected_queries"]),
            "sequences": len(resolution["affected_sequences"]),
            "steps": len(resolution["affected_step_ids"]),
            "execution_packages": len(resolution["affected_state"]),
            "dependent_schemas": len(resolution["dependent_schemas"]),
        },
        "affected": {
            "labels": resolution["affected_labels"],
            "relationship_labels": resolution["relationship_labels"],
            "queries": resolution["affected_queries"],
            "sequences": resolution["affected_sequences"],
            "step_labels": resolution["affected_step_labels"],
            "execution_packages": resolution["affected_state"],
            "dependent_schemas": resolution["dependent_schemas"],
        },
        "warnings": warnings,
    }


def _delete_graph_nodes(space_id: str, attributive_label: str) -> dict[str, int]:
    """DETACH DELETE the schema and its instances from the space's graph (idempotent)."""
    al = attributive_label
    deleted = 0
    for cypher in (
        "MATCH (n:INSTANCE {attributive_label: $al}) DETACH DELETE n",
        "MATCH (s:SCHEMA {attributive_label: $al}) DETACH DELETE s",
    ):
        out = graph.run_cypher_for_space(space_id, cypher, {"al": al})
        deleted += int(out.get("summary", {}).get("counters", {}).get("nodes_deleted", 0))
    return {"nodes_deleted": deleted}


def delete_entities_rows(space_id: str, entity_ids: list[str]) -> int:
    """Delete rows from the per-space ``entities`` mirror by id (idempotent).

    Shared by the SCHEMA and STEP delete cascades.
    """
    ids = sorted({(eid or "").strip() for eid in entity_ids if (eid or "").strip()})
    if not ids:
        return 0
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        placeholders = ",".join("?" * len(ids))
        cur = conn.execute(f"DELETE FROM entities WHERE id IN ({placeholders})", ids)
        conn.commit()
        return cur.rowcount
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def delete_catalog_rows(query_ids: list[str], state_ids: list[str]) -> dict[str, int]:
    """Delete catalog ``queries`` and ``state`` rows by id (idempotent).

    Shared by the SCHEMA and STEP delete cascades.
    """
    conn = catalog.catalog_conn()
    try:
        deleted_queries = 0
        deleted_state = 0
        q_ids = sorted({(q or "").strip() for q in query_ids if (q or "").strip()})
        if q_ids:
            placeholders = ",".join("?" * len(q_ids))
            cur = conn.execute(
                f"DELETE FROM queries WHERE id IN ({placeholders})", q_ids
            )
            deleted_queries = cur.rowcount
        s_ids = sorted({(s or "").strip() for s in state_ids if (s or "").strip()})
        if s_ids:
            placeholders = ",".join("?" * len(s_ids))
            cur = conn.execute(f"DELETE FROM state WHERE id IN ({placeholders})", s_ids)
            deleted_state = cur.rowcount
        conn.commit()
        return {"queries_deleted": deleted_queries, "state_deleted": deleted_state}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def execute_schema_deletion(
    space_id: str, attributive_label: str, confirm: bool = False
) -> dict[str, Any]:
    """
    Apply the SCHEMA delete cascade. Requires ``confirm=True`` (callers should show the
    preview first).

    Always purges: removes the schema, instances, relationship patterns, referencing
    queries/sequences, and orphaned state packages from Neo4j, ``entities``, and the
    catalog, then strips the affected labels from every space's nav index. Steps are
    ordered graph → entities → catalog → labels; every step is idempotent so a partial
    failure can be retried by re-running.
    """
    if not confirm:
        raise ValueError("confirm must be true to execute a schema deletion")

    resolution = resolve_schema_deletion(space_id, attributive_label)
    sid = resolution["space_id"]
    al = resolution["attributive_label"]

    result: dict[str, Any] = {
        "space_id": sid,
        "attributive_label": al,
        "warnings": _build_warnings(resolution),
    }

    result["graph"] = _delete_graph_nodes(sid, al)
    result["entities_deleted"] = delete_entities_rows(
        sid,
        resolution["schema_node_ids"]
        + resolution["schema_rel_ids"]
        + resolution["instance_ids"]
        + resolution["instance_rel_ids"],
    )
    result["catalog"] = delete_catalog_rows(
        resolution["affected_query_ids"] + resolution["affected_sequence_ids"],
        [s["id"] for s in resolution["affected_state"]],
    )
    stripped = spaces.remove_attributive_labels_from_all_spaces(resolution["strip_labels"])
    result["unlinked_labels"] = stripped.get(sid, [])
    result["purged"] = True
    return result
