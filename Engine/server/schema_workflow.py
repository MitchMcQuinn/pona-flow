"""
SCHEMA-update orchestration — apply/preview plus the follow-on side effects.

A SCHEMA update is not just the pattern write (``schema_update``): sequences and
standalone operations that no longer match must be suspended (``schema_suspension``)
and live INSTANCE data must be reconciled (``schema_currency``). That orchestration
used to live inline in the HTTP routes; it lives here so the routes stay thin and the
workflow is callable from any entrypoint.

Side effects are deliberately best-effort: a suspension or currency failure is logged
and reported as empty rather than failing an already-persisted schema change.
"""

from __future__ import annotations

import sys
from typing import Any

from . import embeddings, schema_currency, schema_suspension, schema_update


def apply_schema_update(
    space_id: str,
    schema_id: str,
    attributive_label: str,
    schemata: list[Any],
    is_vectorized: bool | None = None,
) -> dict[str, Any]:
    """Persist a SCHEMA update, then refresh suspensions and instance currency.

    Raises whatever :func:`schema_update.apply_schema_update` raises (the write is the
    one step that must not fail silently); the follow-on side effects never raise.
    """
    result = schema_update.apply_schema_update(
        space_id, schema_id, attributive_label, schemata, is_vectorized
    )
    # Suspend any sequence (and standalone INSTANCE operation) that no longer matches the new
    # SCHEMA pattern, and release any that now conform. Recomputed against the persisted schema.
    try:
        suspension = schema_suspension.flatten_suspension(
            schema_suspension.refresh_suspensions(space_id)
        )
    except Exception as e:
        sys.stderr.write(f"schema-update suspension error: {e}\n")
        suspension = {"suspended": [], "unsuspended": []}
    # Reconcile live INSTANCE data: auto-remove deleted properties from every instance, and
    # stamp is_current=false on instances missing a (now-)required property. Then clear stale
    # markers from instances that now conform (e.g. a requirement was relaxed or deleted).
    instance_label = result.get("attributive_label") or attributive_label
    try:
        instances = schema_currency.apply_instance_schema_change(
            space_id, instance_label, result.get("deleted") or [],
        )
    except Exception as e:
        sys.stderr.write(f"schema-update instance currency error: {e}\n")
        instances = {"deleted_from": 0, "marked": 0}
    try:
        cleared = schema_currency.reconcile_instance_currency(space_id, instance_label)
        instances = {**instances, "cleared": cleared.get("cleared", 0)}
    except Exception as e:
        sys.stderr.write(f"schema-update instance currency reconcile error: {e}\n")
    # A change to the embedded include list (or to is_vectorized itself) means every stored
    # vector for this label describes text the schema no longer produces.
    embeddings_marked: dict[str, int] | None = None
    if result.get("embedding_include_changed"):
        try:
            embeddings_marked = embeddings.mark_label_stale(space_id, instance_label)
        except Exception as e:
            sys.stderr.write(f"schema-update embedding staleness error: {e}\n")
    return {
        "space_id": space_id,
        **result,
        "suspension": suspension,
        "instances": instances,
        **({"embeddings": embeddings_marked} if embeddings_marked else {}),
    }


def preview_schema_update(
    space_id: str, schema_id: str, attributive_label: str, schemata: list[Any]
) -> dict[str, Any]:
    """Dry run for a SCHEMA update: validate the (add/delete-only) diff and report which
    sequences *would* be suspended, without persisting anything.

    Raises whatever :func:`schema_update.validate_schema_update` raises; the affected /
    instance-count lookups are best-effort.
    """
    validated = schema_update.validate_schema_update(
        space_id, schema_id, attributive_label, schemata
    )
    try:
        affected = schema_suspension.preview_affected(
            space_id, attributive_label, schemata
        )
    except Exception as e:
        sys.stderr.write(f"schema-update-preview suspension error: {e}\n")
        affected = {"sequences": [], "operations": []}
    try:
        out_of_sync_instance_count = schema_currency.count_out_of_sync_instances(
            space_id, attributive_label, schemata
        )
    except Exception as e:
        sys.stderr.write(f"schema-update-preview instance count error: {e}\n")
        out_of_sync_instance_count = 0
    return {
        "space_id": space_id,
        "attributive_label": attributive_label,
        "added": [
            str(e.get("key") or e.get("name") or "").strip()
            for e in validated.get("added") or []
        ],
        "deleted": validated.get("deleted") or [],
        "affected_sequences": affected.get("sequences") or [],
        "affected_operations": affected.get("operations") or [],
        "out_of_sync_instance_count": out_of_sync_instance_count,
    }


def refresh_after_operation_save(space_id: str) -> dict[str, Any] | None:
    """Release suspended sequences/operations that conform again after an operation re-save.

    Returns the flattened change when anything was (un)suspended, else None. Best-effort:
    a failure is logged and reported as no change.
    """
    try:
        released = schema_suspension.flatten_suspension(
            schema_suspension.refresh_suspensions_after_operation_save(space_id)
        )
    except Exception as e:
        sys.stderr.write(f"operation-save suspension refresh error: {e}\n")
        return None
    if released["suspended"] or released["unsuspended"]:
        return released
    return None
