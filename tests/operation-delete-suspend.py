"""
Diagnostic test for operation delete: one-step sequences are removed, multi-step
sequences that MATCH the wrap STEP are partitioned for suspension (not deletion).

Covers ``partition_sequences_for_step_label`` without a live Neo4j/SQLite store.

Run: ``python tests/operation-delete-suspend.py`` from the repo root.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import operation_delete  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


one_step_cypher = json.dumps(
    ["MATCH (step:STEP { attributive_label: 'READ_PERSON' }) RETURN *"]
)
multi_step_cypher = json.dumps(
    [
        "MATCH (n:STEP { attributive_label: 'READ_PERSON' })-[*]->(d) RETURN n, d"
    ]
)
unrelated_cypher = json.dumps(
    ["MATCH (step:STEP { attributive_label: 'OTHER' }) RETURN *"]
)

rows = [
    {
        "id": "op-1",
        "name": "READ_PERSON",
        "kind": "operation",
        "cypher": json.dumps(["MATCH (n:INSTANCE {attributive_label: 'PERSON'}) RETURN n"]),
    },
    {
        "id": "seq-one",
        "name": "READ_PERSON",
        "kind": "sequence",
        "cypher": one_step_cypher,
    },
    {
        "id": "seq-multi",
        "name": "PERSON_INSTANCE_FLOW",
        "kind": "sequence",
        "cypher": multi_step_cypher,
    },
    {
        "id": "seq-other",
        "name": "OTHER_FLOW",
        "kind": "sequence",
        "cypher": unrelated_cypher,
    },
]

parts = operation_delete.partition_sequences_for_step_label("READ_PERSON", rows)
one_ids = {s["id"] for s in parts["one_step"]}
multi_ids = {s["id"] for s in parts["multi_step"]}

check("one-step wrap is listed for deletion", one_ids == {"seq-one"})
check("multi-step MATCH is listed for suspension", multi_ids == {"seq-multi"})
check("unrelated sequences are ignored", "seq-other" not in one_ids | multi_ids)
check("the operation catalog row is not treated as a sequence", "op-1" not in one_ids | multi_ids)

empty = operation_delete.partition_sequences_for_step_label("", rows)
check("blank label partitions nothing", empty == {"one_step": [], "multi_step": []})

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
