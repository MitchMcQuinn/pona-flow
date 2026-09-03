"""
Delete an operation and its one-step sequence wrap without wiping multi-step dependents.

The STEP delete cascade (``step_delete``) removes every sequence that MATCHES the wrap
STEP. Deleting from a one-step nav row must do the opposite for multi-step sequences:
keep their catalog rows and suspend them until the author resaves a valid STEP chain.

Graph cleanup (DETACH DELETE + entities) is the same as a STEP purge; catalog cleanup
deletes the operation row and one-step sequences, then flags multi-step dependents.
"""

from __future__ import annotations

import json
from typing import Any

from . import catalog, cypher_utils, graph, schema_delete, spaces, step_delete


def _parse_cypher(raw: Any) -> list[Any]:
    if isinstance(raw, list):
        return raw
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    return parsed if isinstance(parsed, list) else []


def partition_sequences_for_step_label(
    attributive_label: str,
    queries: list[dict[str, Any]] | None = None,
) -> dict[str, list[dict[str, str]]]:
    """Split catalog sequences that MATCH ``attributive_label`` into one-step vs multi-step.

    ``queries`` is optional so diagnostics can feed synthetic rows without a live catalog.
    Each row needs ``id``, ``name``, ``kind``, and ``cypher`` (JSON string or list).
    """
    al = (attributive_label or "").strip()
    one_step: list[dict[str, str]] = []
    multi_step: list[dict[str, str]] = []
    rows = queries if queries is not None else schema_delete._catalog_queries()
    if not al:
        return {"one_step": one_step, "multi_step": multi_step}
    for q in rows:
        if (q.get("kind") or "") != "sequence":
            continue
        raw = q.get("cypher")
        labels = set(spaces._parse_sequence_cypher_labels(
            raw if isinstance(raw, str) else json.dumps(raw or [])
        ))
        if al not in labels:
            continue
        entry = {"id": (q.get("id") or "").strip(), "name": str(q.get("name") or "")}
        if not entry["id"]:
            continue
        if cypher_utils.cypher_traverses_downstream(_parse_cypher(raw)):
            multi_step.append(entry)
        else:
            one_step.append(entry)
    return {"one_step": one_step, "multi_step": multi_step}


def _query_by_id(query_id: str) -> dict[str, Any] | None:
    qid = (query_id or "").strip()
    if not qid:
        return None
    for row in schema_delete._catalog_queries():
        if row["id"] == qid:
            return row
    return None


def _attributive_label_for_entity(space_id: str, entity_id: str) -> str:
    eid = (entity_id or "").strip()
    if not eid:
        return ""
    for row in schema_delete._step_entities(space_id):
        if row["id"] == eid:
            return (row.get("attributive_label") or "").strip()
    return ""


def _operation_id_for_step_label(space_id: str, attributive_label: str) -> str:
    al = (attributive_label or "").strip()
    if not al:
        return ""
    for row in schema_delete._step_entities(space_id):
        if (row.get("attributive_label") or "").strip() != al:
            continue
        qid = str((row.get("payload") or {}).get("query_id") or "").strip()
        if qid:
            return qid
    return ""


def resolve_operation_deletion(
    space_id: str,
    operation_id: str | None = None,
    sequence_id: str | None = None,
) -> dict[str, Any]:
    """Locate the wrap STEP, the operation row, and the sequences that MATCH it."""
    sid = (space_id or "").strip()
    op_id = (operation_id or "").strip()
    seq_id = (sequence_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    if not op_id and not seq_id:
        raise ValueError("operation_id or sequence_id is required")

    attributive_label = ""
    operation_name = ""

    if seq_id:
        seq = _query_by_id(seq_id)
        if not seq or seq.get("kind") != "sequence":
            raise ValueError(f"No sequence with id {seq_id!r}")
        attributive_label = step_delete._sequence_entry_label(seq.get("cypher"))
        op_id = _operation_id_for_step_label(sid, attributive_label)
        if not op_id:
            # Fall back: the one-step wrap is named after the operation.
            op_row = next(
                (
                    q
                    for q in schema_delete._catalog_queries()
                    if q.get("kind") == "operation" and q.get("name") == seq.get("name")
                ),
                None,
            )
            op_id = (op_row or {}).get("id") or ""
            operation_name = str((op_row or {}).get("name") or seq.get("name") or "")
        else:
            op_row = _query_by_id(op_id)
            operation_name = str((op_row or {}).get("name") or "")
    else:
        op_row = _query_by_id(op_id)
        if not op_row or op_row.get("kind") != "operation":
            raise ValueError(f"No operation with id {op_id!r}")
        operation_name = str(op_row.get("name") or "")
        wrap_id = graph.fetch_step_wrap_entity_id(sid, op_id) or ""
        attributive_label = _attributive_label_for_entity(sid, wrap_id) or operation_name

    parts = partition_sequences_for_step_label(attributive_label)
    one_step_ids = [s["id"] for s in parts["one_step"]]
    if seq_id and seq_id not in one_step_ids:
        # The clicked row is the wrap even if Cypher classification missed it.
        parts["one_step"].append({"id": seq_id, "name": str((_query_by_id(seq_id) or {}).get("name") or "")})
        one_step_ids.append(seq_id)

    graph_targets: dict[str, Any] = {
        "step_node_ids": [],
        "step_rel_ids": [],
        "relationship_labels": [],
    }
    if attributive_label:
        try:
            graph_targets = step_delete._resolve_graph_targets(sid, attributive_label)
        except Exception:
            graph_targets = {
                "step_node_ids": [],
                "step_rel_ids": [],
                "relationship_labels": [],
            }

    ref_tokens = set(one_step_ids) | {op_id, attributive_label}
    affected_state: list[dict[str, str]] = []
    for state in schema_delete._state_rows():
        package = state["package"]
        if any(token and token in package for token in ref_tokens):
            affected_state.append({"id": state["id"], "status": state["status"]})

    return {
        "space_id": sid,
        "operation_id": op_id,
        "operation_name": operation_name,
        "attributive_label": attributive_label,
        "one_step_sequences": parts["one_step"],
        "multi_step_sequences": parts["multi_step"],
        "step_node_ids": graph_targets["step_node_ids"],
        "step_rel_ids": graph_targets["step_rel_ids"],
        "affected_state": affected_state,
    }


def preview_operation_deletion(
    space_id: str,
    operation_id: str | None = None,
    sequence_id: str | None = None,
) -> dict[str, Any]:
    """Read-only dry run: what an operation delete would remove vs suspend."""
    resolution = resolve_operation_deletion(space_id, operation_id, sequence_id)
    return {
        "space_id": resolution["space_id"],
        "operation_id": resolution["operation_id"],
        "operation_name": resolution["operation_name"],
        "attributive_label": resolution["attributive_label"],
        "requires_confirmation": True,
        "one_step_sequences": resolution["one_step_sequences"],
        "multi_step_sequences": resolution["multi_step_sequences"],
        "summary": {
            "one_step_sequences": len(resolution["one_step_sequences"]),
            "multi_step_sequences": len(resolution["multi_step_sequences"]),
            "execution_packages": len(resolution["affected_state"]),
        },
    }


def execute_operation_deletion(
    space_id: str,
    operation_id: str | None = None,
    sequence_id: str | None = None,
    confirm: bool = False,
) -> dict[str, Any]:
    """Delete the operation, its wrap STEP, and one-step sequences; suspend multi-step dependents."""
    if not confirm:
        raise ValueError("confirm must be true to execute an operation deletion")

    resolution = resolve_operation_deletion(space_id, operation_id, sequence_id)
    sid = resolution["space_id"]
    al = resolution["attributive_label"]
    op_id = resolution["operation_id"]
    one_step_ids = [s["id"] for s in resolution["one_step_sequences"] if s.get("id")]
    multi_ids = [s["id"] for s in resolution["multi_step_sequences"] if s.get("id")]

    result: dict[str, Any] = {
        "space_id": sid,
        "operation_id": op_id,
        "attributive_label": al,
        "one_step_deleted": one_step_ids,
        "multi_step_suspended": multi_ids,
    }

    if multi_ids:
        catalog.set_sequences_suspended(multi_ids, True)

    if al:
        result["graph"] = step_delete._delete_graph_nodes(sid, al)
        result["entities_deleted"] = schema_delete.delete_entities_rows(
            sid, resolution["step_node_ids"] + resolution["step_rel_ids"]
        )
        # Keep the wrap label on the space when multi-step dependents remain so they
        # stay visible in the nav (red/suspended) rather than disappearing.
        if not multi_ids:
            spaces.remove_space_attributive_labels(sid, [al])

    catalog_ids = list(dict.fromkeys([*one_step_ids, op_id]))
    catalog_ids = [cid for cid in catalog_ids if cid]
    result["catalog"] = schema_delete.delete_catalog_rows(
        catalog_ids,
        [s["id"] for s in resolution["affected_state"]],
    )
    return result
