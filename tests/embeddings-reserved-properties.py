"""
Diagnostic test for the reserved embedding properties.

Two guarantees that keep vector storage from leaking into the rest of the product:

  1. ``embedding`` is stripped from query results (Engine/server/graph.py). The composer
     appends ``RETURN *`` to every create, so without this a 768-1024 float array lands in
     every graph-viz payload and MCP response. An *explicit* top-level projection
     (``RETURN n.embedding AS embedding``) is still honoured, and ``embedding_stale``
     survives because filtering on it is how not-yet-indexed records are read.
  2. ``embedding`` / ``embedding_stale`` cannot be authored as SCHEMA properties
     (schema_update.validate_schema_update), enforced in Python because any client can
     call the API directly. The implicit ``id`` key must still be accepted.

No database or network needed.

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/embeddings-reserved-properties.py
"""

import inspect
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import graph, schema_update  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


VECTOR = [0.1, 0.2, 0.3]


class FakeRecord:
    """Mimics a neo4j Record: ``data()`` flattens nodes into plain property maps."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def data(self) -> dict[str, Any]:
        return self._payload


# --- result stripping -------------------------------------------------------
row = graph._record_data(
    FakeRecord({"n": {"NAME": "Alice", "embedding": VECTOR, "embedding_stale": True}})
)
check("embedding is stripped from a returned node map", "embedding" not in row["n"])
check("domain properties survive", row["n"].get("NAME") == "Alice")
check("embedding_stale survives (it is a documented read filter)", row["n"]["embedding_stale"] is True)

nested = graph._record_data(
    FakeRecord({"rows": [{"embedding": VECTOR, "NAME": "Alice"}, {"NAME": "Bob"}]})
)
check(
    "embedding is stripped inside collected lists",
    all("embedding" not in item for item in nested["rows"]),
)

deep = graph._record_data(FakeRecord({"path": {"start": {"embedding": VECTOR, "NAME": "Alice"}}}))
check("embedding is stripped at any depth", "embedding" not in deep["path"]["start"])

explicit = graph._record_data(FakeRecord({"embedding": VECTOR}))
check(
    "an explicit top-level projection is honoured",
    explicit.get("embedding") == VECTOR,
)

# The graph-viz entities come from live driver objects, so assert the serializer routes
# both property bags through the filter rather than constructing neo4j internals here.
collect_src = inspect.getsource(graph._collect_graph_entities)
check(
    "node viz properties are filtered",
    collect_src.count('"properties": _strip_embedding_properties(dict(value))') == 2,
)
check(
    "no unfiltered property bag remains in the viz serializer",
    '"properties": dict(value)' not in collect_src,
)

# --- reserved SCHEMA property names -----------------------------------------
graph._fetch_entity_payload = lambda space_id, entity_id, node_label: {  # type: ignore[assignment]
    "schemata": [
        {
            "property_schema": {
                "name": "NAME",
                "value_type": "string",
                "is_required": True,
                "is_key": False,
                "is_label": True,
                "is_indexed": False,
            }
        }
    ]
}
graph._resolve_schema_relationship_id = lambda space_id, al: None  # type: ignore[assignment]

IMPLICIT_KEY = {"key": "id", "value_type": "UID", "is_required": True, "is_key": True}
NAME_PROP = {"key": "NAME", "value_type": "string", "is_required": True, "is_label": True}


def validate(incoming: list[dict[str, Any]]) -> dict[str, Any]:
    return schema_update.validate_schema_update("TEST_SPACE", "ID_schema", "CUSTOMER", incoming)


for reserved in ("embedding", "EMBEDDING", "embedding_stale", "EMBEDDING_STALE"):
    try:
        validate([IMPLICIT_KEY, NAME_PROP, {"key": reserved, "value_type": "string"}])
        check(f"schema property {reserved!r} rejected", False)
    except ValueError as e:
        check(f"schema property {reserved!r} rejected", "reserved system property" in str(e))

try:
    result = validate([IMPLICIT_KEY, NAME_PROP])
    check("an ordinary update still validates", result["schema_id"] == "ID_schema")
    check("the implicit id key is not treated as reserved", not result["deleted"])
except ValueError as e:
    check(f"an ordinary update still validates (raised {e})", False)

check(
    "the Python and TypeScript reserved sets agree on the embedding properties",
    graph.RESERVED_EMBEDDING_PROPERTY_KEYS == frozenset({"embedding", "embedding_stale"}),
)

print()
if failures:
    print(f"embeddings-reserved-properties: {len(failures)} FAILED")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("embeddings-reserved-properties: ok")
