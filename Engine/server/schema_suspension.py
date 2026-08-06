"""
SCHEMA-change suspension cascade for sequences.

When a SCHEMA is updated (add/delete-only), any sequence whose STEP chain contains an
INSTANCE step that no longer matches the new SCHEMA pattern is **suspended**: it cannot be
composed/run by users or MCP agents until the offending INSTANCE step is re-saved to match
the new pattern (see :mod:`schema_update` and ``execution.compose_execution_package``).

What counts as "affected" (per product spec):

- **create-INSTANCE** steps are affected by *any* change to their SCHEMA's properties
  (a create pattern adopts the full non-key property set, so adding or deleting a property
  always drifts it). Equivalent here to: the create op's bound property set no longer equals
  the SCHEMA's current non-key property set.
- **read/update-INSTANCE** steps are affected *only* when a WHERE filter references a property
  that was deleted from the SCHEMA (filters on still-present properties are unaffected, and
  added properties never affect read/update).

The same predicate drives both the pre-apply preview (against the *proposed* schema) and the
post-save re-check (against the *current* schema), so a sequence auto-unsuspends the moment its
INSTANCE step is re-saved to conform.

This module is a pure reverse index + flag manager; it persists suspension via
``catalog.set_sequences_suspended`` and reads sequence topology via
``execution.enumerate_sequence_operation_ids`` (which has no runtime gates, so it can introspect
a sequence even while it is suspended).
"""

from __future__ import annotations

import json
from typing import Any

from . import catalog, execution, graph, spaces


def _where_property_keys(where: Any) -> set[str]:
    """Every ``property_key`` referenced in a (possibly nested) WHERE group."""
    keys: set[str] = set()

    def walk(item: Any) -> None:
        if not isinstance(item, dict):
            return
        if isinstance(item.get("items"), list):  # WhereGroup
            for child in item["items"]:
                walk(child)
            return
        pk = item.get("property_key")
        if isinstance(pk, str) and pk.strip():
            keys.add(pk.strip())

    walk(where)
    return keys


def _is_parameter_label(label: str) -> bool:
    return label.startswith("$")


def _instance_targets(builder_config: Any) -> dict[str, dict[str, Any]]:
    """Map each literal INSTANCE-node attributive_label this op touches to its bound property
    keys (create adoption), WHERE-filter property keys (read/update filters), and whether the
    op actually *creates* a node of that label.

    Only INSTANCE *node* patterns are considered — a node's attributive_label is its SCHEMA's
    label. Relationship (POINTS_TO) patterns and parameterized labels are skipped.

    A node with ``node_source: "existing"`` is a matched endpoint (e.g. the PILLAR/VALUE ends
    of a connection-create): its properties/id_binding act as match filters, not property
    adoption, so they feed ``filter_keys`` and leave ``creates`` untouched. Any other node
    (``node_source: "new"`` or absent on legacy configs) counts as created.
    """
    targets: dict[str, dict[str, Any]] = {}
    if not isinstance(builder_config, dict):
        return targets
    query = builder_config.get("query")
    if not isinstance(query, dict):
        return targets
    for clause in query.get("match") or []:
        if not isinstance(clause, dict) or clause.get("label") != "INSTANCE":
            continue
        for pattern in clause.get("patterns") or []:
            if not isinstance(pattern, dict):
                continue
            for el in pattern.get("path") or []:
                if not isinstance(el, dict) or el.get("kind") != "node":
                    continue
                node = el.get("node")
                if not isinstance(node, dict):
                    continue
                al = str(node.get("attributive_label") or "").strip()
                if not al or _is_parameter_label(al):
                    continue
                rec = targets.setdefault(
                    al, {"bound_keys": set(), "filter_keys": set(), "creates": False}
                )
                existing = node.get("node_source") == "existing"
                prop_keys: set[str] = set()
                for prop in node.get("properties") or []:
                    if isinstance(prop, dict):
                        key = str(prop.get("key") or "").strip()
                        if key:
                            prop_keys.add(key)
                if existing:
                    rec["filter_keys"].update(prop_keys)
                    id_binding = node.get("id_binding")
                    if isinstance(id_binding, dict):
                        id_key = str(id_binding.get("key") or "").strip()
                        if id_key:
                            rec["filter_keys"].add(id_key)
                else:
                    rec["creates"] = True
                    rec["bound_keys"].update(prop_keys)
                rec["filter_keys"].update(_where_property_keys(node.get("where")))
    return targets


def _instance_operations() -> list[dict[str, Any]]:
    """Catalog index of every create/read/update-INSTANCE operation and the schema labels it
    touches (with bound + filter property keys per label), plus its name + current flag."""
    conn = catalog.catalog_conn()
    try:
        catalog.ensure_queries_policy_columns(conn)
        cur = conn.execute(
            "SELECT id, name, operation, builder_config, suspended FROM queries "
            "WHERE kind = 'operation' AND operation IN ('create', 'read', 'update')"
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    out: list[dict[str, Any]] = []
    for row in rows:
        op_id = (row[0] or "").strip()
        operation = (row[2] or "").strip()
        if not op_id:
            continue
        try:
            config = json.loads(row[3] or "{}")
        except (ValueError, TypeError):
            config = {}
        targets = _instance_targets(config)
        if targets:
            out.append(
                {
                    "id": op_id,
                    "name": str(row[1] or ""),
                    "operation": operation,
                    "targets": targets,
                    "suspended": int(row[4] or 0),
                }
            )
    return out


def _schema_key_sets(space_id: str, label: str) -> tuple[set[str], set[str]] | None:
    """(all property keys, non-key property keys) for a SCHEMA, or None if it can't resolve."""
    try:
        definition = graph.fetch_schema_definition(space_id, label)
    except Exception:
        return None
    schemata = definition.get("schemata") or []
    keys: set[str] = set()
    nonkey: set[str] = set()
    for entry in schemata:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key") or "").strip()
        if not key:
            continue
        keys.add(key)
        if not entry.get("is_key"):
            nonkey.add(key)
    return keys, nonkey


def schema_key_sets_from_schemata(schemata: list[Any]) -> tuple[set[str], set[str]]:
    """(all keys, non-key keys) from a raw ``schemata`` list (incoming proposed update)."""
    keys: set[str] = set()
    nonkey: set[str] = set()
    for entry in schemata or []:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key") or entry.get("name") or "").strip()
        if not key:
            continue
        keys.add(key)
        if not entry.get("is_key"):
            nonkey.add(key)
    return keys, nonkey


def _operation_drifts(
    target: dict[str, Any],
    operation: str,
    schema_keys: set[str],
    schema_nonkey_keys: set[str],
) -> bool:
    """Does this op's use of one schema label drift from that schema's property set?"""
    if operation == "create":
        # Adoption rule applies only when the op actually creates a node of this label —
        # matched-existing endpoints (connection creates) carry no adopted property set.
        if target.get("creates"):
            bound = target.get("bound_keys") or set()
            # Bound a property the schema no longer has, or missing a non-key schema property.
            if bound - schema_keys:
                return True
            if schema_nonkey_keys - bound:
                return True
        # Matched endpoints filtered on a now-deleted property break the create query too.
        return bool((target.get("filter_keys") or set()) - schema_keys)
    # read / update: affected only when a filter references a now-absent (deleted) property.
    return bool((target.get("filter_keys") or set()) - schema_keys)


def _op_drift_state(
    op: dict[str, Any],
    space_id: str,
    key_cache: dict[str, tuple[set[str], set[str]] | None],
    overrides: dict[str, tuple[set[str], set[str]]] | None = None,
) -> bool | None:
    """Does this operation drift from its SCHEMA pattern in ``space_id``?

    Returns True/False when at least one of the op's target labels resolves to a SCHEMA in this
    space, or ``None`` when none resolve (the op belongs to a different graph — leave it alone).
    """
    evaluable = False
    for label, target in op["targets"].items():
        if overrides and label in overrides:
            key_sets = overrides[label]
        else:
            if label not in key_cache:
                key_cache[label] = _schema_key_sets(space_id, label)
            key_sets = key_cache[label]
        if key_sets is None:
            continue
        evaluable = True
        schema_keys, schema_nonkey_keys = key_sets
        if _operation_drifts(target, op["operation"], schema_keys, schema_nonkey_keys):
            return True
    return False if evaluable else None


def _drifting_operation_ids(
    space_id: str,
    op_index: list[dict[str, Any]],
    key_cache: dict[str, tuple[set[str], set[str]] | None],
    overrides: dict[str, tuple[set[str], set[str]]] | None = None,
) -> set[str]:
    """Ids of operations that currently drift from their SCHEMA (evaluable in this space)."""
    drifting: set[str] = set()
    for op in op_index:
        if _op_drift_state(op, space_id, key_cache, overrides) is True:
            drifting.add(op["id"])
    return drifting


def affected_operation_ids(space_id: str) -> list[str]:
    """Ids of every create/read/update-INSTANCE operation that currently drifts from its SCHEMA
    in ``space_id`` (against the current, persisted schema state).

    Used to highlight the specific STEP nodes (whose backing operation drifted) inside the
    sequence visualizer, so an author can see exactly which steps need re-saving. This is a pure
    read with no runtime gates and does not mutate any suspension flag.
    """
    sid = (space_id or "").strip()
    if not sid:
        return []
    op_index = _instance_operations()
    key_cache: dict[str, tuple[set[str], set[str]] | None] = {}
    return sorted(_drifting_operation_ids(sid, op_index, key_cache))


def affected_step_labels(space_id: str) -> list[str]:
    """attributive_labels of STEP nodes whose backing operation (``payload.query_id``) drifts.

    The visualizer keys highlighting on a STEP's ``attributive_label`` because the read-query
    result graph (shown for single-step sequences) returns STEP nodes with that label but no
    ``query_id``. Resolving the affected steps on the backend — directly from the per-space STEP
    entities, independent of the step-flow connected component — lets the client paint the right
    node in either graph view.
    """
    sid = (space_id or "").strip()
    if not sid:
        return []
    affected_ops = set(affected_operation_ids(sid))
    if not affected_ops:
        return []
    labels: set[str] = set()
    conn = spaces.connect_sqlite_for_space(sid)
    try:
        node_label_col = spaces.entities_node_label_column(conn)
        cur = conn.execute(
            f"SELECT common_label, payload FROM entities WHERE {node_label_col} = 'STEP'"
        )
        rows = cur.fetchall()
    finally:
        conn.close()
    for row in rows:
        label = (row[0] or "").strip()
        if not label:
            continue
        payload = graph._parse_entity_payload(row[1])
        query_id = str((payload or {}).get("query_id") or "").strip()
        if query_id and query_id in affected_ops:
            labels.add(label)
    return sorted(labels)


def _sequence_referenced_operation_ids(space_id: str) -> dict[str, set[str]]:
    """Map each sequence id (in this space) to the operation ids its STEP chain references."""
    out: dict[str, set[str]] = {}
    for seq in _catalog_sequences():
        op_ids = execution.enumerate_sequence_operation_ids(space_id, seq["id"])
        if op_ids:
            out[seq["id"]] = op_ids
    return out


def _catalog_sequences() -> list[dict[str, Any]]:
    return [
        {
            "id": (q.get("id") or "").strip(),
            "name": str(q.get("name") or ""),
            "suspended": int(q.get("suspended") or 0),
        }
        for q in catalog.fetch_saved_queries()
        if q.get("kind") == "sequence" and (q.get("id") or "").strip()
    ]


def preview_affected(
    space_id: str, attributive_label: str, incoming_schemata: list[Any]
) -> dict[str, list[dict[str, str]]]:
    """What the proposed SCHEMA update *would* suspend — pure read, mutates nothing.

    Returns ``{"sequences": [...], "operations": [...]}`` where ``operations`` are *standalone*
    affected INSTANCE operations (not referenced by any sequence — those are covered by the
    sequence entries). The proposed schema is used for ``attributive_label``; other labels
    resolve against the current (unchanged) schema.
    """
    sid = (space_id or "").strip()
    label = (attributive_label or "").strip()
    if not sid or not label:
        return {"sequences": [], "operations": []}
    overrides = {label: schema_key_sets_from_schemata(incoming_schemata)}
    op_index = _instance_operations()
    key_cache: dict[str, tuple[set[str], set[str]] | None] = {}

    drifting = _drifting_operation_ids(sid, op_index, key_cache, overrides)
    seq_refs = _sequence_referenced_operation_ids(sid)
    referenced_ops: set[str] = set().union(*seq_refs.values()) if seq_refs else set()

    sequences = [
        {"id": seq["id"], "name": seq["name"]}
        for seq in _catalog_sequences()
        if seq["id"] in seq_refs and (seq_refs[seq["id"]] & drifting)
    ]
    operations = [
        {"id": op["id"], "name": op["name"]}
        for op in op_index
        if op["id"] in drifting and op["id"] not in referenced_ops
    ]
    return {"sequences": sequences, "operations": operations}


def refresh_suspensions(
    space_id: str,
    candidate_sequence_ids: list[str] | None = None,
    candidate_operation_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Recompute the suspended flag for sequences *and* standalone operations against the
    *current* schema state.

    - Passing ``None`` for a candidate set recomputes every row of that kind (used right after a
      SCHEMA update is persisted, to suspend the newly-broken ones).
    - A subset (e.g. the currently-suspended ids) is used after an operation re-save, where the
      only possible transition is un-suspension.

    Returns the rows whose flag flipped, keyed ``suspended`` / ``unsuspended``, each split into
    ``sequences`` / ``operations``.
    """
    sid = (space_id or "").strip()
    seq_candidates = (
        {s.strip() for s in candidate_sequence_ids if (s or "").strip()}
        if candidate_sequence_ids is not None
        else None
    )
    op_candidates = (
        {s.strip() for s in candidate_operation_ids if (s or "").strip()}
        if candidate_operation_ids is not None
        else None
    )
    op_index = _instance_operations()
    key_cache: dict[str, tuple[set[str], set[str]] | None] = {}

    # --- operations: a stale standalone op is the real broken artifact ---
    drifting = _drifting_operation_ids(sid, op_index, key_cache)
    seq_refs = _sequence_referenced_operation_ids(sid)
    referenced_ops: set[str] = set().union(*seq_refs.values()) if seq_refs else set()

    ops_suspend: list[dict[str, str]] = []
    ops_unsuspend: list[dict[str, str]] = []
    for op in op_index:
        if op_candidates is not None and op["id"] not in op_candidates:
            continue
        # Only operations evaluable in this space change state (None == different graph).
        state = _op_drift_state(op, sid, key_cache)
        if state is None:
            continue
        # Standalone-only: ops used by a sequence are covered by the sequence's suspension.
        standalone = op["id"] not in referenced_ops
        should_suspend = state and standalone
        if should_suspend and not op["suspended"]:
            ops_suspend.append({"id": op["id"], "name": op["name"]})
        elif not should_suspend and op["suspended"]:
            ops_unsuspend.append({"id": op["id"], "name": op["name"]})

    # --- sequences: suspended when they reference any drifting op ---
    seq_suspend: list[dict[str, str]] = []
    seq_unsuspend: list[dict[str, str]] = []
    for seq in _catalog_sequences():
        if seq_candidates is not None and seq["id"] not in seq_candidates:
            continue
        op_ids = seq_refs.get(seq["id"])
        # A sequence we can't introspect in this space (no steps here) is left untouched.
        if not op_ids:
            continue
        affected = bool(op_ids & drifting)
        if affected and not seq["suspended"]:
            seq_suspend.append({"id": seq["id"], "name": seq["name"]})
        elif not affected and seq["suspended"]:
            seq_unsuspend.append({"id": seq["id"], "name": seq["name"]})

    if seq_suspend:
        catalog.set_sequences_suspended([s["id"] for s in seq_suspend], True)
    if seq_unsuspend:
        catalog.set_sequences_suspended([s["id"] for s in seq_unsuspend], False)
    if ops_suspend:
        catalog.set_operations_suspended([o["id"] for o in ops_suspend], True)
    if ops_unsuspend:
        catalog.set_operations_suspended([o["id"] for o in ops_unsuspend], False)

    return {
        "suspended": {"sequences": seq_suspend, "operations": ops_suspend},
        "unsuspended": {"sequences": seq_unsuspend, "operations": ops_unsuspend},
    }


def flatten_suspension(change: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    """Collapse the {suspended,unsuspended}{sequences,operations} shape into flat lists that
    the client renders together (sequences first, then standalone operations)."""

    def merge(side: str) -> list[dict[str, str]]:
        block = change.get(side) or {}
        return [*(block.get("sequences") or []), *(block.get("operations") or [])]

    return {"suspended": merge("suspended"), "unsuspended": merge("unsuspended")}


def refresh_suspensions_after_operation_save(space_id: str) -> dict[str, Any]:
    """After an operation is re-saved, re-check the currently-suspended operations and sequences
    so any that now conform to their SCHEMA are released. A re-save can never newly-suspend (the
    schema did not change), so non-suspended rows are skipped for efficiency."""
    suspended_seq = list(catalog.fetch_suspended_query_ids("sequence"))
    suspended_ops = list(catalog.fetch_suspended_query_ids("operation"))
    if not suspended_seq and not suspended_ops:
        return {"suspended": {"sequences": [], "operations": []},
                "unsuspended": {"sequences": [], "operations": []}}
    return refresh_suspensions(
        space_id,
        candidate_sequence_ids=suspended_seq,
        candidate_operation_ids=suspended_ops,
    )
