"""
SCHEMA update under the add/delete-with-limited-edit model.

A schema update may **add** new properties, **delete** existing ones, and edit a retained
property's *non-structural* attributes (``is_label``, ``is_required``, ``is_indexed``,
``default_value``). A retained property's **structural identity** stays frozen — its name (used
as stable identity), ``value_type``, ``format``, choice ``options``/bounds, and ``is_key`` — since
changing those would invalidate stored INSTANCE values. Each SCHEMA must keep at least one
``is_label`` property.

This module:

- :func:`apply_schema_update` — validate an incoming ``schemata`` against the stored one
  (add/delete-only, retained properties byte-identical), then rewrite the SCHEMA's
  ``entities.payload``.
- :func:`find_affected_create_instance_operations` — the reverse index from a SCHEMA to the
  create-INSTANCE operations in the ``queries`` catalog that target it, so the client can
  reconcile their frozen snapshots after the schema changes.

The authoritative compile/recompile of an operation's cypher lives in the TypeScript composer
(browser); this module only validates, persists, and reports the affected operations + diff.
"""

from __future__ import annotations

import json
import re
from typing import Any

from . import catalog, cypher_utils, graph, spaces

# Shared attributive_label scanning (see cypher_utils); aliased for existing call sites.
_ATTR_LABEL_RE = cypher_utils.ATTR_LABEL_RE
_labels_in_cypher_array = cypher_utils.labels_in_cypher_array


def _labels_in_builder_config(raw_config: str | None) -> set[str]:
    """Walk a stored builder_config snapshot and collect every node/rel attributive_label."""
    if not raw_config:
        return set()
    try:
        config = json.loads(raw_config)
    except (ValueError, TypeError):
        return set()
    labels: set[str] = set()

    def _walk(value: Any) -> None:
        if isinstance(value, dict):
            al = value.get("attributive_label")
            if isinstance(al, str) and al.strip():
                labels.add(al.strip())
            for child in value.values():
                _walk(child)
        elif isinstance(value, list):
            for child in value:
                _walk(child)

    _walk(config)
    return labels


def _canonical(constraint: dict[str, Any]) -> dict[str, Any]:
    """Comparable form of a property constraint (every attribute, name excluded)."""
    value_type = str(constraint.get("value_type") or "string")
    out: dict[str, Any] = {
        "value_type": value_type,
        "is_required": bool(constraint.get("is_required")),
        "is_key": bool(constraint.get("is_key")),
        "is_label": bool(constraint.get("is_label")),
        "is_indexed": bool(constraint.get("is_indexed")),
        "is_embedded": bool(constraint.get("is_embedded")),
    }
    if value_type == "string" and constraint.get("format"):
        out["format"] = str(constraint.get("format"))
    if value_type in ("radio", "checkbox"):
        out["options"] = graph._normalize_choice_options(constraint.get("options"))
        if value_type == "checkbox":
            min_choices = graph._normalize_choice_count(constraint.get("min_choices"))
            if min_choices is not None:
                out["min_choices"] = min_choices
            max_choices = graph._normalize_choice_count(constraint.get("max_choices"))
            if max_choices is not None:
                out["max_choices"] = max_choices
    default_value = constraint.get("default_value")
    if default_value is not None and str(default_value).strip() != "":
        out["default_value"] = str(default_value)
    return out


def _structural_canonical(constraint: dict[str, Any]) -> dict[str, Any]:
    """Locked (immutable) attributes of a retained property: type, format, choice shape, key.

    ``is_required``, ``is_label``, ``is_indexed`` and ``default_value`` are intentionally excluded
    — those may be edited on an existing property. Only the structural identity (which would
    invalidate stored INSTANCE values if changed) stays frozen.
    """
    value_type = str(constraint.get("value_type") or "string")
    out: dict[str, Any] = {
        "value_type": value_type,
        "is_key": bool(constraint.get("is_key")),
    }
    if value_type == "string" and constraint.get("format"):
        out["format"] = str(constraint.get("format"))
    if value_type in ("radio", "checkbox"):
        out["options"] = graph._normalize_choice_options(constraint.get("options"))
        if value_type == "checkbox":
            min_choices = graph._normalize_choice_count(constraint.get("min_choices"))
            if min_choices is not None:
                out["min_choices"] = min_choices
            max_choices = graph._normalize_choice_count(constraint.get("max_choices"))
            if max_choices is not None:
                out["max_choices"] = max_choices
    return out


def _sanitize_index_token(value: Any) -> str:
    """Mirror the composer's sanitizeIndexToken so eager DROP matches lazily-created names."""
    token = re.sub(r"[^A-Za-z0-9_]+", "_", str(value or ""))
    token = token.strip("_")
    return token[:48]


_escape_property_key = cypher_utils.escape_identifier


def _index_name(attributive_label: str, key: str, is_relationship: bool) -> str:
    """Deterministic index name (relationship indexes use a distinct prefix from node ones)."""
    al_tok = _sanitize_index_token(attributive_label)
    key_tok = _sanitize_index_token(key)
    prefix = "instance_rel" if is_relationship else "instance"
    return f"{prefix}_{al_tok}_{key_tok}"[:60]


def _apply_index_changes(
    space_id: str,
    attributive_label: str,
    stored_by_key: dict[str, dict[str, Any]],
    incoming_by_key: dict[str, dict[str, Any]],
    is_relationship: bool,
) -> dict[str, int]:
    """Eagerly create/drop Neo4j indexes to match the new is_indexed state of each property.

    Creates an index for any property newly indexed (added with is_indexed, or a retained property
    toggled on) and drops it for any property no longer indexed (toggled off or deleted). Index DDL
    runs through the runtime execution layer (the same path that lazily creates instance indexes).
    """
    al = (attributive_label or "").strip()
    created = 0
    dropped = 0
    if not al:
        return {"created": 0, "dropped": 0}

    def _indexed(entry: dict[str, Any] | None) -> bool:
        return bool(entry and entry.get("is_indexed"))

    if is_relationship:
        target = "()-[r:POINTS_TO]-()"
        var = "r"
    else:
        target = "(n:INSTANCE)"
        var = "n"

    all_keys = set(stored_by_key) | set(incoming_by_key)
    for key in all_keys:
        was = _indexed(stored_by_key.get(key))
        now = _indexed(incoming_by_key.get(key))
        if now and not was:
            name = _index_name(al, key, is_relationship)
            ref = f"{var}.`{_escape_property_key(key)}`"
            try:
                graph.run_cypher_for_space(
                    space_id,
                    f"CREATE INDEX {name} IF NOT EXISTS FOR {target} ON ({ref})",
                    {},
                )
                created += 1
            except Exception:
                pass
        elif was and not now:
            name = _index_name(al, key, is_relationship)
            try:
                graph.run_cypher_for_space(space_id, f"DROP INDEX {name} IF EXISTS", {})
                dropped += 1
            except Exception:
                pass
    return {"created": created, "dropped": dropped}


def _to_property_schema(constraint: dict[str, Any]) -> dict[str, Any]:
    """Inverse of graph._normalize_property_schema: key-based constraint -> stored entry."""
    name = str(constraint.get("key") or constraint.get("name") or "").strip()
    value_type = str(constraint.get("value_type") or "string")
    ps: dict[str, Any] = {
        "name": name,
        "value_type": value_type,
        "is_required": bool(constraint.get("is_required")),
        "is_key": bool(constraint.get("is_key")),
        "is_label": bool(constraint.get("is_label")),
        "is_indexed": bool(constraint.get("is_indexed")),
    }
    # Written only when on, matching the composer's create payload.
    if constraint.get("is_embedded"):
        ps["is_embedded"] = True
    if value_type == "string" and constraint.get("format"):
        ps["format"] = str(constraint.get("format"))
    if value_type in ("radio", "checkbox"):
        ps["options"] = graph._normalize_choice_options(constraint.get("options"))
        if value_type == "checkbox":
            min_choices = graph._normalize_choice_count(constraint.get("min_choices"))
            if min_choices is not None:
                ps["min_choices"] = min_choices
            max_choices = graph._normalize_choice_count(constraint.get("max_choices"))
            if max_choices is not None:
                ps["max_choices"] = max_choices
    default_value = constraint.get("default_value")
    if default_value is not None and str(default_value).strip() != "":
        ps["default_value"] = str(default_value)
    return ps


def _write_schema_payload(
    space_id: str,
    schema_id: str,
    constraints: list[dict[str, Any]],
    *,
    relationship_label: str | None = None,
    is_vectorized: bool = False,
) -> None:
    """Rewrite the SCHEMA entity's payload schemata (per-space SQLite).

    Node schemas are keyed by id. Relationship schemas are reusable types — every edge
    sharing the attributive_label carries an identical payload copy — so when
    ``relationship_label`` is given the rewrite targets all rows with that common_label,
    keeping the copies in sync.

    ``is_vectorized`` is a SCHEMA-level flag stored beside ``schemata``; the caller resolves
    it (from the request, or from what was stored) so a property edit never silently turns
    vector search off.
    """
    schemata = [{"property_schema": _to_property_schema(c)} for c in constraints]
    body: dict[str, Any] = {"schemata": schemata}
    if is_vectorized:
        body["is_vectorized"] = True
    payload = json.dumps(body)
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        node_label_col = spaces.entities_node_label_column(conn)
        if relationship_label:
            cur = conn.execute(
                f"UPDATE entities SET payload = ?, modified_date = datetime('now') "
                f"WHERE {node_label_col} = 'SCHEMA' AND common_label = ?",
                (payload, relationship_label),
            )
            if cur.rowcount == 0:
                raise ValueError(
                    f"No SCHEMA entity rows for relationship label {relationship_label!r}"
                )
        else:
            cur = conn.execute(
                f"UPDATE entities SET payload = ?, modified_date = datetime('now') "
                f"WHERE id = ? AND {node_label_col} = 'SCHEMA'",
                (payload, schema_id),
            )
            if cur.rowcount == 0:
                raise ValueError(f"No SCHEMA entity row for id {schema_id!r}")
        conn.commit()
    finally:
        conn.close()


def validate_schema_update(
    space_id: str,
    schema_id: str,
    attributive_label: str,
    incoming: list[Any],
) -> dict[str, Any]:
    """
    Validate an add/delete-only SCHEMA update *without persisting it*.

    Raises ValueError on any disallowed change (modified retained property, or a new/deleted
    key property). Returns the parsed diff (``added`` / ``deleted`` / ``incoming_ordered``)
    so callers can preview its blast radius before committing.
    """
    sid = (space_id or "").strip()
    sch_id = (schema_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    if not sch_id:
        raise ValueError("schema_id is required")

    stored_payload = graph._fetch_entity_payload(sid, sch_id, "SCHEMA")
    if stored_payload is None:
        raise ValueError(f"No SCHEMA entity row for id {sch_id!r}")
    stored = graph._schemata_from_payload(stored_payload)
    stored_by_key = {s["key"]: s for s in stored}

    incoming_ordered: list[dict[str, Any]] = []
    incoming_by_key: dict[str, dict[str, Any]] = {}
    for entry in incoming:
        if not isinstance(entry, dict):
            raise ValueError("each schema property must be an object")
        key = str(entry.get("key") or entry.get("name") or "").strip()
        if not key:
            raise ValueError("each schema property requires a key")
        if key in incoming_by_key:
            raise ValueError(f'duplicate schema property "{key}"')
        if key.lower() in graph.RESERVED_EMBEDDING_PROPERTY_KEYS:
            raise ValueError(
                f'property "{key}" is a reserved system property and cannot be defined '
                f"on a SCHEMA"
            )
        incoming_by_key[key] = entry
        incoming_ordered.append(entry)

    deleted = [k for k in stored_by_key if k not in incoming_by_key]
    added = [incoming_by_key[k] for k in incoming_by_key if k not in stored_by_key]
    retained = [k for k in incoming_by_key if k in stored_by_key]

    for key in retained:
        if _structural_canonical(incoming_by_key[key]) != _structural_canonical(stored_by_key[key]):
            raise ValueError(
                f'property "{key}" type cannot be changed; a property\'s value type and format '
                f"are locked once created (its label, required, indexed, and default may change)"
            )

    for key in deleted:
        if stored_by_key[key].get("is_key"):
            raise ValueError("the key property cannot be deleted")

    for entry in added:
        if bool(entry.get("is_key")):
            raise ValueError("a new key property cannot be added")

    # The label-property requirement applies to node schemas only; relationship-SCHEMA patterns
    # (POINTS_TO edges) are identified by their endpoints, not a display label, so they are exempt.
    al = (attributive_label or "").strip()
    is_relationship = bool(graph._resolve_schema_relationship_id(sid, al)) if al else False
    if not is_relationship and not any(bool(e.get("is_label")) for e in incoming_ordered):
        raise ValueError("a SCHEMA node must have at least one label property (is_label)")

    return {
        "schema_id": sch_id,
        "incoming_ordered": incoming_ordered,
        "added": added,
        "deleted": deleted,
    }


def apply_schema_update(
    space_id: str,
    schema_id: str,
    attributive_label: str,
    incoming: list[Any],
    is_vectorized: bool | None = None,
) -> dict[str, Any]:
    """
    Validate and persist a SCHEMA update, eagerly reconciling Neo4j indexes.

    Raises ValueError on any disallowed change (changed structural identity of a retained
    property, a new/deleted key property, or removing the last label property). Creates/drops
    instance indexes to match each property's is_indexed flag, and returns the diff so callers
    can drive the affected-sequence suspension cascade.

    ``is_vectorized`` (SCHEMA-level, vector search) is left as stored when omitted, so a
    client that predates the flag cannot clear it.
    """
    sid = (space_id or "").strip()
    al = (attributive_label or "").strip()
    validated = validate_schema_update(space_id, schema_id, attributive_label, incoming)
    sch_id = validated["schema_id"]

    # Capture the prior (stored) state before the rewrite so we can diff is_indexed for eager
    # index DDL. A relationship-SCHEMA pattern has no SCHEMA node, so detect it to pick the
    # node vs relationship index form.
    stored_payload = graph._fetch_entity_payload(sid, sch_id, "SCHEMA")
    stored_before = graph._schemata_from_payload(stored_payload)
    was_vectorized = graph._schema_flags_from_payload(stored_payload)["is_vectorized"]
    vectorized = _resolve_vectorized(was_vectorized, is_vectorized)
    stored_by_key = {s["key"]: s for s in stored_before}
    incoming_by_key = {
        str(e.get("key") or e.get("name") or "").strip(): e
        for e in validated["incoming_ordered"]
    }
    is_relationship = bool(graph._resolve_schema_relationship_id(sid, al))

    _write_schema_payload(
        sid,
        sch_id,
        validated["incoming_ordered"],
        relationship_label=al if is_relationship else None,
        is_vectorized=vectorized,
    )

    indexes = _apply_index_changes(sid, al, stored_by_key, incoming_by_key, is_relationship)

    new_payload = graph._fetch_entity_payload(sid, sch_id, "SCHEMA")
    added_constraints = [
        {"key": str(e.get("key") or e.get("name") or "").strip(), **_canonical(e)}
        for e in validated["added"]
    ]
    return {
        "schema_id": sch_id,
        "attributive_label": al,
        "added": added_constraints,
        "deleted": validated["deleted"],
        "schemata": graph._schemata_from_payload(new_payload),
        "indexes": indexes,
        "is_vectorized": vectorized,
        "is_relationship": is_relationship,
        "embedding_include_changed": _embedding_include_changed(
            stored_by_key, incoming_by_key, was_vectorized, vectorized
        ),
    }


def _resolve_vectorized(stored: bool, incoming: bool | None) -> bool:
    """Resolve the SCHEMA-level ``is_vectorized`` flag for a rewrite.

    An omitted flag means "leave as stored", so a client that predates it — or a request
    that only edits properties — cannot silently switch vector search off.
    """
    return bool(stored) if incoming is None else bool(incoming)


def _embedding_include_changed(
    stored_by_key: dict[str, dict[str, Any]],
    incoming_by_key: dict[str, dict[str, Any]],
    was_vectorized: bool,
    is_vectorized: bool,
) -> bool:
    """Whether this update changes what a record's embedding text would contain.

    Stored vectors describe the old text, so a caller has to mark records stale when this
    is true (see schema_workflow.apply_schema_update).
    """
    if was_vectorized != is_vectorized:
        return True
    if not is_vectorized:
        return False
    for key in set(stored_by_key) | set(incoming_by_key):
        was = bool((stored_by_key.get(key) or {}).get("is_embedded"))
        now = bool((incoming_by_key.get(key) or {}).get("is_embedded"))
        if was != now:
            return True
    return False


def find_affected_create_instance_operations(
    attributive_label: str,
) -> list[dict[str, Any]]:
    """
    Reverse index: create-INSTANCE operations in the catalog that target *attributive_label*.

    Scans both the composed ``cypher`` array and the ``builder_config`` snapshot so an operation
    is found whether or not its cypher still binds the label. Returns each row's id, name,
    runtime flag, group, and full builder_config for client-side reconciliation.
    """
    al = (attributive_label or "").strip()
    if not al:
        return []
    conn = catalog.catalog_conn()
    try:
        catalog.ensure_queries_policy_columns(conn)
        cur = conn.execute(
            "SELECT id, name, operation, runtime_enabled, group_title, cypher, builder_config "
            "FROM queries WHERE kind = 'operation' AND operation = 'create'"
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    out: list[dict[str, Any]] = []
    for row in rows:
        cypher_raw = row[5]
        builder_config_raw = row[6]
        if al not in _labels_in_cypher_array(cypher_raw) and al not in _labels_in_builder_config(
            builder_config_raw
        ):
            continue
        try:
            builder_config = json.loads(builder_config_raw or "{}")
        except (ValueError, TypeError):
            builder_config = {}
        out.append(
            {
                "id": (row[0] or "").strip(),
                "name": str(row[1] or ""),
                "operation": (row[2] or "").strip(),
                "runtime_enabled": int(row[3] if row[3] is not None else 0),
                "group_title": row[4],
                "builder_config": builder_config,
            }
        )
    return out
