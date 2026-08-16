"""
Diagnostic test for local vector search (Engine/server/embeddings.py).

Covers, with Ollama and Neo4j both stubbed out:
  - build_record_text: KEY: value in schema order, missing optionals skipped,
    array values comma-joined, relationship text led by its endpoints, truncation;
  - _validate_dimensions and the CREATE VECTOR INDEX DDL (inlined dimension, cosine);
  - reindex_label: paging, one embed + one SET per record, ``embedding_stale`` stamped
    when an embed fails, abort after repeated failures, empty text skipped;
  - relationship statements restricted to (:INSTANCE)-[:POINTS_TO]->(:INSTANCE) so STEP
    and SCHEMA pattern edges are never embedded;
  - search: overfetch-then-filter for a label, plain k when unfiltered, the relationship
    index + queryRelationships for relationship kind, and failure (not empty results)
    when Ollama is down.

No database or network needed: ``embeddings._call_ollama`` and
``graph.run_cypher_for_space`` are replaced with recorders.

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/embeddings-vector-search.py
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
PROBE_TEXT = "dimension probe"
VECTOR = [0.1, 0.2, 0.3]


class CypherRecorder:
    """Stands in for graph.run_cypher_for_space, recording every statement."""

    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.responses = responses or {}

    def __call__(
        self, space_id: str, cypher: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.calls.append((cypher, dict(params or {})))
        for needle, payload in self.responses.items():
            if needle in cypher:
                resolved = payload(dict(params or {})) if callable(payload) else payload
                return {"records": resolved} if isinstance(resolved, list) else resolved
        return {"records": []}

    def matching(self, needle: str) -> list[tuple[str, dict[str, Any]]]:
        return [call for call in self.calls if needle in call[0]]


def fake_ollama(vector: list[float] = VECTOR, fail_records: bool = False):
    """A stub /api/embed. ``fail_records`` fails everything except the dimension probe."""
    seen: list[str] = []

    def call(
        path: str, payload: dict[str, Any], base_url: str | None = None
    ) -> dict[str, Any]:
        text = str(payload.get("input") or "")
        seen.append(text)
        if fail_records and text != PROBE_TEXT:
            raise emb.EmbeddingsUnavailable("ollama down")
        return {"embeddings": [list(vector)]}

    call.seen = seen  # type: ignore[attr-defined]
    return call


def install(monkey_cypher: CypherRecorder, ollama) -> None:
    emb.graph.run_cypher_for_space = monkey_cypher  # type: ignore[assignment]
    emb._call_ollama = ollama  # type: ignore[assignment]


# No stored space settings: the instance env vars stand in (see resolve_config).
emb.spaces.fetch_space_embeddings_config = lambda space_id: {}  # type: ignore[assignment]


def stub_schema(keys: list[str], *, is_vectorized: bool = True) -> None:
    """Pretend the SCHEMA declares ``keys`` as its display-label properties."""
    emb.graph.fetch_schema_definition = lambda space_id, al: {  # type: ignore[assignment]
        "schema_id": "ID_schema",
        "attributive_label": al,
        "is_vectorized": is_vectorized,
        "schemata": [
            {"key": "id", "value_type": "UID", "is_key": True, "is_label": False},
            *[{"key": k, "value_type": "string", "is_key": False, "is_label": True} for k in keys],
        ],
    }


# --- serialization ----------------------------------------------------------
check(
    "node text is KEY: value in schema order",
    emb.build_record_text({"NAME": "Alice", "ROLE": "eng"}, ["NAME", "ROLE"])
    == "NAME: Alice\nROLE: eng",
)
check(
    "missing optional property is skipped (no empty placeholder)",
    emb.build_record_text({"NAME": "Alice"}, ["NAME", "ROLE"]) == "NAME: Alice",
)
check(
    "blank value is skipped",
    emb.build_record_text({"NAME": "", "ROLE": "eng"}, ["NAME", "ROLE"]) == "ROLE: eng",
)
check(
    "array value is comma-joined",
    emb.build_record_text({"TAGS": ["a", "b"]}, ["TAGS"]) == "TAGS: a, b",
)
check(
    "relationship text is led by its endpoints",
    emb.build_record_text(
        {"ROLE": "eng"},
        ["ROLE"],
        attributive_label="WORKS_AT",
        source_label="Alice",
        target_label="Acme",
    )
    == "Alice WORKS_AT Acme\nROLE: eng",
)
check(
    "over-long text is truncated, not summarized",
    len(emb.build_record_text({"NOTES": "x" * 20000}, ["NOTES"])) == emb.TEXT_MAX_CHARS,
)
check(
    "with nothing marked, the display-label property is embedded",
    emb.embedded_keys(
        [
            {"key": "id", "is_key": True, "is_label": False},
            {"key": "NAME", "is_key": False, "is_label": True},
            {"key": "TAX_ID", "is_key": False, "is_label": False},
        ]
    )
    == ["NAME"],
)
check(
    "is_embedded is the include list, in schema order",
    emb.embedded_keys(
        [
            {"key": "id", "is_key": True},
            {"key": "TITLE", "is_label": True, "is_embedded": True},
            {"key": "TAX_ID"},
            {"key": "NOTES", "is_embedded": True},
        ]
    )
    == ["TITLE", "NOTES"],
)
check(
    "an unmarked label property is dropped once anything is marked",
    emb.embedded_keys(
        [{"key": "NAME", "is_label": True}, {"key": "NOTES", "is_embedded": True}]
    )
    == ["NOTES"],
)
check(
    "the key property is never embedded",
    emb.embedded_keys([{"key": "id", "is_key": True, "is_embedded": True}]) == [],
)

# --- dimensions + index DDL -------------------------------------------------
for bad in ("abc", 0, -1, emb.MAX_VECTOR_DIMENSIONS + 1):
    try:
        emb._validate_dimensions(bad)
        check(f"dimensions {bad!r} rejected", False)
    except ValueError:
        check(f"dimensions {bad!r} rejected", True)

rec = CypherRecorder()
install(rec, fake_ollama())
emb.ensure_vector_indexes(SPACE, 768)
node_ddl = rec.matching(f"CREATE VECTOR INDEX {emb.NODE_VECTOR_INDEX}")
rel_ddl = rec.matching(f"CREATE VECTOR INDEX {emb.RELATIONSHIP_VECTOR_INDEX}")
check("node vector index created", len(node_ddl) == 1)
check("relationship vector index created", len(rel_ddl) == 1)
check(
    "dimension is inlined (index options cannot be parameterized)",
    "`vector.dimensions`: 768" in node_ddl[0][0],
)
check("cosine similarity configured", "'cosine'" in node_ddl[0][0])
check("node index is on (n:INSTANCE)", "FOR (n:INSTANCE)" in node_ddl[0][0])
check("relationship index is on POINTS_TO", "()-[r:POINTS_TO]-()" in rel_ddl[0][0])

# --- reindex: nodes ---------------------------------------------------------
stub_schema(["NAME"])
rec = CypherRecorder(
    {
        "SKIP $skip": lambda params: (
            [{"id": "ID_a", "vals": ["Alice"]}, {"id": "ID_b", "vals": ["Bob"]}]
            if params.get("skip") == 0
            else []
        )
    }
)
ollama = fake_ollama()
install(rec, ollama)
stats = emb.reindex_label(SPACE, "CUSTOMER")
writes = rec.matching(f"SET n.`{emb.EMBEDDING_PROPERTY}`")
check("reindex embedded every record", stats["embedded"] == 2)
check("reindex scanned every record", stats["scanned"] == 2)
check("reindex reports the probed dimension", stats["dimensions"] == len(VECTOR))
check("reindex wrote one vector per record", len(writes) == 2)
check("reindex passes the vector as a parameter", writes[0][1].get("vec") == VECTOR)
check(
    "reindex clears the stale marker on success",
    f"REMOVE n.`{emb.EMBEDDING_STALE_PROPERTY}`" in writes[0][0],
)
check(
    "reindex embedded the serialized text",
    ollama.seen == [PROBE_TEXT, "NAME: Alice", "NAME: Bob"],
)
check(
    "reindex projects only embedded keys (never the embedding property)",
    all(emb.EMBEDDING_PROPERTY not in call[0] for call in rec.matching("SKIP $skip")),
)
check("reindex stopped paging on an empty page", len(rec.matching("SKIP $skip")) == 2)

# --- reindex: relationships stay INSTANCE-scoped ----------------------------
stub_schema([])
rec = CypherRecorder(
    {
        "SKIP $skip": lambda params: (
            [
                {
                    "id": "ID_r",
                    "vals": [],
                    "source_label": "Alice",
                    "target_label": "Acme",
                }
            ]
            if params.get("skip") == 0
            else []
        )
    }
)
ollama = fake_ollama()
install(rec, ollama)
stats = emb.reindex_label(SPACE, "WORKS_AT", kind=emb.KIND_RELATIONSHIP)
rel_statements = [c[0] for c in rec.calls if "POINTS_TO" in c[0]]
check("relationship reindex embedded the edge", stats["embedded"] == 1)
check(
    "relationship text uses endpoint display labels",
    ollama.seen == [PROBE_TEXT, "Alice WORKS_AT Acme"],
)
check(
    "every relationship statement requires INSTANCE endpoints",
    bool(rel_statements)
    and all(
        ":INSTANCE)-[r:POINTS_TO" in stmt or "(a:INSTANCE)-[r:POINTS_TO" in stmt
        for stmt in rel_statements
        if "CREATE VECTOR INDEX" not in stmt
    ),
)

# --- reindex: failures degrade to embedding_stale ---------------------------
stub_schema(["NAME"])
rec = CypherRecorder(
    {
        "SKIP $skip": lambda params: (
            [{"id": "ID_a", "vals": ["Alice"]}] if params.get("skip") == 0 else []
        )
    }
)
install(rec, fake_ollama(fail_records=True))
stats = emb.reindex_label(SPACE, "CUSTOMER")
check("failed embed does not count as embedded", stats["embedded"] == 0)
check("failed embed is reported", stats["failed"] == 1)
check(
    "failed embed stamps embedding_stale",
    len(rec.matching(f"SET n.`{emb.EMBEDDING_STALE_PROPERTY}` = true")) == 1,
)

rec = CypherRecorder(
    {
        "SKIP $skip": lambda params: (
            [{"id": f"ID_{i}", "vals": [f"Name {i}"]} for i in range(20)]
            if params.get("skip") == 0
            else []
        )
    }
)
install(rec, fake_ollama(fail_records=True))
stats = emb.reindex_label(SPACE, "CUSTOMER")
check("a persistently down Ollama aborts the run", stats["aborted"] is True)
check(
    "abort happens after a small number of failures",
    stats["failed"] == emb._REINDEX_MAX_CONSECUTIVE_FAILURES,
)

rec = CypherRecorder(
    {
        "SKIP $skip": lambda params: (
            [{"id": "ID_a", "vals": [""]}] if params.get("skip") == 0 else []
        )
    }
)
install(rec, fake_ollama())
stats = emb.reindex_label(SPACE, "CUSTOMER")
check("record with no embeddable text is skipped", stats["skipped"] == 1)
check("skipped record is not embedded", stats["embedded"] == 0)

stub_schema([])
install(CypherRecorder(), fake_ollama())
try:
    emb.reindex_label(SPACE, "CUSTOMER")
    check("node SCHEMA without a label property is rejected", False)
except ValueError:
    check("node SCHEMA without a label property is rejected", True)

stub_schema(["NAME"], is_vectorized=False)
rec = CypherRecorder()
install(rec, fake_ollama())
try:
    emb.reindex_label(SPACE, "CUSTOMER")
    check("a SCHEMA that has not opted in is not indexed", False)
except ValueError as e:
    check("a SCHEMA that has not opted in is not indexed", "not vectorized" in str(e))
check("refusing to index writes nothing", rec.calls == [])
stub_schema(["NAME"])

# --- search -----------------------------------------------------------------
hits = [{"id": "ID_a", "attributive_label": "CUSTOMER", "display_label": "Alice", "score": 0.9}]
rec = CypherRecorder({"db.index.vector.queryNodes": hits})
install(rec, fake_ollama())
out = emb.search(SPACE, "who is alice", k=5, attributive_label="CUSTOMER")
cypher, params = rec.matching("db.index.vector.queryNodes")[0]
check("search returns the index hits", out["hits"] == hits and out["count"] == 1)
check("search reports the model used", out["model"] == "test-embed")
check(
    "label filter overfetches so k of one type stays reachable",
    params["overfetch"] == 5 * emb.SEARCH_OVERFETCH_FACTOR,
)
check("label filter is applied after the index call", "WHERE node.attributive_label = $al" in cypher)
check("k is applied as the final limit", "LIMIT $k" in cypher and params["k"] == 5)
check("search targets the node index", params["index"] == emb.NODE_VECTOR_INDEX)
check("query vector is passed as a parameter", params["vec"] == VECTOR)

rec = CypherRecorder({"db.index.vector.queryNodes": hits})
install(rec, fake_ollama())
emb.search(SPACE, "anything", k=7)
cypher, params = rec.matching("db.index.vector.queryNodes")[0]
check("unfiltered search does not overfetch", params["overfetch"] == 7)
check("unfiltered search has no label predicate", "attributive_label = $al" not in cypher)
check("unfiltered search binds no label", "al" not in params)

rec = CypherRecorder({"db.index.vector.queryRelationships": []})
install(rec, fake_ollama())
emb.search(SPACE, "alice at acme", kind=emb.KIND_RELATIONSHIP, attributive_label="WORKS_AT")
cypher, params = rec.matching("db.index.vector.queryRelationships")[0]
check("relationship search uses the relationship index", params["index"] == emb.RELATIONSHIP_VECTOR_INDEX)
check(
    "relationship search filters on the relationship",
    "WHERE relationship.attributive_label = $al" in cypher,
)

rec = CypherRecorder()
install(rec, fake_ollama())
for bad_k in (0, -1, emb.SEARCH_MAX_K + 1, "many"):
    try:
        emb.search(SPACE, "text", k=bad_k)
        check(f"search rejects k={bad_k!r}", False)
    except ValueError:
        check(f"search rejects k={bad_k!r}", True)
try:
    emb.search(SPACE, "   ")
    check("search rejects empty text", False)
except ValueError:
    check("search rejects empty text", True)
try:
    emb.search(SPACE, "text", kind="chunk")
    check("search rejects an unknown kind", False)
except ValueError:
    check("search rejects an unknown kind", True)

rec = CypherRecorder()
install(rec, fake_ollama(fail_records=True))
try:
    emb.search(SPACE, "unreachable")
    check("search fails when Ollama is down (never empty results)", False)
except emb.EmbeddingsUnavailable:
    check("search fails when Ollama is down (never empty results)", True)
check("failed search touched no index", rec.calls == [])

# --- Ollama response handling ----------------------------------------------
check(
    "reads the /api/embed embeddings shape",
    emb._vector_from_response({"embeddings": [[1.0, 2.0]]}) == [1.0, 2.0],
)
check(
    "reads the legacy single-vector shape",
    emb._vector_from_response({"embedding": [3.0]}) == [3.0],
)
try:
    emb._vector_from_response({"model": "not-an-embedding-model"})
    check("a response with no vector is an error", False)
except emb.EmbeddingsUnavailable:
    check("a response with no vector is an error", True)

os.environ["PONA_FLOW_OLLAMA_EMBED_MODEL"] = ""
try:
    emb.embed_text("text")
    check("embedding without a configured model is rejected", False)
except ValueError:
    check("embedding without a configured model is rejected", True)
os.environ["PONA_FLOW_OLLAMA_EMBED_MODEL"] = "test-embed"

print()
if failures:
    print(f"embeddings-vector-search: {len(failures)} FAILED")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("embeddings-vector-search: ok")
