"""
Diagnostic test for attributive_label reference scanning (Engine/server/cypher_utils.py).

``ATTR_LABEL_RE`` decides which SCHEMAs an operation references. That answer drives the
SCHEMA delete blast radius, drift suspension, and template export. Vector-search Cypher filters with ``attributive_label = 'X'`` rather
than the map form ``{ attributive_label: 'X' }``, so the scan matches both.

This guards the widened pattern against the false positives the original was written to
avoid (substring labels, other property keys ending in the same name).

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/cypher-attributive-label-scan.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import cypher_utils  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def labels(*statements: str) -> set[str]:
    return cypher_utils.labels_in_cypher_array(json.dumps(list(statements)))


# --- the original map form still works --------------------------------------
check(
    "map form detected",
    labels("MATCH (n:INSTANCE {attributive_label: 'Person'}) RETURN n") == {"Person"},
)
check(
    "double-quoted map form detected",
    labels('MATCH (n:SCHEMA {attributive_label: "Order"}) RETURN n') == {"Order"},
)
check(
    "no substring false-positive (Personnel != Person)",
    "Person" not in labels("MATCH (n:SCHEMA {attributive_label: 'Personnel'}) RETURN n"),
)

# --- the equality form used by vector search --------------------------------
VECTOR = (
    "CALL db.index.vector.queryNodes($vector_index, $vector_overfetch, $vector_query) "
    "YIELD node AS PROJECT, score "
    "WHERE PROJECT.attributive_label = 'PROJECT' "
    "RETURN PROJECT, score ORDER BY score DESC LIMIT $vector_k"
)
check("equality form detected", labels(VECTOR) == {"PROJECT"})
check(
    "equality form tolerates no spaces",
    labels("WHERE n.attributive_label='Task' RETURN n") == {"Task"},
)
check(
    "equality form tolerates extra spaces",
    labels("WHERE n.attributive_label   =   'Task' RETURN n") == {"Task"},
)
check(
    "double-quoted equality form detected",
    labels('WHERE n.attributive_label = "Task" RETURN n') == {"Task"},
)
check(
    "no substring false-positive in the equality form",
    "Person" not in labels("WHERE n.attributive_label = 'Personnel' RETURN n"),
)

# --- both forms in one package ----------------------------------------------
check(
    "map and equality forms combine across statements",
    labels("MATCH (n:INSTANCE {attributive_label: 'Person'}) RETURN n", VECTOR)
    == {"Person", "PROJECT"},
)

# --- things that must NOT be treated as a reference -------------------------
check(
    "a property key that merely contains attributive_label is not matched",
    labels("WHERE n.attributive_label_note = 'Person' RETURN n") == set(),
)
check(
    "a parameterized binding yields no literal label",
    labels("MATCH (n:INSTANCE {attributive_label: $companyType}) RETURN n") == set(),
)
check(
    "a parameterized equality yields no literal label",
    labels("WHERE n.attributive_label = $companyType RETURN n") == set(),
)
check(
    "inequality is not treated as a reference",
    labels("WHERE n.attributive_label <> 'Person' RETURN n") == set(),
)

# --- malformed input degrades gracefully ------------------------------------
check("empty string -> empty set", cypher_utils.labels_in_cypher_array("") == set())
check("None -> empty set", cypher_utils.labels_in_cypher_array(None) == set())
check(
    "non-array JSON -> empty set",
    cypher_utils.labels_in_cypher_array('{"not":"an array"}') == set(),
)
check(
    "invalid JSON -> empty set",
    cypher_utils.labels_in_cypher_array("not json at all") == set(),
)

print()
if failures:
    print(f"{len(failures)} check(s) FAILED:")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("cypher-attributive-label-scan: ok")
