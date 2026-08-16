"""
Diagnostic test for the vector-search execution pre-step.

A saved vector-search operation stores Cypher containing ``$vector_query``, which only
the engine can fill (the embedding needs the space's Ollama model). This covers the
resolver that runs before Neo4j, on both the ``/api/execute-query`` path and the
sequence query-step path:

  - detection: only statements calling ``db.index.vector.query*`` trigger any work, so
    an ordinary read never touches Ollama;
  - engine-filled params: ``vector_query`` (the vector), ``vector_index``,
    ``vector_overfetch`` (k * factor, capped);
  - ``vector_k`` coerced from the string a run-panel form submits (Neo4j rejects a
    string LIMIT), and rejected outside 1..SEARCH_MAX_K;
  - blank ``vector_query_text`` and a space with embeddings disabled both fail loudly
    rather than returning an empty result set;
  - the relationship index is chosen for ``queryRelationships``;
  - ``vector_role`` on a declared catalog row redirecting the text/k lookup to the
    author's own parameter names, with the reserved names as the fallback;
  - ``execution_run._execute_query_step`` resolves before it runs the stored Cypher,
    passing the referenced operation's declared rows so the marker is visible.

No database or network needed: ``embeddings._call_ollama`` and
``graph.run_cypher_for_space`` are replaced with recorders.

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/embeddings-resolve-search-params.py
"""

import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ["PONA_FLOW_OLLAMA_EMBED_MODEL"] = "test-embed"

from Engine.server import embeddings as emb  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


SPACE = "TEST_SPACE"
VECTOR = [0.1, 0.2, 0.3]

VECTOR_CYPHER = (
    "CALL db.index.vector.queryNodes($vector_index, $vector_overfetch, $vector_query) "
    "YIELD node AS PROJECT, score "
    "WHERE PROJECT.attributive_label = 'PROJECT' "
    "RETURN PROJECT, score ORDER BY score DESC LIMIT $vector_k"
)
REL_CYPHER = (
    "CALL db.index.vector.queryRelationships($vector_index, $vector_overfetch, $vector_query) "
    "YIELD relationship, score RETURN relationship, score LIMIT $vector_k"
)
PLAIN_CYPHER = "MATCH (PROJECT:INSTANCE { attributive_label: 'PROJECT' }) RETURN *"


class OllamaRecorder:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def __call__(
        self, path: str, payload: dict[str, Any], base_url: str | None = None
    ) -> dict[str, Any]:
        self.seen.append(str(payload.get("input") or ""))
        return {"embeddings": [list(VECTOR)]}


ollama = OllamaRecorder()
emb._call_ollama = ollama  # type: ignore[assignment]
emb.spaces.fetch_space_embeddings_config = lambda space_id: {  # type: ignore[assignment]
    "enabled": True,
    "embed_model": "test-embed",
}


# --- detection --------------------------------------------------------------
check(
    "plain read is not a vector statement",
    emb.statements_need_vector_resolve([PLAIN_CYPHER]) is False,
)
check(
    "queryNodes is detected",
    emb.statements_need_vector_resolve([VECTOR_CYPHER]) is True,
)
check(
    "queryRelationships is detected",
    emb.statements_need_vector_resolve([REL_CYPHER]) is True,
)

before = len(ollama.seen)
passthrough = emb.resolve_search_params(SPACE, [PLAIN_CYPHER], {"foo": "bar"})
check("plain read passes params through untouched", passthrough == {"foo": "bar"})
check("plain read never calls Ollama", len(ollama.seen) == before)


# --- engine-filled params ---------------------------------------------------
resolved = emb.resolve_search_params(
    SPACE, [VECTOR_CYPHER], {"vector_query_text": "roadmap", "vector_k": 5}
)
check("embedding bound to vector_query", resolved["vector_query"] == VECTOR)
check("node index selected", resolved["vector_index"] == emb.NODE_VECTOR_INDEX)
check(
    "overfetch is k * factor",
    resolved["vector_overfetch"] == 5 * emb.SEARCH_OVERFETCH_FACTOR,
)
check("k preserved as int", resolved["vector_k"] == 5)
check("search text is what got embedded", ollama.seen[-1] == "roadmap")

capped = emb.resolve_search_params(
    SPACE, [VECTOR_CYPHER], {"vector_query_text": "x", "vector_k": emb.SEARCH_MAX_K}
)
check(
    "overfetch is capped at SEARCH_MAX_OVERFETCH",
    capped["vector_overfetch"] == emb.SEARCH_MAX_OVERFETCH,
)

rel = emb.resolve_search_params(
    SPACE, [REL_CYPHER], {"vector_query_text": "x", "vector_k": 3}
)
check(
    "relationship index selected for queryRelationships",
    rel["vector_index"] == emb.RELATIONSHIP_VECTOR_INDEX,
)


# --- k coercion and bounds --------------------------------------------------
coerced = emb.resolve_search_params(
    SPACE, [VECTOR_CYPHER], {"vector_query_text": "x", "vector_k": "7"}
)
check("string k coerced to int (Neo4j rejects a string LIMIT)", coerced["vector_k"] == 7)
check("coerced k is really an int", isinstance(coerced["vector_k"], int))

defaulted = emb.resolve_search_params(SPACE, [VECTOR_CYPHER], {"vector_query_text": "x"})
check("missing k falls back to the default", defaulted["vector_k"] == emb.SEARCH_DEFAULT_K)


def rejects(name: str, params: dict[str, Any], needle: str) -> None:
    try:
        emb.resolve_search_params(SPACE, [VECTOR_CYPHER], params)
    except ValueError as e:
        check(name, needle in str(e))
    else:
        check(name, False)


rejects("k of 0 rejected", {"vector_query_text": "x", "vector_k": 0}, "between 1")
rejects(
    "k above the ceiling rejected",
    {"vector_query_text": "x", "vector_k": emb.SEARCH_MAX_K + 1},
    "between 1",
)
rejects("non-numeric k rejected", {"vector_query_text": "x", "vector_k": "abc"}, "integer")
rejects("blank search text rejected", {"vector_query_text": "   "}, "vector_query_text")
rejects("missing search text rejected", {}, "vector_query_text")


# --- disabled space ---------------------------------------------------------
emb.spaces.fetch_space_embeddings_config = lambda space_id: {  # type: ignore[assignment]
    "enabled": False,
    "embed_model": "test-embed",
}
try:
    emb.resolve_search_params(SPACE, [VECTOR_CYPHER], {"vector_query_text": "x"})
except ValueError as e:
    check("disabled space rejected with a readable message", "not enabled" in str(e))
else:
    check("disabled space rejected with a readable message", False)

emb.spaces.fetch_space_embeddings_config = lambda space_id: {  # type: ignore[assignment]
    "enabled": True,
    "embed_model": "test-embed",
}


# --- Ollama down ------------------------------------------------------------
def down(path: str, payload: dict[str, Any], base_url: str | None = None):
    raise emb.EmbeddingsUnavailable("ollama down")


emb._call_ollama = down  # type: ignore[assignment]
try:
    emb.resolve_search_params(SPACE, [VECTOR_CYPHER], {"vector_query_text": "x"})
except emb.EmbeddingsUnavailable:
    check("Ollama down raises rather than returning empty results", True)
else:
    check("Ollama down raises rather than returning empty results", False)
emb._call_ollama = ollama  # type: ignore[assignment]


# --- sequence query step resolves before running ----------------------------
from Engine.server import execution_run  # noqa: E402

ran: list[tuple[str, dict[str, Any]]] = []


def fake_run_cypher(space_id: str, cypher: str, params: dict[str, Any] | None = None):
    ran.append((cypher, dict(params or {})))
    return {"records": [], "graph": None, "summary": {"counters": {}}}


execution_run.graph.run_cypher_for_space = fake_run_cypher  # type: ignore[assignment]
execution_run.catalog.fetch_query_for_compose = lambda query_id: {  # type: ignore[assignment]
    "cypher": [VECTOR_CYPHER],
    "operation": "read",
    "runtime_enabled": 1,
    "suspended": 0,
    "parameters": [
        {"name": "vector_query_text", "value_type": "string", "value": ""},
        {"name": "vector_k", "value_type": "integer", "value": 10},
    ],
}
execution_run.schema_currency.reconcile_labels = lambda *a, **k: None  # type: ignore[assignment]
execution_run.embeddings.mark_labels_stale = lambda *a, **k: None  # type: ignore[assignment]

execution_run._execute_query_step(
    SPACE, "q-vector", {"vector_query_text": "quarterly goals", "vector_k": "4"}
)
check("query step ran exactly one statement", len(ran) == 1)
step_params = ran[0][1]
check("query step bound the embedding", step_params.get("vector_query") == VECTOR)
check("query step filled the index name", step_params.get("vector_index") == emb.NODE_VECTOR_INDEX)
check("query step coerced k", step_params.get("vector_k") == 4)
check("query step embedded the caller's text", ollama.seen[-1] == "quarterly goals")


# --- author-named parameters (vector_role) ----------------------------------
# When the author backs the text or k with a parameter of their own naming, the
# composer marks the catalog row and the resolver follows that marker instead of the
# reserved names. Two vector searches in one sequence then cannot collide.
NAMED_CYPHER = VECTOR_CYPHER.replace("LIMIT $vector_k", "LIMIT $topK")
NAMED_ROWS = [
    {"name": "searchTerm", "value_type": "string", "value": "", "vector_role": "text"},
    {"name": "topK", "value_type": "integer", "value": 10, "vector_role": "k"},
]

named = emb.resolve_search_params(
    SPACE,
    [NAMED_CYPHER],
    {"searchTerm": "roadmap planning", "topK": "6"},
    NAMED_ROWS,
)
check("role=text names the parameter that gets embedded", ollama.seen[-1] == "roadmap planning")
check("role=k is coerced in place for the LIMIT binding", named["topK"] == 6)
check("coerced named k is really an int", isinstance(named["topK"], int))
check("overfetch derives from the named k", named["vector_overfetch"] == 6 * emb.SEARCH_OVERFETCH_FACTOR)
check("reserved k is not written when k is named", "vector_k" not in named)
check("embedding still lands on vector_query", named["vector_query"] == VECTOR)

# A mix: the text is named, k stays reserved.
mixed = emb.resolve_search_params(
    SPACE,
    [VECTOR_CYPHER],
    {"searchTerm": "just the text", "vector_k": 3},
    [NAMED_ROWS[0]],
)
check("mixed: named text embedded", ollama.seen[-1] == "just the text")
check("mixed: reserved k still resolved", mixed["vector_k"] == 3)

# Rows with no vector_role (every operation saved before this existed) fall back.
legacy = emb.resolve_search_params(
    SPACE,
    [VECTOR_CYPHER],
    {"vector_query_text": "legacy", "vector_k": 2},
    [{"name": "somethingElse", "value_type": "string", "value": ""}],
)
check("untagged rows fall back to the reserved names", legacy["vector_k"] == 2)
check("untagged rows still embed the reserved text", ollama.seen[-1] == "legacy")

# A missing named text fails under the author's name, not the reserved one.
try:
    emb.resolve_search_params(SPACE, [NAMED_CYPHER], {"topK": 5}, NAMED_ROWS)
except ValueError as e:
    check("missing named text names the author's parameter", "searchTerm" in str(e))
else:
    check("missing named text names the author's parameter", False)

# An out-of-range named k is rejected at run time, since author-time cannot see it.
try:
    emb.resolve_search_params(
        SPACE, [NAMED_CYPHER], {"searchTerm": "x", "topK": 500}, NAMED_ROWS
    )
except ValueError as e:
    check("out-of-range named k rejected at run time", "topK" in str(e) and "between 1" in str(e))
else:
    check("out-of-range named k rejected at run time", False)

# A named k left blank by the run panel falls back rather than failing to coerce.
blank_k = emb.resolve_search_params(
    SPACE, [NAMED_CYPHER], {"searchTerm": "x", "topK": ""}, NAMED_ROWS
)
check("blank named k falls back to the default", blank_k["topK"] == emb.SEARCH_DEFAULT_K)


# --- sequence query step passes the declared rows ---------------------------
execution_run.catalog.fetch_query_for_compose = lambda query_id: {  # type: ignore[assignment]
    "cypher": [NAMED_CYPHER],
    "operation": "read",
    "runtime_enabled": 1,
    "suspended": 0,
    "parameters": NAMED_ROWS,
}
ran.clear()
execution_run._execute_query_step(SPACE, "q-vector-named", {"searchTerm": "named run", "topK": "8"})
check("named query step ran exactly one statement", len(ran) == 1)
named_params = ran[0][1]
check("named query step embedded the author's parameter", ollama.seen[-1] == "named run")
check("named query step bound the embedding", named_params.get("vector_query") == VECTOR)
check("named query step coerced the author's k", named_params.get("topK") == 8)


print()
if failures:
    print(f"{len(failures)} check(s) FAILED:")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("embeddings-resolve-search-params: ok")
