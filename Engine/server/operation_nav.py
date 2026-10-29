"""File a saved operation in the sequences nav.

The builder does this in the client: a catalog operation, a STEP that points at
it, and a one-step sequence whose read matches that STEP. The nav only lists a
sequence when that STEP label is on the space. Chat saves the operation row
directly, so this module does the same filing on the server.
"""

from __future__ import annotations

import json
import sys

from . import catalog, cypher_utils, graph, id_generator, packages, spaces


def _quote_cypher(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _quote_sqlite(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def one_step_sequence_cypher(label: str) -> str:
    return f"MATCH (step:STEP {{ attributive_label: {_quote_cypher(label)} }}) RETURN *"


def labels_in_statements(statements: list[str]) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for statement in statements:
        for match in cypher_utils.ATTR_LABEL_RE.finditer(str(statement or "")):
            label = match.group(1).strip()
            if not label or label in seen:
                continue
            seen.add(label)
            found.append(label)
    return found


def register_sequence_labels(space_id: str, statements: list[str]) -> None:
    """A sequence shows in the nav only when its entry STEP label is on the space."""
    labels = labels_in_statements(statements)
    if labels:
        spaces.append_space_attributive_labels(space_id, labels)


def _sequence_id_for_name(name: str) -> str:
    token = (name or "").strip()
    if not token:
        return ""
    with catalog.catalog_connection() as conn:
        row = conn.execute(
            "SELECT id FROM queries WHERE kind = 'sequence' AND name = ? ORDER BY id LIMIT 1",
            (token,),
        ).fetchone()
    return str(row[0]) if row else ""


def _operation_meta(operation_id: str) -> tuple[str | None, str]:
    with catalog.catalog_connection() as conn:
        row = conn.execute(
            "SELECT group_title, description FROM queries WHERE id = ?",
            (operation_id,),
        ).fetchone()
    if row is None:
        return None, ""
    group = (row[0] or "").strip() or None
    return group, (row[1] or "")


def _builder_config(sequence_id: str, label: str) -> str:
    return json.dumps(
        {
            "version": 1,
            "runtimeEnabled": True,
            "matchPositions": {},
            "query": {
                "id": sequence_id,
                "name": label,
                "operation": "read",
                "parameters": [],
                "match": [
                    {
                        "label": "STEP",
                        "optional": False,
                        "patterns": [
                            {
                                "path": [
                                    {
                                        "kind": "node",
                                        "node": {
                                            "variable": "n1",
                                            "alias_mode": "define",
                                            "properties": [],
                                            "attributive_label": label,
                                        },
                                    }
                                ]
                            }
                        ],
                    }
                ],
                "return": {"distinct": False, "items": []},
                "allow_duplicates": False,
                "hide_duplicates": False,
            },
        }
    )


def _wrap_step(space_id: str, operation_id: str, label: str) -> None:
    """STEP entity plus graph node, keyed so a repeat save updates the same wrap."""
    entity_id = graph.fetch_step_wrap_entity_id(space_id, operation_id) or id_generator.generate_id()
    quoted_id = _quote_sqlite(entity_id)
    quoted_op = _quote_sqlite(operation_id)
    quoted_name = _quote_sqlite(label)
    payload = _quote_sqlite(json.dumps({"query_id": operation_id}))
    sqlite = [
        "UPDATE entities SET common_label = "
        + quoted_name
        + ", modified_date = datetime('now') WHERE node_label = 'STEP' AND json_extract(payload, '$.query_id') = "
        + quoted_op
        + ";",
        "INSERT INTO entities (id, node_label, common_label, parameters, payload, creation_date, modified_date) "
        "SELECT "
        + quoted_id
        + ", 'STEP', "
        + quoted_name
        + ", '[]', "
        + payload
        + ", datetime('now'), datetime('now') "
        "WHERE NOT EXISTS (SELECT 1 FROM entities WHERE node_label = 'STEP' AND json_extract(payload, '$.query_id') = "
        + quoted_op
        + ");",
    ]
    cypher_name = _quote_cypher(label)
    cypher_id = _quote_cypher(entity_id)
    cypher = [
        "MATCH (stale:STEP { attributive_label: "
        + cypher_name
        + " }) WHERE stale.id <> "
        + cypher_id
        + " DETACH DELETE stale",
        "MERGE (step:STEP { id: "
        + cypher_id
        + " }) SET step.attributive_label = "
        + cypher_name
        + " RETURN *",
    ]
    packages.execute_create_package(
        space_id,
        cypher,
        sqlite,
        {},
        None,
        [label],
        [entity_id],
    )


def publish_operation_sequence(space_id: str, operation_id: str) -> str:
    """Wrap an operation as a one-step sequence and register its label. Idempotent."""
    op = catalog.fetch_query_for_compose(operation_id)
    if op is None or str(op.get("kind") or "") != "operation":
        return ""
    label = str(op.get("name") or "").strip()
    if not label:
        return ""
    sequence_id = _sequence_id_for_name(label)
    registered = label in set(spaces.fetch_space_labels(space_id))
    wrapped = graph.fetch_step_wrap_entity_id(space_id, operation_id)
    if sequence_id and registered and wrapped:
        return sequence_id
    if not wrapped or not registered:
        _wrap_step(space_id, operation_id, label)
    if not sequence_id:
        sequence_id = id_generator.generate_id()
        group, description = _operation_meta(operation_id)
        catalog.upsert_queries_catalog_row(
            sequence_id,
            label,
            [one_step_sequence_cypher(label)],
            [],
            [],
            kind="sequence",
            operation="read",
            runtime_enabled=1,
            author_selectable=1,
            group_title=group,
            triggerable=1,
            builder_config=_builder_config(sequence_id, label),
            description=description,
        )
    return sequence_id


def _accepted_operation_ids(space_id: str) -> list[str]:
    with catalog.catalog_connection() as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if "chat_messages" not in tables or "chat_threads" not in tables:
            return []
        rows = conn.execute(
            """
            SELECT m.batch FROM chat_messages m
            JOIN chat_threads t ON t.id = m.thread_id
            WHERE t.space_id = ? AND m.batch IS NOT NULL
            """,
            (space_id,),
        ).fetchall()
    found: list[str] = []
    seen: set[str] = set()
    for (raw,) in rows:
        try:
            batch = json.loads(raw or "{}")
        except json.JSONDecodeError:
            continue
        if not isinstance(batch, dict) or batch.get("status") not in ("accepted", "partial"):
            continue
        items = batch.get("items") if isinstance(batch.get("items"), list) else []
        for item in items:
            if not isinstance(item, dict) or item.get("kind") != "upsert_query":
                continue
            payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
            kind = str(payload.get("kind") or "operation").strip().lower()
            if kind != "operation":
                continue
            op_id = str(payload.get("id") or "").strip()
            if not op_id:
                named = catalog.find_query_by_name(str(payload.get("name") or ""))
                if named and str(named.get("kind") or "") == "operation":
                    op_id = str(named.get("id") or "")
            if not op_id or op_id in seen:
                continue
            seen.add(op_id)
            found.append(op_id)
    return found


def publish_chat_operations(space_id: str) -> None:
    """File operations an accepted chat batch saved but never wrapped.

    A graph failure on one operation does not hide the space.
    """
    try:
        operation_ids = _accepted_operation_ids(space_id)
    except Exception as exc:
        sys.stderr.write(f"chat sequence filing skipped: {exc}\n")
        return
    for operation_id in operation_ids:
        try:
            publish_operation_sequence(space_id, operation_id)
        except Exception as exc:
            sys.stderr.write(f"chat sequence filing skipped for {operation_id}: {exc}\n")
