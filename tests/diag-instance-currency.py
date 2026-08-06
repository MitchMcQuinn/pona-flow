"""Diagnostic: validate the INSTANCE-currency Cypher predicates against real space data.

For a space + attributive_label (node OR relationship schema), prints the persisted schema's
required non-key keys, how many live INSTANCE nodes/relationships are out of sync (missing a
required prop), and which specific instances would be marked (is_current=false) or cleared. Pure
read — mutates nothing. The label may be a node schema (e.g. PERSON) or a relationship schema
(a POINTS_TO pattern, e.g. BOUGHT); the resolver now handles both.

Run:  .venv/bin/python tests/diag-instance-currency.py TEST_SPACE PERSON
      .venv/bin/python tests/diag-instance-currency.py TEST_SPACE BOUGHT
"""

from __future__ import annotations

import os
import sys

# Load .env the same way the dev server does (SQLITE_DATABASE_PATH, NEO4J_*).
try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv()
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "Engine"))

from server import graph, schema_currency  # noqa: E402


def _list_instance_nodes(space_id: str, attributive_label: str, required: list[str]) -> None:
    missing = schema_currency._missing_predicate("n", required) if required else "false"
    rows = graph.run_cypher_for_space(
        space_id,
        f"MATCH (n:INSTANCE {{attributive_label: $al}}) "
        f"RETURN n.id AS id, n.is_current AS is_current, ({missing}) AS out_of_sync "
        "ORDER BY id",
        {"al": attributive_label},
    )
    records = rows.get("records") or []
    if not records:
        print("    (no INSTANCE nodes for this label)")
        return
    for r in records:
        print(
            f"    node id={r.get('id')!r} is_current={r.get('is_current')!r} "
            f"out_of_sync={r.get('out_of_sync')!r}"
        )


def _list_instance_relationships(space_id: str, attributive_label: str, required: list[str]) -> None:
    missing = schema_currency._missing_predicate("r", required) if required else "false"
    rows = graph.run_cypher_for_space(
        space_id,
        f"MATCH {schema_currency._INSTANCE_REL_MATCH} "
        f"RETURN r.id AS id, r.is_current AS is_current, ({missing}) AS out_of_sync "
        "ORDER BY id",
        {"al": attributive_label},
    )
    records = rows.get("records") or []
    if not records:
        print("    (no INSTANCE relationships for this label)")
        return
    for r in records:
        print(
            f"    rel id={r.get('id')!r} is_current={r.get('is_current')!r} "
            f"out_of_sync={r.get('out_of_sync')!r}"
        )


def _list_schema_pattern_currency_pollution(space_id: str) -> None:
    rows = graph.run_cypher_for_space(
        space_id,
        "MATCH (:SCHEMA)-[r:POINTS_TO]->(:SCHEMA) WHERE r.is_current IS NOT NULL "
        "RETURN r.id AS id, r.attributive_label AS attributive_label, r.is_current AS is_current "
        "ORDER BY attributive_label, id",
        {},
    )
    records = rows.get("records") or []
    if not records:
        print("    (none — SCHEMA pattern edges are clean)")
        return
    for r in records:
        print(
            f"    SCHEMA pattern rel id={r.get('id')!r} "
            f"attributive_label={r.get('attributive_label')!r} "
            f"is_current={r.get('is_current')!r}"
        )


def main() -> None:
    space_id = sys.argv[1] if len(sys.argv) > 1 else "TEST_SPACE"
    attributive_label = sys.argv[2] if len(sys.argv) > 2 else "PERSON"
    print(f"space_id = {space_id}  attributive_label = {attributive_label}\n")

    # Resolves either a SCHEMA node or a relationship-SCHEMA pattern via the new fallback.
    is_relationship = bool(graph._resolve_schema_relationship_id(space_id, attributive_label))
    print(f"schema kind = {'relationship' if is_relationship else 'node'}")

    required = schema_currency._current_required_nonkey_keys(space_id, attributive_label)
    print(f"persisted required non-key keys = {required}")

    # Count using the persisted schema (proxy for an incoming update that keeps them required).
    try:
        definition = graph.fetch_schema_definition(space_id, attributive_label)
        schemata = definition.get("schemata") or []
    except Exception as e:
        schemata = []
        print(f"(could not load schema definition: {e})")

    count = schema_currency.count_out_of_sync_instances(space_id, attributive_label, schemata)
    print(f"count_out_of_sync_instances() = {count}")

    print("\nINSTANCE nodes (id / is_current / would-be-out-of-sync):")
    _list_instance_nodes(space_id, attributive_label, required)

    print("\nINSTANCE relationships (id / is_current / would-be-out-of-sync):")
    _list_instance_relationships(space_id, attributive_label, required)

    print("\nSCHEMA pattern POINTS_TO edges with mistaken is_current (should be empty):")
    _list_schema_pattern_currency_pollution(space_id)

    print(
        "\nNote: this is a read-only probe. apply_instance_schema_change() and "
        "reconcile_instance_currency() would mutate is_current; not run here."
    )


if __name__ == "__main__":
    main()
