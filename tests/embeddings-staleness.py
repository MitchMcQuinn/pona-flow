"""
Diagnostic test for vector staleness and the incremental (stale-only) reindex.

Vectors are written once and then have to be kept honest, so this covers the four ways a
stored vector stops describing its record:
  - an INSTANCE update (label-scoped marking, since a composed statement does not say which
    records it touched);
  - a rename of a *neighbouring* node, because a relationship's embedded text is led by its
    endpoints' display labels;
  - a SCHEMA change to the include list (asserted in embeddings-schema-flags.py, wired here);
  - a model change, which clears vectors outright (embeddings-space-config.py).

Plus the consumer of all that: reindex with ``only_stale`` must filter on the pending
predicate, must not page forward (embedding a record removes it from the set), and must stop
instead of retrying a record that failed and was re-marked stale.

No database or network: graph.run_cypher_for_space and _call_ollama are stubbed.

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/embeddings-staleness.py
"""

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import embeddings as emb  # noqa: E402
from Engine.server import graph  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


calls: list[tuple[str, dict[str, Any]]] = []
_counts: dict[str, int] = {}
_pages: list[list[dict[str, Any]]] = []


def fake_cypher(space_id: str, cypher: str, params: dict[str, Any]) -> dict[str, Any]:
    calls.append((cypher, dict(params)))
    if "SKIP" in cypher:
        return {"records": _pages.pop(0) if _pages else []}
    return {"records": [{"c": _counts.get("c", 0)}]}


graph.run_cypher_for_space = fake_cypher  # type: ignore[assignment]
emb.graph.run_cypher_for_space = fake_cypher  # type: ignore[assignment]

# --- marking on write --------------------------------------------------------
calls.clear()
_counts["c"] = 3
marked = emb.mark_label_stale("SPACE_A", "CUSTOMER")
check("both node and relationship forms are marked", marked == {"nodes": 3, "relationships": 3})
node_stmt, rel_stmt = calls[0][0], calls[1][0]
check(
    "only records that already have a vector are marked",
    "n.`embedding` IS NOT NULL" in node_stmt and "r.`embedding` IS NOT NULL" in rel_stmt,
)
check(
    "the relationship form stays INSTANCE-to-INSTANCE",
    "(:INSTANCE)-[r:POINTS_TO {attributive_label: $al}]->(:INSTANCE)" in rel_stmt,
)
check("marking sets the stale flag", "SET n.`embedding_stale` = true" in node_stmt)
check("the label is a parameter, never interpolated", calls[0][1] == {"al": "CUSTOMER"})

# --- a rename invalidates the edges of the renamed node ----------------------
calls.clear()
_counts["c"] = 5
check("endpoint edges are marked", emb.mark_endpoint_relationships_stale("SPACE_A", "CUSTOMER") == 5)
endpoint_stmt = calls[0][0]
check(
    "endpoint marking is direction-agnostic (text names both ends)",
    "(n:INSTANCE {attributive_label: $al})-[r:POINTS_TO]-(:INSTANCE)" in endpoint_stmt,
)
check(
    "an edge with no vector is left alone",
    "WHERE r.`embedding` IS NOT NULL" in endpoint_stmt,
)

# --- the write-path entry point is gated and never raises -------------------
emb.resolve_config = lambda space_id: {  # type: ignore[assignment]
    "enabled": False,
    "ollama_url": "http://127.0.0.1:11434",
    "embed_model": "test-embed",
    "dimensions": 3,
    "source": "space",
}
calls.clear()
emb.mark_labels_stale("SPACE_A", ["CUSTOMER"])
check("a space with vector search off is not touched at all", calls == [])

enabled_config = {
    "enabled": True,
    "ollama_url": "http://127.0.0.1:11434",
    "embed_model": "test-embed",
    "dimensions": 3,
    "source": "space",
}
emb.resolve_config = lambda space_id: dict(enabled_config)  # type: ignore[assignment]

emb.graph.fetch_schema_definition = lambda space_id, label: {  # type: ignore[assignment]
    "schema_id": "ID_schema",
    "attributive_label": label,
    "schemata": [{"key": "NAME", "is_label": True, "is_embedded": False}],
    "is_vectorized": label == "CUSTOMER",
}

calls.clear()
emb.mark_labels_stale("SPACE_A", ["CUSTOMER"])
check(
    "a vectorized label is marked and its edges with it",
    len(calls) == 3 and "-[r:POINTS_TO]-(:INSTANCE)" in calls[2][0],
)

calls.clear()
emb.mark_labels_stale("SPACE_A", ["ORDER"])
check(
    "an unvectorized label only invalidates the edges it is an endpoint of",
    len(calls) == 1 and "-[r:POINTS_TO]-(:INSTANCE)" in calls[0][0],
)


def _raise(*_args: Any, **_kwargs: Any) -> None:
    raise RuntimeError("neo4j is down")


saved_cypher = emb.graph.run_cypher_for_space
emb.graph.run_cypher_for_space = _raise  # type: ignore[assignment]
try:
    emb.mark_labels_stale("SPACE_A", ["CUSTOMER"])
    check("a graph failure never fails the write it follows", True)
except Exception:
    check("a graph failure never fails the write it follows", False)
emb.graph.run_cypher_for_space = saved_cypher  # type: ignore[assignment]

# --- the pending predicate ---------------------------------------------------
page = emb._page_cypher(emb.KIND_NODE, ["NAME"], only_stale=True)
check(
    "stale-only paging asks for unindexed or stale records",
    "n.`embedding` IS NULL" in page and "n.`embedding_stale` = true" in page,
)
check(
    "a full pass has no pending filter",
    "WHERE" not in emb._page_cypher(emb.KIND_NODE, ["NAME"]),
)

# --- incremental reindex -----------------------------------------------------
emb.probe_dimensions = lambda cfg=None: 3  # type: ignore[assignment]
emb.embed_text = lambda text, cfg=None: [0.1, 0.2, 0.3]  # type: ignore[assignment]
emb.resolve_embedded_keys = lambda space_id, label: ["NAME"]  # type: ignore[assignment]

calls.clear()
_pages.clear()
_pages.append([{"id": "ID_1", "vals": ["Alice"]}, {"id": "ID_2", "vals": ["Bob"]}])
_pages.append([{"id": "ID_1", "vals": ["Alice"]}])  # ID_1 re-marked stale by a failure
stats = emb.reindex_label("SPACE_A", "CUSTOMER", only_stale=True)
check("both pending records are embedded", stats["embedded"] == 2)
check("a record already seen in this run does not loop", stats["scanned"] == 2)
skips = [params.get("skip") for cypher, params in calls if "SKIP" in cypher]
check("a stale-only walk re-reads from the start", skips == [0, 0])
check("the run reports its mode", stats["only_stale"] is True)

calls.clear()
_pages.clear()
_pages.append([{"id": "ID_1", "vals": ["Alice"]}])
_pages.append([])
full = emb.reindex_label("SPACE_A", "CUSTOMER")
full_skips = [params.get("skip") for cypher, params in calls if "SKIP" in cypher]
check("a full pass pages forward as before", full_skips == [0, 1])
check("a full pass is not stale-only", full["only_stale"] is False)

print()
if failures:
    print(f"embeddings-staleness: {len(failures)} FAILED")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("embeddings-staleness: ok")
