"""
Diagnostic test for spaces.expand_sequence_label_closure.

A space that inherits a sequence must inherit the sequence's whole STEP workflow plus the
SCHEMA/INSTANCE labels those STEPs' queries reference — otherwise the SCHEMA-delete cascade
can't see that the space uses the schema. Graph/catalog access is monkeypatched so the test
runs without Neo4j or a catalog DB; the connected-component walk and label harvesting run for
real.

Run: `python tests/space-label-closure.py` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import catalog, graph, spaces  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")
    if not condition:
        failures.append(name)


# Synthetic shared STEP workflow: Seq1 -> Step2 via Edge1. Each STEP runs a query that
# references a SCHEMA (and Step2's query also touches an INSTANCE).
FLOW = {
    "nodes": [
        {"id": "n1", "attributive_label": "Seq1", "payload": {"query_id": "q1"}},
        {"id": "n2", "attributive_label": "Step2", "payload": {"query_id": "q2"}},
        # An unrelated STEP that must NOT be pulled into the closure.
        {"id": "n9", "attributive_label": "Lonely", "payload": {"query_id": "q9"}},
    ],
    "relationships": [
        {"id": "r1", "attributive_label": "Edge1", "source": "n1", "target": "n2"},
    ],
}

QUERIES = {
    "q1": {"cypher": ["MATCH (s:SCHEMA {attributive_label: 'Person'}) RETURN s"]},
    "q2": {
        "cypher": [
            "MATCH (n:INSTANCE {attributive_label: 'Place'}) "
            "MATCH (s:SCHEMA {attributive_label: 'Place'}) RETURN n"
        ]
    },
    "q9": {"cypher": ["MATCH (s:SCHEMA {attributive_label: 'ShouldNotAppear'}) RETURN s"]},
}

spaces._reference_public_space_id = lambda conn, exclude_id=None: "REF"  # type: ignore
graph._build_step_flow_graph = lambda space_id: FLOW  # type: ignore
catalog.fetch_query_package = lambda qid: QUERIES.get(qid)  # type: ignore

closure = set(spaces.expand_sequence_label_closure(None, ["Seq1"]))

check("keeps the selected sequence label", "Seq1" in closure)
check("inherits downstream STEP label", "Step2" in closure)
check("inherits relationship pattern label", "Edge1" in closure)
check("inherits SCHEMA label referenced by seed STEP query", "Person" in closure)
check("inherits SCHEMA label referenced by downstream STEP query", "Place" in closure)
check("does not pull unrelated STEP into closure", "Lonely" not in closure)
check("does not pull unrelated SCHEMA into closure", "ShouldNotAppear" not in closure)

# Empty selection resolves to nothing.
check("empty selection -> empty closure", spaces.expand_sequence_label_closure(None, []) == [])

# No reference space (no public spaces yet): selection is returned unchanged.
spaces._reference_public_space_id = lambda conn, exclude_id=None: None  # type: ignore
check(
    "no reference space -> selection unchanged",
    spaces.expand_sequence_label_closure(None, ["Seq1"]) == ["Seq1"],
)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
