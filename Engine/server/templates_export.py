"""
Space template export — selection resolution and template assembly.

The Templates tab in space settings lets an operator snapshot a space to a portable
JSON file. Export is *selection-driven*: the operator picks sequences, operations,
schemas (with a per-schema instance toggle), and events, and :func:`resolve_selection`
walks the full transitive dependency closure (nested sequences/operations, STEP hops,
the connected SCHEMA network, referenced regex formats, and credential
name slots) before :func:`build_export` assembles the template (graph patterns + SQLite
``entities``/``queries``/``regex``/``events`` + credential ``slots``).
Credential values and event signing secrets are never exported.

The import half lives in ``templates_import``; ``templates`` re-exports both.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from . import catalog, config, credentials, cypher_utils, graph, spaces

SCHEMA_VERSION = 2

# Shared statement-scanning regexes (see cypher_utils), aliased for local call sites.
_SECRET_REF_RE = cypher_utils.SECRET_REF_RE
_ATTR_LABEL_RE = cypher_utils.ATTR_LABEL_RE

_cypher_traverses_downstream = cypher_utils.cypher_traverses_downstream


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalize_selection(selection: dict[str, Any] | None) -> dict[str, list[str]]:
    """Coerce the user's selection payload into clean id/label lists."""
    sel = selection or {}

    def ids(key: str) -> list[str]:
        raw = sel.get(key)
        if not isinstance(raw, list):
            return []
        out: list[str] = []
        seen: set[str] = set()
        for item in raw:
            text = str(item or "").strip()
            if text and text not in seen:
                seen.add(text)
                out.append(text)
        return out

    return {
        "sequences": ids("sequences"),
        "operations": ids("operations"),
        "schemas": ids("schemas"),
        "instances": ids("instances"),
        "events": ids("events"),
    }


def _labels_in_builder_config(config_obj: Any) -> set[str]:
    """attributive_labels referenced anywhere inside a (parsed) builder_config object.

    The visual builder stores labels under assorted keys (``attributive_label``,
    ``label``, ``node_label``, ``target_label`` ...); rather than enumerate them we walk
    the structure and treat any string value of an ``*label`` key as a referenced label.
    """
    labels: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                lk = str(key).lower()
                if isinstance(value, str) and (lk.endswith("label") or lk == "attributive_label"):
                    text = value.strip()
                    if text:
                        labels.add(text)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(config_obj)
    return labels


def _formats_in_parameters(parameters: Any) -> set[str]:
    """regex format names referenced by a parameter list's ``format`` fields."""
    out: set[str] = set()
    if not isinstance(parameters, list):
        return out
    for param in parameters:
        if not isinstance(param, dict):
            continue
        fmt = str(param.get("format") or "").strip()
        if fmt and fmt.lower() != "any":
            out.add(fmt)
    return out


def resolve_selection(space_id: str, selection: dict[str, Any] | None) -> dict[str, Any]:
    """Resolve the transitive dependency closure of a user's export selection.

    Starting from selected sequences (plus sequences referenced by selected events),
    standalone operations, schemas, and events, this walks:

    - sequence STEP graphs (directed ``POINTS_TO`` BFS, traversal-aware) collecting STEP
      nodes/edges and the queries their payloads wrap (recursing into nested sequences);
    - SCHEMA/INSTANCE/relationship labels referenced by every collected operation
      (cypher + builder_config);
    - the connected SCHEMA network (relationship patterns pull in both endpoint schemas);
    - regex format names from included schemas and query/step parameters;
    - INSTANCE nodes/edges for schemas the user opted into; and
    - credential name slots (``$secret.NAME``) referenced by steps.

    Returns the collected id/label sets used by :func:`build_export`.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    sel = _normalize_selection(selection)

    flow = graph._build_step_flow_graph(sid)
    nodes_by_id: dict[str, dict[str, Any]] = {n["id"]: n for n in flow.get("nodes") or []}
    label_to_node_ids: dict[str, list[str]] = {}
    for node in flow.get("nodes") or []:
        label_to_node_ids.setdefault(node.get("attributive_label") or "", []).append(node["id"])
    adjacency: dict[str, list[dict[str, Any]]] = {}
    for rel in flow.get("relationships") or []:
        adjacency.setdefault(rel["source"], []).append(rel)

    step_node_ids: set[str] = set()
    step_rel_ids: set[str] = set()
    query_ids: set[str] = set()
    credential_names: set[str] = set()
    visited_sequences: set[str] = set()

    def scan_secrets(text: Any) -> None:
        for match in _SECRET_REF_RE.finditer(str(text or "")):
            credential_names.add(match.group(1))

    def visit_step(node: dict[str, Any]) -> None:
        payload = node.get("payload") if isinstance(node.get("payload"), dict) else {}
        # Step headers/body may carry $secret.NAME slots.
        scan_secrets(payload.get("headers"))
        scan_secrets(payload.get("body"))
        # A step can wrap a nested query: an operation or another sequence.
        inner = str(payload.get("query_id") or "").strip()
        if inner:
            query_ids.add(inner)
            nested = catalog.fetch_query_for_compose(inner)
            if nested and (nested.get("kind") or "") == "sequence":
                add_sequence(inner)

    def add_sequence(qid: str) -> None:
        qid = (qid or "").strip()
        if not qid or qid in visited_sequences:
            return
        visited_sequences.add(qid)
        query_ids.add(qid)
        pkg = catalog.fetch_query_package(qid)
        if not pkg:
            return
        cypher = pkg.get("cypher") or []
        entry_labels = spaces._parse_sequence_cypher_labels(json.dumps(cypher))
        traverse = _cypher_traverses_downstream(cypher)
        seeds = [nid for lbl in entry_labels for nid in label_to_node_ids.get(lbl, [])]
        visited: set[str] = set()
        queue = list(seeds)
        while queue:
            nid = queue.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            step_node_ids.add(nid)
            node = nodes_by_id.get(nid)
            if node:
                visit_step(node)
            if traverse:
                for rel in adjacency.get(nid, []):
                    step_rel_ids.add(rel["id"])
                    queue.append(rel["target"])

    seq_seeds = list(sel["sequences"])
    for eid in sel["events"]:
        event = catalog.get_event(eid)
        if event:
            seq_seeds += [str(s) for s in (event.get("sequences") or [])]
            seq_seeds += [str(s) for s in (event.get("recovery_sequences") or [])]
    for qid in seq_seeds:
        add_sequence(qid)

    for qid in sel["operations"]:
        query_ids.add(qid)

    # Parse SCHEMA/INSTANCE/relationship labels from every non-sequence query (operations
    # act on the schema graph; sequences only reference STEP labels handled above).
    schema_labels: set[str] = set(sel["schemas"])
    regex_names: set[str] = set()
    query_rows = _fetch_query_rows(query_ids)
    for row in query_rows:
        if (row.get("kind") or "") == "sequence":
            continue
        schema_labels |= _attr_labels_in_cypher(row.get("cypher") or [])
        schema_labels |= _labels_in_builder_config(row.get("builder_config") or {})
        regex_names |= _formats_in_parameters(row.get("parameters") or [])

    # Step parameters may also reference regex formats.
    for nid in step_node_ids:
        node = nodes_by_id.get(nid) or {}
        payload = node.get("payload") if isinstance(node.get("payload"), dict) else {}
        regex_names |= _formats_in_parameters(payload.get("parameters") or [])

    # SCHEMA network: include schema nodes by label, and relationship patterns whose label
    # is referenced or whose endpoints are both included — pulling endpoint schemas in too.
    schema_nodes = _export_graph_nodes(sid, "SCHEMA")
    schema_id_to_label = {n["id"]: n["attributive_label"] for n in schema_nodes}
    schema_rels = _export_relationships(sid, {"SCHEMA"})
    changed = True
    while changed:
        changed = False
        for rel in schema_rels:
            rel_label = rel.get("attributive_label") or ""
            src_label = schema_id_to_label.get(rel.get("source"), "")
            tgt_label = schema_id_to_label.get(rel.get("target"), "")
            referenced = rel_label in schema_labels
            connected = bool(src_label) and bool(tgt_label) and (
                src_label in schema_labels and tgt_label in schema_labels
            )
            if referenced or connected:
                for lbl in (rel_label, src_label, tgt_label):
                    if lbl and lbl not in schema_labels:
                        schema_labels.add(lbl)
                        changed = True

    # regex formats declared on the included schemas' property schemata.
    for label in list(schema_labels):
        try:
            definition = graph.fetch_schema_definition(sid, label)
        except Exception:
            continue
        for prop in definition.get("schemata") or []:
            fmt = str(prop.get("format") or "").strip()
            if fmt and fmt.lower() != "any":
                regex_names.add(fmt)

    # INSTANCE inclusion is opt-in per schema (only for schemas actually included).
    instance_schema_labels = {lbl for lbl in sel["instances"] if lbl in schema_labels}

    # Credential metadata for the referenced slots (names + descriptions; never values).
    return {
        "selection": sel,
        "step_node_ids": step_node_ids,
        "step_rel_ids": step_rel_ids,
        "schema_labels": schema_labels,
        "instance_schema_labels": instance_schema_labels,
        "query_ids": query_ids,
        "query_rows": query_rows,
        "schema_nodes": schema_nodes,
        "schema_id_to_label": schema_id_to_label,
        "schema_rels": schema_rels,
        "regex_names": regex_names,
        "credential_names": credential_names,
        "event_ids": list(sel["events"]),
    }


def _export_graph_nodes(space_id: str, label: str) -> list[dict[str, Any]]:
    cypher = (
        f"MATCH (n:{label}) WHERE n.id IS NOT NULL "
        "RETURN n.id AS id, properties(n) AS props"
    )
    out = graph.run_cypher_for_space(space_id, cypher, {})
    nodes: list[dict[str, Any]] = []
    for row in out.get("records") or []:
        nid = (row.get("id") or "").strip()
        if not nid:
            continue
        props = row.get("props") if isinstance(row.get("props"), dict) else {}
        nodes.append(
            {
                "id": nid,
                "attributive_label": str(props.get("attributive_label") or ""),
                "properties": props,
            }
        )
    return nodes


def _export_relationships(space_id: str, roles: set[str]) -> list[dict[str, Any]]:
    cypher = (
        "MATCH (a)-[r:POINTS_TO]->(b) "
        "WHERE r.id IS NOT NULL AND a.id IS NOT NULL AND b.id IS NOT NULL "
        "RETURN r.id AS id, properties(r) AS props, a.id AS source, b.id AS target, "
        "labels(a) AS source_labels, labels(b) AS target_labels"
    )
    out = graph.run_cypher_for_space(space_id, cypher, {})
    rels: list[dict[str, Any]] = []
    for row in out.get("records") or []:
        rid = (row.get("id") or "").strip()
        if not rid:
            continue
        source_labels = set(row.get("source_labels") or [])
        target_labels = set(row.get("target_labels") or [])
        # Only keep relationships whose endpoints are both in the included role set.
        if not (source_labels & roles) or not (target_labels & roles):
            continue
        props = row.get("props") if isinstance(row.get("props"), dict) else {}
        rels.append(
            {
                "id": rid,
                "attributive_label": str(props.get("attributive_label") or ""),
                "source": (row.get("source") or "").strip(),
                "target": (row.get("target") or "").strip(),
                "properties": props,
            }
        )
    return rels


def _fetch_entities_by_ids(space_id: str, entity_ids: set[str]) -> list[dict[str, Any]]:
    """Per-space ``entities`` rows for the resolved graph element ids (STEP/SCHEMA/INSTANCE)."""
    ids = [eid for eid in entity_ids if eid]
    if not ids:
        return []
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        col = spaces.entities_node_label_column(conn)
        rows: list[dict[str, Any]] = []
        # Chunk to stay well under SQLite's bound-parameter limit.
        for start in range(0, len(ids), 400):
            chunk = ids[start : start + 400]
            placeholders = ",".join("?" * len(chunk))
            cur = conn.execute(
                f"SELECT id, {col} AS node_label, common_label, parameters, payload "
                f"FROM entities WHERE id IN ({placeholders}) ORDER BY id",
                chunk,
            )
            for row in cur.fetchall():
                rows.append(
                    {
                        "id": row[0],
                        "node_label": row[1],
                        "common_label": row[2],
                        "parameters": row[3],
                        "payload": row[4],
                    }
                )
        return rows
    finally:
        conn.close()


def _attr_labels_in_cypher(cypher_list: Any) -> set[str]:
    labels: set[str] = set()
    if not isinstance(cypher_list, list):
        return labels
    for stmt in cypher_list:
        for match in _ATTR_LABEL_RE.finditer(str(stmt or "")):
            label = match.group(1).strip()
            if label:
                labels.add(label)
    return labels


def _fetch_query_rows(query_ids: set[str]) -> list[dict[str, Any]]:
    """Full catalog query rows for an explicit id set (non-system only)."""
    ids = [qid for qid in query_ids if qid]
    if not ids:
        return []
    with catalog.catalog_connection() as conn:
        try:
            cur = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queries'"
            )
            if cur.fetchone() is None:
                return []
            rows: list[dict[str, Any]] = []
            for start in range(0, len(ids), 400):
                chunk = ids[start : start + 400]
                placeholders = ",".join("?" * len(chunk))
                cur = conn.execute(
                    "SELECT id, name, kind, operation, runtime_enabled, author_selectable, "
                    "triggerable, group_title, cypher, sqlite, parameters, builder_config, "
                    "description, loop_config FROM queries "
                    f"WHERE kind != 'system' AND id IN ({placeholders}) "
                    "ORDER BY name, id",
                    chunk,
                )
                for row in cur.fetchall():
                    rows.append(
                        {
                            "id": row[0],
                            "name": row[1],
                            "kind": row[2],
                            "operation": row[3],
                            "runtime_enabled": int(row[4] or 0),
                            "author_selectable": int(row[5] or 0),
                            "triggerable": int(row[6] if row[6] is not None else 1),
                            "group_title": row[7],
                            "cypher": json.loads(row[8] or "[]"),
                            "sqlite": json.loads(row[9] or "[]"),
                            "parameters": json.loads(row[10] or "[]"),
                            "builder_config": json.loads(row[11] or "{}"),
                            "description": row[12] or "",
                            "loop_config": json.loads(row[13] or "{}"),
                        }
                    )
            return rows
        except json.JSONDecodeError:
            return []


def _export_credentials(space_id: str, names: set[str]) -> list[dict[str, Any]]:
    """Credential *slots* (name + description only) for the referenced secrets — never values."""
    if not names:
        return []
    wanted = {credentials.normalize_credential_name(n) or n for n in names}
    out: list[dict[str, Any]] = []
    for cred in credentials.list_credentials(space_id):
        norm = credentials.normalize_credential_name(cred.get("name") or "")
        if (cred.get("name") in wanted) or (norm in wanted):
            out.append(
                {"name": cred.get("name") or "", "description": cred.get("description") or ""}
            )
            wanted.discard(cred.get("name"))
            wanted.discard(norm)
    # Slots referenced but not yet registered in the source space still travel as bare names
    # so the operator is prompted to populate them on import.
    for leftover in sorted(n for n in wanted if n):
        out.append({"name": leftover, "description": ""})
    return out


def _blank_event_secrets(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Strip HMAC/signing secrets from external-trigger event packages (never exported)."""
    cleaned: list[dict[str, Any]] = []
    for event in events:
        ev = dict(event)
        ext = ev.get("external_package")
        if isinstance(ext, dict) and "secret" in ext:
            ext = dict(ext)
            ext["secret"] = ""
            ev["external_package"] = ext
        cleaned.append(ev)
    return cleaned


def build_export(space_id: str, selection: dict[str, Any] | None = None) -> dict[str, Any]:
    """Assemble a portable template JSON from the resolved closure of *selection*."""
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")

    resolved = resolve_selection(sid, selection)

    schema_labels = resolved["schema_labels"]
    instance_labels = resolved["instance_schema_labels"]
    step_node_ids = resolved["step_node_ids"]
    step_rel_ids = resolved["step_rel_ids"]

    # --- graph nodes ---
    schema_nodes = [
        n for n in resolved["schema_nodes"] if n.get("attributive_label") in schema_labels
    ]
    all_step_nodes = _export_graph_nodes(sid, "STEP")
    step_nodes = [n for n in all_step_nodes if n.get("id") in step_node_ids]
    instance_nodes = [
        n
        for n in _export_graph_nodes(sid, "INSTANCE")
        if n.get("attributive_label") in instance_labels
    ]
    instance_node_ids = {n["id"] for n in instance_nodes}

    # --- relationships (schema-schema, step-step, instance-instance) ---
    included_schema_ids = {n["id"] for n in schema_nodes}
    relationships: list[dict[str, Any]] = []
    for rel in resolved["schema_rels"]:
        if rel.get("source") in included_schema_ids and rel.get("target") in included_schema_ids:
            relationships.append(rel)
    all_step_node_ids = {n["id"] for n in step_nodes}
    for rel in _export_relationships(sid, {"STEP"}):
        if rel.get("id") in step_rel_ids and rel.get("source") in all_step_node_ids and rel.get(
            "target"
        ) in all_step_node_ids:
            relationships.append(rel)
    if instance_node_ids:
        for rel in _export_relationships(sid, {"INSTANCE"}):
            if rel.get("source") in instance_node_ids and rel.get("target") in instance_node_ids:
                relationships.append(rel)

    rel_ids = {r["id"] for r in relationships}
    graph_section: dict[str, Any] = {
        "schema_nodes": schema_nodes,
        "step_nodes": step_nodes,
        "instance_nodes": instance_nodes,
        "relationships": relationships,
    }

    # --- per-space entities for every included graph element ---
    entity_ids = (
        included_schema_ids
        | all_step_node_ids
        | instance_node_ids
        | rel_ids
    )
    entities = _fetch_entities_by_ids(sid, entity_ids)

    # --- catalog queries (already resolved as full rows) ---
    query_rows = resolved["query_rows"]

    # --- regex patterns referenced by schemas / parameters ---
    regex_names = resolved["regex_names"]
    regex_rows = [
        r for r in catalog.list_regex_patterns() if (r.get("name") or "") in regex_names
    ]

    # --- events (selected), with signing secrets blanked ---
    event_rows: list[dict[str, Any]] = []
    for eid in resolved["event_ids"]:
        event = catalog.get_event(eid)
        if event:
            event_rows.append(event)
    event_rows = _blank_event_secrets(event_rows)

    # --- credential slots ---
    credential_names = set(resolved["credential_names"])
    credential_rows = _export_credentials(sid, credential_names)

    summary = {
        "schemas": len(schema_nodes),
        "steps": len(step_nodes),
        "instances": len(instance_nodes),
        "relationships": len(relationships),
        "queries": len(query_rows),
        "operations": sum(1 for q in query_rows if (q.get("kind") or "") != "sequence"),
        "sequences": sum(1 for q in query_rows if (q.get("kind") or "") == "sequence"),
        "regex": len(regex_rows),
        "events": len(event_rows),
        "resources": 0,
        "credential_slots": len(credential_rows),
    }

    return {
        "template_id": config.generate_entity_id(),
        "schema_version": SCHEMA_VERSION,
        "created_at": _now(),
        "source_space_id": sid,
        "selection": resolved["selection"],
        "summary": summary,
        "graph": graph_section,
        "sqlite": {
            "entities": entities,
            "queries": query_rows,
            "regex": regex_rows,
            "events": event_rows,
        },
        "credentials": credential_rows,
    }
