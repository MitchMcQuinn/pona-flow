"""Diagnostic: print affected (drifting) INSTANCE operation ids for a space, plus each
sequence's referenced operation ids, so we can see whether the visualizer should highlight.

Run:  .venv/bin/python tests/diag-affected-ids.py TEST_SPACE
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

from server import catalog, execution, schema_suspension  # noqa: E402


def main() -> None:
    space_id = sys.argv[1] if len(sys.argv) > 1 else "TEST_SPACE"
    print(f"space_id = {space_id}\n")

    op_index = schema_suspension._instance_operations()
    print(f"INSTANCE operations in catalog: {len(op_index)}")
    for op in op_index:
        print(
            f"  - id={op['id']} name={op['name']!r} operation={op['operation']} "
            f"suspended={op['suspended']} targets={ {k: {kk: sorted(vv) if isinstance(vv, set) else vv for kk, vv in v.items()} for k, v in op['targets'].items()} }"
        )

    affected = schema_suspension.affected_operation_ids(space_id)
    print(f"\naffected_operation_ids({space_id}) = {affected}")
    print(f"affected_step_labels({space_id}) = {schema_suspension.affected_step_labels(space_id)}")

    print("\nSequences and their referenced operation ids:")
    for seq in schema_suspension._catalog_sequences():
        op_ids = execution.enumerate_sequence_operation_ids(space_id, seq["id"])
        drift = sorted(set(op_ids) & set(affected))
        print(
            f"  - seq id={seq['id']} name={seq['name']!r} suspended={seq['suspended']} "
            f"refs={sorted(op_ids)} drifting_refs={drift}"
        )

    from server import graph  # noqa: E402

    print("\n--- step-flow graph (design graph) per sequence ---")
    for seq in schema_suspension._catalog_sequences():
        sg = graph.fetch_step_flow_graph(space_id, seq["id"])
        print(f"  seq {seq['name']!r}: {len(sg.get('nodes') or [])} nodes")
        for n in sg.get("nodes") or []:
            print(
                f"    node id={n.get('id')} attributive_label={n.get('attributive_label')!r} "
                f"payload.query_id={(n.get('payload') or {}).get('query_id')!r}"
            )

    print("\n--- read-query result graph per sequence ---")
    for seq in schema_suspension._catalog_sequences():
        pkg = catalog.fetch_query_package(seq["id"])
        cypher = [s for s in (pkg.get("cypher") or []) if isinstance(s, str) and s.strip()]
        print(f"  seq {seq['name']!r}: cypher={cypher}")
        if not cypher:
            continue
        try:
            from server import execution as _ex

            out = graph.run_cypher_for_space(space_id, cypher[0], {})
            g = out.get("graph") or {}
            for n in g.get("nodes") or []:
                print(
                    f"    result node element_id={n.get('element_id')} labels={n.get('labels')} "
                    f"props.attributive_label={(n.get('properties') or {}).get('attributive_label')!r} "
                    f"props.query_id={(n.get('properties') or {}).get('query_id')!r}"
                )
        except Exception as e:
            print(f"    (run failed: {e})")


if __name__ == "__main__":
    main()
