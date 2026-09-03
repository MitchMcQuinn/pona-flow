"""
Diagnostic test for the SCHEMA delete cascade's pure helpers.

Covers the parts that don't need a live Neo4j/SQLite store:
- ``_labels_in_cypher_array`` precise (exact) attributive_label detection, ensuring it does
  NOT false-positive on labels embedded inside other labels or string literals.
- ``_build_warnings`` dependent-schema (confirm) messages.

Run: ``python tests/schema-delete-reference-scan.py`` from the repo root.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import schema_delete  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# --- _labels_in_cypher_array --------------------------------------------------

person_query = json.dumps(
    ["MATCH (n:INSTANCE {attributive_label: 'Person'}) RETURN n"]
)
labels = schema_delete._labels_in_cypher_array(person_query)
check("detects bound attributive_label", labels == {"Person"})

# Must NOT treat 'Person' as referenced when only the substring appears in another label.
personnel_query = json.dumps(
    ["MATCH (n:SCHEMA {attributive_label: 'Personnel'}) RETURN n"]
)
labels = schema_delete._labels_in_cypher_array(personnel_query)
check("no substring false-positive (Personnel != Person)", "Person" not in labels)
check("detects the actual label (Personnel)", labels == {"Personnel"})

# Double-quoted bindings and multiple statements.
multi = json.dumps(
    [
        'MATCH (a:SCHEMA {attributive_label: "Order"}) RETURN a',
        "MATCH (b:SCHEMA {attributive_label: 'Customer'}) RETURN b",
    ]
)
labels = schema_delete._labels_in_cypher_array(multi)
check("handles double quotes + multiple statements", labels == {"Order", "Customer"})

# Malformed / empty inputs degrade gracefully.
check("empty string -> empty set", schema_delete._labels_in_cypher_array("") == set())
check("None -> empty set", schema_delete._labels_in_cypher_array(None) == set())
check(
    "non-array JSON -> empty set",
    schema_delete._labels_in_cypher_array('{"not":"an array"}') == set(),
)
check(
    "invalid JSON -> empty set",
    schema_delete._labels_in_cypher_array("not json at all") == set(),
)

# --- _build_warnings ----------------------------------------------------------

resolution = {
    "attributive_label": "Person",
    "dependent_schemas": ["Order", "Invoice"],
}
warnings = schema_delete._build_warnings(resolution)
by_type = {w["type"]: w for w in warnings}

check("emits dependent_schemas warning", "dependent_schemas" in by_type)
check(
    "dependent_schemas warning requests confirmation",
    by_type.get("dependent_schemas", {}).get("requires_confirmation") is True,
)
check(
    "dependent_schemas warning lists schema labels",
    "Order" in by_type["dependent_schemas"]["message"]
    and "Invoice" in by_type["dependent_schemas"]["message"],
)

empty = schema_delete._build_warnings(
    {"attributive_label": "Person", "dependent_schemas": []}
)
check("no warnings when no dependents", empty == [])

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
