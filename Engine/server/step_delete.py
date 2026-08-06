"""
STEP pattern delete cascade — resolution, preview, and execution.

Deleting a STEP must not leave dangling sequences: a sequence is a chain of STEP nodes
matched by ``attributive_label``, so removing a STEP that a sequence references would
leave that sequence pointing at a node that no longer exists. This module resolves the
full blast radius of a STEP delete and cascades it across the three pattern stores:

- Neo4j (per-space, shared by all public spaces): STEP nodes + POINTS_TO relationships.
- ``entities`` (per-space SQLite mirror): one row per node/relationship.
- ``queries`` (catalog ``data.db``): the dependent sequences (kind = 'sequence').

Like the SCHEMA cascade, public spaces are filtered views over a shared graph, so a delete
resolves to either:

- **purge** — physically remove the STEP, its relationship patterns, and every dependent
  sequence / orphaned state package (when no *other* space references the affected labels), or
- **unlink** — leave the patterns intact and only remove the affected labels from the active
  space's ``labels`` array (when other spaces still reference them), with a non-blocking
  warning naming those shared spaces.

Split into a read-only :func:`preview_step_deletion` and :func:`execute_step_deletion`,
which only mutates when ``confirm=True``.
"""

from __future__ import annotations

from typing import Any

from . import graph, spaces
from .schema_delete import (
    _catalog_queries,
    _graph_single_column,
    _labels_in_cypher_array,
    _state_rows,
    delete_catalog_rows,
    delete_entities_rows,
)


def _resolve_graph_targets(space_id: str, attributive_label: str) -> dict[str, Any]:
    """
    Collect graph-side ids/labels for a STEP delete from the (shared) per-space Neo4j db.

    Returns the STEP node ids for this label, the ids of POINTS_TO relationships touching
    those nodes, and the attributive_labels of those relationship patterns.
    """
    al = attributive_label

    step_node_ids = _graph_single_column(
        space_id,
        "MATCH (n:STEP {attributive_label: $al}) RETURN n.id AS id",
        {"al": al},
        "id",
    )

    rel_rows = graph.run_cypher_for_space(
        space_id,
        "MATCH (n:STEP {attributive_label: $al})-[r:POINTS_TO]-() "
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

    return {
        "step_node_ids": step_node_ids,
        "step_rel_ids": rel_ids,
        "relationship_labels": sorted(rel_labels, key=str.casefold),
    }


def _sequence_entry_label(raw_cypher: str | None) -> str:
    """The entry (first) STEP attributive_label of a sequence query, used for nav unlink."""
    labels = spaces._parse_sequence_cypher_labels(raw_cypher)
    return labels[0] if labels else ""


def resolve_step_deletion(space_id: str, attributive_label: str) -> dict[str, Any]:
    """
    Compute the full set of artifacts affected by deleting STEP *attributive_label*.

    Pure read; never mutates. The returned dict drives both the preview and the execution
    (which re-resolves to avoid acting on stale data).
    """
    sid = (space_id or "").strip()
    al = (attributive_label or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    if not al:
        raise ValueError("attributive_label is required")

    targets = _resolve_graph_targets(sid, al)
    if not targets["step_node_ids"]:
        raise ValueError(f"No STEP node with attributive_label {al!r} in space {sid!r}")

    # The step label plus the labels of POINTS_TO patterns touching it.
    affected_labels = {al} | set(targets["relationship_labels"])

    # Sequences depend on a STEP when their cypher matches it by attributive_label (as a
    # chained STEP) or references one of the affected relationship-pattern labels.
    queries = _catalog_queries()
    affected_sequences: list[dict[str, str]] = []
    affected_sequence_ids: set[str] = set()
    sequence_entry_labels: set[str] = set()
    for q in queries:
        if q["kind"] != "sequence":
            continue
        seq_step_labels = set(spaces._parse_sequence_cypher_labels(q["cypher"]))
        seq_labels = _labels_in_cypher_array(q["cypher"])
        if al in seq_step_labels or (affected_labels & seq_labels):
            affected_sequences.append({"id": q["id"], "name": q["name"]})
            affected_sequence_ids.add(q["id"])
            entry = _sequence_entry_label(q["cypher"])
            if entry:
                sequence_entry_labels.add(entry)

    # Removing these labels from a space's filtered view hides the step and its dependent
    # sequences (a sequence's nav label is its entry STEP's attributive_label).
    unlink_labels = affected_labels | sequence_entry_labels

    is_private = spaces.space_is_private(sid)
    if is_private:
        shared_spaces: list[dict[str, str]] = []
    else:
        shared_spaces = spaces.spaces_referencing_labels(unlink_labels, exclude_id=sid)
    mode = "unlink" if shared_spaces else "purge"

    # State packages that reference an affected sequence id or the step label.
    ref_tokens = affected_sequence_ids | {al}
    affected_state: list[dict[str, str]] = []
    for state in _state_rows():
        package = state["package"]
        if any(token and token in package for token in ref_tokens):
            affected_state.append({"id": state["id"], "status": state["status"]})

    return {
        "space_id": sid,
        "attributive_label": al,
        "is_private": is_private,
        "mode": mode,
        "affected_labels": sorted(affected_labels, key=str.casefold),
        "relationship_labels": targets["relationship_labels"],
        "step_node_ids": targets["step_node_ids"],
        "step_rel_ids": targets["step_rel_ids"],
        "affected_sequences": affected_sequences,
        "affected_sequence_ids": sorted(affected_sequence_ids),
        "affected_state": affected_state,
        "shared_spaces": shared_spaces,
        "unlink_labels": sorted(unlink_labels, key=str.casefold),
    }


def _build_warnings(resolution: dict[str, Any]) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    shared = resolution["shared_spaces"]
    if shared:
        names = ", ".join(s["name"] for s in shared)
        warnings.append(
            {
                "type": "shared_spaces",
                "blocking": False,
                "message": (
                    "The sequences affected by this deletion will remain active within "
                    f"shared spaces: {names}"
                ),
                "spaces": shared,
            }
        )
    return warnings


def preview_step_deletion(space_id: str, attributive_label: str) -> dict[str, Any]:
    """Read-only dry run: what a STEP delete *would* do, plus warnings. Mutates nothing."""
    resolution = resolve_step_deletion(space_id, attributive_label)
    return {
        "space_id": resolution["space_id"],
        "attributive_label": resolution["attributive_label"],
        "mode": resolution["mode"],
        "requires_confirmation": True,
        "summary": {
            "relationship_patterns": len(resolution["relationship_labels"]),
            "sequences": len(resolution["affected_sequences"]),
            "execution_packages": len(resolution["affected_state"]),
            "shared_spaces": len(resolution["shared_spaces"]),
        },
        "affected": {
            "labels": resolution["affected_labels"],
            "relationship_labels": resolution["relationship_labels"],
            "sequences": resolution["affected_sequences"],
            "execution_packages": resolution["affected_state"],
            "shared_spaces": resolution["shared_spaces"],
        },
        "warnings": _build_warnings(resolution),
    }


def _delete_graph_nodes(space_id: str, attributive_label: str) -> dict[str, int]:
    """DETACH DELETE the STEP nodes from the shared graph (idempotent)."""
    out = graph.run_cypher_for_space(
        space_id,
        "MATCH (n:STEP {attributive_label: $al}) DETACH DELETE n",
        {"al": attributive_label},
    )
    deleted = int(out.get("summary", {}).get("counters", {}).get("nodes_deleted", 0))
    return {"nodes_deleted": deleted}


def execute_step_deletion(
    space_id: str, attributive_label: str, confirm: bool = False
) -> dict[str, Any]:
    """
    Apply the STEP delete cascade. Requires ``confirm=True`` (callers should show the
    preview first).

    - **unlink** mode: only removes the affected labels from the active space's ``labels``
      array; shared spaces keep the step and its sequences.
    - **purge** mode: removes the STEP, its relationship patterns, dependent sequences, and
      orphaned state packages from Neo4j, ``entities``, and the catalog. Ordered graph →
      entities → catalog; every step is idempotent so a partial failure can be retried.
    """
    if not confirm:
        raise ValueError("confirm must be true to execute a step deletion")

    resolution = resolve_step_deletion(space_id, attributive_label)
    sid = resolution["space_id"]
    al = resolution["attributive_label"]

    result: dict[str, Any] = {
        "space_id": sid,
        "attributive_label": al,
        "mode": resolution["mode"],
        "warnings": _build_warnings(resolution),
    }

    # Always unlink the active space's filtered view from the affected labels.
    unlinked = spaces.remove_space_attributive_labels(sid, resolution["unlink_labels"])
    result["unlinked_labels"] = unlinked["removed"]

    if resolution["mode"] == "unlink":
        result["purged"] = False
        return result

    # purge: physically delete from the shared stores. Graph first (most likely to fail
    # when Neo4j is unavailable), then the SQLite mirrors.
    result["graph"] = _delete_graph_nodes(sid, al)
    result["entities_deleted"] = delete_entities_rows(
        sid, resolution["step_node_ids"] + resolution["step_rel_ids"]
    )
    result["catalog"] = delete_catalog_rows(
        resolution["affected_sequence_ids"],
        [s["id"] for s in resolution["affected_state"]],
    )
    result["purged"] = True
    return result
