"""
Graph-level INSTANCE currency under the add/delete-only SCHEMA model.

When a SCHEMA changes, the live INSTANCE nodes/relationships in Neo4j (INSTANCE data is *not*
mirrored in the per-space SQLite ``entities`` table) can fall out of step with the new pattern:

- A **deleted** property is auto-removed from every instance of that label (cleanup, not drift).
- A newly-added **required** property leaves every existing instance missing it, so each such
  instance is stamped ``is_current = false`` until it is updated to conform. Adding an *optional*
  property never makes an instance out of sync.

An instance is "out of sync" iff it is missing at least one required, non-key property. Once an
INSTANCE update fills in those properties, :func:`reconcile_instance_currency` removes the marker.

Everything here runs graph-level Cypher via ``graph.run_cypher_for_space`` (the same runtime
execution layer the app uses for create/update). The same ``attributive_label`` may identify
either an INSTANCE node or a relationship instance; relationship patterns always require
``(:INSTANCE)-[r:POINTS_TO]->(:INSTANCE)`` so SCHEMA pattern edges are never touched.
"""

from __future__ import annotations

import sys
from collections.abc import Iterable
from typing import Any

from . import cypher_utils, graph

# Relationship-scoped patterns: only INSTANCE data edges, never SCHEMA pattern POINTS_TO
# (both carry attributive_label on POINTS_TO; the latter must not receive is_current).
_INSTANCE_REL_MATCH = (
    "(:INSTANCE)-[r:POINTS_TO {attributive_label: $al}]->(:INSTANCE)"
)


_escape_identifier = cypher_utils.escape_identifier


def _required_nonkey_keys(schemata: list[Any]) -> list[str]:
    """Required, non-key property keys from a schemata constraint list (key or name based)."""
    keys: list[str] = []
    for entry in schemata or []:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key") or entry.get("name") or "").strip()
        if not key:
            continue
        if entry.get("is_key"):
            continue
        if entry.get("is_required"):
            keys.append(key)
    return keys


def _missing_predicate(var: str, required_keys: list[str]) -> str:
    """Cypher boolean: ``var`` is missing at least one required key (null/absent)."""
    parts = [f"{var}.`{_escape_identifier(k)}` IS NULL" for k in required_keys]
    return " OR ".join(parts)


def _count(space_id: str, cypher: str, params: dict[str, Any]) -> int:
    out = graph.run_cypher_for_space(space_id, cypher, params)
    records = out.get("records") or []
    if not records:
        return 0
    value = records[0].get("c")
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _current_required_nonkey_keys(space_id: str, attributive_label: str) -> list[str]:
    """Required, non-key keys from the *persisted* schema for this label (empty if unresolved)."""
    try:
        definition = graph.fetch_schema_definition(space_id, attributive_label)
    except Exception:
        return []
    return _required_nonkey_keys(definition.get("schemata") or [])


def count_out_of_sync_instances(
    space_id: str, attributive_label: str, incoming_schemata: list[Any]
) -> int:
    """How many INSTANCE nodes + relationships would be out of sync under ``incoming_schemata``.

    Out of sync == missing at least one required, non-key property. Since a newly-added required
    property is absent on every existing instance, those instances are counted. Returns 0 when the
    proposed schema has no required non-key property to be missing. Pure read; mutates nothing.
    """
    sid = (space_id or "").strip()
    al = (attributive_label or "").strip()
    if not sid or not al:
        return 0
    required = _required_nonkey_keys(incoming_schemata)
    if not required:
        return 0
    missing = _missing_predicate("n", required)
    node_count = _count(
        sid,
        f"MATCH (n:INSTANCE {{attributive_label: $al}}) WHERE {missing} RETURN count(n) AS c",
        {"al": al},
    )
    missing_rel = _missing_predicate("r", required)
    rel_count = _count(
        sid,
        f"MATCH {_INSTANCE_REL_MATCH} WHERE {missing_rel} RETURN count(r) AS c",
        {"al": al},
    )
    return node_count + rel_count


def scrub_schema_pattern_currency_markers(space_id: str) -> int:
    """Remove ``is_current`` wrongly stamped on SCHEMA pattern POINTS_TO edges (not INSTANCE data)."""
    sid = (space_id or "").strip()
    if not sid:
        return 0
    try:
        return _count(
            sid,
            "MATCH (:SCHEMA)-[r:POINTS_TO]->(:SCHEMA) WHERE r.is_current IS NOT NULL "
            "WITH r REMOVE r.is_current RETURN count(r) AS c",
            {},
        )
    except Exception:
        return 0


def apply_instance_schema_change(
    space_id: str, attributive_label: str, deleted_keys: list[str]
) -> dict[str, int]:
    """Reconcile live instances to a just-persisted SCHEMA change.

    1. Auto-remove every deleted property from all INSTANCE nodes + relationships of this label.
    2. Stamp ``is_current = false`` on instances missing any required, non-key property.

    Returns ``{"deleted_from": <node+rel removals>, "marked": <node+rel marked>}``.
    """
    sid = (space_id or "").strip()
    al = (attributive_label or "").strip()
    if not sid or not al:
        return {"deleted_from": 0, "marked": 0}

    deleted_from = 0
    for raw in deleted_keys or []:
        key = (raw or "").strip()
        if not key:
            continue
        esc = _escape_identifier(key)
        deleted_from += _count(
            sid,
            f"MATCH (n:INSTANCE {{attributive_label: $al}}) WHERE n.`{esc}` IS NOT NULL "
            f"WITH n REMOVE n.`{esc}` RETURN count(n) AS c",
            {"al": al},
        )
        deleted_from += _count(
            sid,
            f"MATCH {_INSTANCE_REL_MATCH} WHERE r.`{esc}` IS NOT NULL "
            f"WITH r REMOVE r.`{esc}` RETURN count(r) AS c",
            {"al": al},
        )

    marked = 0
    required = _current_required_nonkey_keys(sid, al)
    if required:
        missing = _missing_predicate("n", required)
        marked += _count(
            sid,
            f"MATCH (n:INSTANCE {{attributive_label: $al}}) WHERE {missing} "
            "SET n.is_current = false RETURN count(n) AS c",
            {"al": al},
        )
        missing_rel = _missing_predicate("r", required)
        marked += _count(
            sid,
            f"MATCH {_INSTANCE_REL_MATCH} WHERE {missing_rel} "
            "SET r.is_current = false RETURN count(r) AS c",
            {"al": al},
        )

    scrub_schema_pattern_currency_markers(sid)

    return {"deleted_from": deleted_from, "marked": marked}


def reconcile_instance_currency(space_id: str, attributive_label: str) -> dict[str, int]:
    """Clear ``is_current`` from instances of this label that now fully conform to the schema.

    Conforming == not missing any required, non-key property. Called after an INSTANCE update so a
    re-saved instance is released the moment it matches. Returns ``{"cleared": <node+rel>}``.
    """
    sid = (space_id or "").strip()
    al = (attributive_label or "").strip()
    if not sid or not al:
        return {"cleared": 0}

    required = _current_required_nonkey_keys(sid, al)
    cleared = 0
    if required:
        node_where = f"n.is_current = false AND NOT ({_missing_predicate('n', required)})"
        rel_where = f"r.is_current = false AND NOT ({_missing_predicate('r', required)})"
    else:
        # No required property can be missing, so every marked instance now conforms.
        node_where = "n.is_current = false"
        rel_where = "r.is_current = false"
    cleared += _count(
        sid,
        f"MATCH (n:INSTANCE {{attributive_label: $al}}) WHERE {node_where} "
        "WITH n REMOVE n.is_current RETURN count(n) AS c",
        {"al": al},
    )
    cleared += _count(
        sid,
        f"MATCH {_INSTANCE_REL_MATCH} WHERE {rel_where} "
        "WITH r REMOVE r.is_current RETURN count(r) AS c",
        {"al": al},
    )
    return {"cleared": cleared}


def reconcile_labels(
    space_id: str, labels: Iterable[str], *, log_context: str = ""
) -> None:
    """Best-effort :func:`reconcile_instance_currency` over several labels (never raises).

    Shared by the ``/api/execute-query`` route and the executor's query step, which both
    release stale currency markers after an INSTANCE update.
    """
    suffix = f" ({log_context})" if log_context else ""
    for label in labels:
        try:
            reconcile_instance_currency(space_id, label)
        except Exception as e:
            sys.stderr.write(f"instance currency reconcile error{suffix}: {e}\n")
