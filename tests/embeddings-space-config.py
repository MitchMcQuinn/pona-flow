"""
Diagnostic test for per-space vector-search settings.

Covers:
  - spaces.parse_space_embeddings_config / format_space_embeddings_config round trip,
    including the "never configured" ({}) and corrupt-JSON cases;
  - embeddings.validate_ollama_url: loopback only, unless PONA_FLOW_OLLAMA_ALLOWED_HOSTS
    widens it (the engine calls this URL itself, which is the position D7's SSRF guard
    protects for endpoint STEPs);
  - embeddings.resolve_config precedence: instance env vars until a space saves its own;
  - embeddings.apply_space_config index lifecycle — probe then create on enable, drop and
    clear vectors on disable, drop/clear/recreate on a model change (a dimension is baked
    into a Neo4j index and two models' vectors are not comparable);
  - reindex and search refusing to run while the space has embeddings disabled.

No database or network needed: the catalog column and Neo4j are both stubbed.

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/embeddings-space-config.py
"""

import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ["PONA_FLOW_OLLAMA_URL"] = "http://127.0.0.1:11434"
os.environ["PONA_FLOW_OLLAMA_EMBED_MODEL"] = "env-model"
os.environ.pop("PONA_FLOW_OLLAMA_ALLOWED_HOSTS", None)

from Engine.server import embeddings as emb  # noqa: E402
from Engine.server import spaces  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


SPACE = "TEST_SPACE"
VECTOR = [0.5] * 4

# --- catalog column parse / format -----------------------------------------
check("unset column reads as never-configured", spaces.parse_space_embeddings_config(None) == {})
check("blank column reads as never-configured", spaces.parse_space_embeddings_config("  ") == {})
check("empty object reads as never-configured", spaces.parse_space_embeddings_config("{}") == {})
check(
    "corrupt JSON reads as never-configured",
    spaces.parse_space_embeddings_config("{not json") == {},
)

stored = spaces.parse_space_embeddings_config(
    spaces.format_space_embeddings_config(
        {
            "enabled": True,
            "ollama_url": "http://127.0.0.1:11434",
            "embed_model": "nomic-embed-text",
            "dimensions": 768,
        }
    )
)
check(
    "settings round trip through the column",
    stored
    == {
        "enabled": True,
        "ollama_url": "http://127.0.0.1:11434",
        "embed_model": "nomic-embed-text",
        "dimensions": 768,
    },
)
check(
    "a non-numeric dimension is discarded, not stored",
    spaces.parse_space_embeddings_config('{"enabled":true,"dimensions":"wide"}')["dimensions"]
    is None,
)

# --- Ollama URL policy ------------------------------------------------------
for allowed in (
    "http://127.0.0.1:11434",
    "http://localhost:11434",
    "https://127.0.0.1:11434",
    "http://[::1]:11434",
):
    try:
        emb.validate_ollama_url(allowed)
        check(f"loopback URL {allowed} accepted", True)
    except ValueError:
        check(f"loopback URL {allowed} accepted", False)

check("trailing slash is normalized away", emb.validate_ollama_url("http://127.0.0.1:11434/") == "http://127.0.0.1:11434")

for blocked in (
    "http://ollama.example.com:11434",
    "http://10.0.0.5:11434",
    "http://169.254.169.254",
    "ftp://127.0.0.1",
    "file:///etc/passwd",
    "",
):
    try:
        emb.validate_ollama_url(blocked)
        check(f"URL {blocked!r} rejected", False)
    except ValueError:
        check(f"URL {blocked!r} rejected", True)

os.environ["PONA_FLOW_OLLAMA_ALLOWED_HOSTS"] = "ollama.internal, gpu-box"
try:
    check(
        "an operator allowlist widens the policy",
        emb.validate_ollama_url("http://ollama.internal:11434") == "http://ollama.internal:11434",
    )
except ValueError:
    check("an operator allowlist widens the policy", False)
try:
    emb.validate_ollama_url("http://other.internal:11434")
    check("a host outside the allowlist is still rejected", False)
except ValueError:
    check("a host outside the allowlist is still rejected", True)
os.environ.pop("PONA_FLOW_OLLAMA_ALLOWED_HOSTS", None)


# --- stubs ------------------------------------------------------------------
class CypherRecorder:
    def __init__(self, count: int = 0) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.count = count

    def __call__(
        self, space_id: str, cypher: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.calls.append((cypher, dict(params or {})))
        return {"records": [{"c": self.count}]}

    def matching(self, needle: str) -> list[str]:
        return [c[0] for c in self.calls if needle in c[0]]


class ConfigStore:
    """In-memory stand-in for the spaces.embeddings_config column."""

    def __init__(self, initial: dict[str, Any] | None = None) -> None:
        self.value: dict[str, Any] = dict(initial or {})

    def fetch(self, space_id: str) -> dict[str, Any]:
        return dict(self.value)

    def write(self, space_id: str, cfg: dict[str, Any]) -> dict[str, Any]:
        self.value = spaces.parse_space_embeddings_config(
            spaces.format_space_embeddings_config(cfg)
        )
        return dict(self.value)


def install(store: ConfigStore, recorder: CypherRecorder, dims: int = len(VECTOR)) -> None:
    emb.spaces.fetch_space_embeddings_config = store.fetch  # type: ignore[assignment]
    emb.spaces.write_space_embeddings_config = store.write  # type: ignore[assignment]
    emb.graph.run_cypher_for_space = recorder  # type: ignore[assignment]
    emb._call_ollama = lambda path, payload, base_url=None: {  # type: ignore[assignment]
        "embeddings": [[0.5] * dims]
    }


# --- resolve_config precedence ---------------------------------------------
install(ConfigStore(), CypherRecorder())
cfg = emb.resolve_config(SPACE)
check("an unconfigured space inherits the instance env vars", cfg["source"] == "env")
check("env model is used", cfg["embed_model"] == "env-model")
check("env config is enabled when a model is set", cfg["enabled"] is True)

install(
    ConfigStore(
        {"enabled": True, "ollama_url": "", "embed_model": "space-model", "dimensions": 768}
    ),
    CypherRecorder(),
)
cfg = emb.resolve_config(SPACE)
check("saved settings take precedence", cfg["source"] == "space")
check("saved model wins over the env model", cfg["embed_model"] == "space-model")
check("a blank saved URL falls back to the env URL", cfg["ollama_url"] == "http://127.0.0.1:11434")
check("the probed dimension is carried through", cfg["dimensions"] == 768)

install(ConfigStore({"enabled": False, "embed_model": "space-model"}), CypherRecorder())
check("a space can opt out even when the env is configured", emb.resolve_config(SPACE)["enabled"] is False)

# --- enable: probe, then create --------------------------------------------
store, rec = ConfigStore(), CypherRecorder()
install(store, rec)
result = emb.apply_space_config(SPACE, enabled=True, embed_model="nomic-embed-text")
check("enabling probes and stores the model width", result["dimensions"] == len(VECTOR))
check("enabling persists the model", store.value["embed_model"] == "nomic-embed-text")
check("enabling creates the node index", len(rec.matching(f"CREATE VECTOR INDEX {emb.NODE_VECTOR_INDEX}")) == 1)
check(
    "enabling creates the relationship index",
    len(rec.matching(f"CREATE VECTOR INDEX {emb.RELATIONSHIP_VECTOR_INDEX}")) == 1,
)
check("enabling does not drop anything", rec.matching("DROP INDEX") == [])
check("enabling does not clear stored vectors", rec.matching(f"REMOVE n.`{emb.EMBEDDING_PROPERTY}`") == [])
store2, rec2 = ConfigStore(), CypherRecorder()
install(store2, rec2)
try:
    emb.apply_space_config(SPACE, enabled=True, embed_model="")
    check("enabling with no model is rejected", False)
except ValueError:
    check("enabling with no model is rejected", True)

# --- disable: drop and clear -----------------------------------------------
store, rec = ConfigStore(
    {"enabled": True, "embed_model": "nomic-embed-text", "dimensions": 4}
), CypherRecorder(count=3)
install(store, rec)
result = emb.apply_space_config(SPACE, enabled=False)
check("disabling drops both indexes", len(rec.matching("DROP INDEX")) == 2)
check(
    "disabling removes stored node vectors",
    len(rec.matching(f"REMOVE n.`{emb.EMBEDDING_PROPERTY}`")) == 1,
)
check(
    "disabling marks cleared records stale",
    all(
        f"SET n.`{emb.EMBEDDING_STALE_PROPERTY}` = true" in stmt
        for stmt in rec.matching(f"REMOVE n.`{emb.EMBEDDING_PROPERTY}`")
    ),
)
check(
    "clearing relationship vectors stays INSTANCE-scoped",
    all(
        "(:INSTANCE)-[r:POINTS_TO]->(:INSTANCE)" in stmt
        for stmt in rec.matching(f"REMOVE r.`{emb.EMBEDDING_PROPERTY}`")
    ),
)
check("disabling reports what it cleared", result.get("cleared", {}).get("nodes") == 3)
check("disabling forgets the dimension", store.value["dimensions"] is None)
check("disabling creates no index", rec.matching("CREATE VECTOR INDEX") == [])

# --- model change: drop, clear, recreate -----------------------------------
store, rec = ConfigStore(
    {"enabled": True, "embed_model": "old-model", "dimensions": 4}
), CypherRecorder(count=7)
install(store, rec)
result = emb.apply_space_config(SPACE, enabled=True, embed_model="new-model")
check("a model change is reported", result["model_changed"] is True)
check("a model change drops the old indexes", len(rec.matching("DROP INDEX")) == 2)
check(
    "a model change clears vectors of the old width",
    len(rec.matching(f"REMOVE n.`{emb.EMBEDDING_PROPERTY}`")) == 1,
)
check("a model change recreates the indexes", len(rec.matching("CREATE VECTOR INDEX")) == 2)

store, rec = ConfigStore(
    {"enabled": True, "embed_model": "same-model", "dimensions": 4}
), CypherRecorder()
install(store, rec)
result = emb.apply_space_config(SPACE, enabled=True, embed_model="same-model")
check("re-saving the same model is not a model change", result["model_changed"] is False)
check("re-saving the same model keeps the vectors", rec.matching("DROP INDEX") == [])

# --- a disabled space refuses to embed -------------------------------------
install(ConfigStore({"enabled": False, "embed_model": "m"}), CypherRecorder())
try:
    emb.search(SPACE, "anything")
    check("search refuses while embeddings are disabled", False)
except ValueError as e:
    check("search refuses while embeddings are disabled", "not enabled" in str(e))
try:
    emb.reindex_label(SPACE, "CUSTOMER")
    check("reindex refuses while embeddings are disabled", False)
except ValueError as e:
    check("reindex refuses while embeddings are disabled", "not enabled" in str(e))

print()
if failures:
    print(f"embeddings-space-config: {len(failures)} FAILED")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("embeddings-space-config: ok")
