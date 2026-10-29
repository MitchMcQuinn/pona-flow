"""
Diagnostic test for the Gemini-compatible embedding provider.

Covers:
  - a saved blob with no provider stays local Ollama (also asserted in
    embeddings-space-config.py);
  - validate_cloud_embed_url: https only, no query string or userinfo, public hosts
    only unless PONA_FLOW_EMBED_ALLOWED_HOSTS names one (that host may be private).
    PONA_FLOW_ALLOW_PRIVATE_OUTBOUND does not widen this. DNS is stubbed;
  - embedContent request shape: x-goog-api-key header, embedding.values, embedding-2
    prompt prefixes with no taskType, gemini-embedding-001 taskType, a model id with
    a slash rejected;
  - the API key is absent from the saved column and from health;
  - a missing credential is rejected before any index is created;
  - switching provider or the cloud base URL clears vectors; an Ollama URL-only
    change and a credential-only change do not.

No database or network: the catalog column, Neo4j, DNS, and HTTP are stubbed.

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/embeddings-cloud-provider.py
"""

import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ["PONA_FLOW_OLLAMA_URL"] = "http://127.0.0.1:11434"
os.environ["PONA_FLOW_OLLAMA_EMBED_MODEL"] = "env-model"
for _key in (
    "PONA_FLOW_OLLAMA_ALLOWED_HOSTS",
    "PONA_FLOW_EMBED_PROVIDER",
    "PONA_FLOW_EMBED_MODEL",
    "PONA_FLOW_EMBED_BASE_URL",
    "PONA_FLOW_EMBED_API_KEY",
    "PONA_FLOW_EMBED_ALLOWED_HOSTS",
    "PONA_FLOW_ALLOW_PRIVATE_OUTBOUND",
):
    os.environ.pop(_key, None)

from Engine.server import embeddings as emb  # noqa: E402
from Engine.server import spaces  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


SPACE = "TEST_SPACE"
SECRET = "super-secret-token"
GOOGLE = "https://generativelanguage.googleapis.com/v1beta"
OTHER = "https://embeddings.example.com/v1beta"
VECTOR = [0.25, 0.5, 0.75, 1.0]


class CypherRecorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(
        self, space_id: str, cypher: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.calls.append((cypher, dict(params or {})))
        return {"records": [{"c": 2}]}

    def matching(self, needle: str) -> list[str]:
        return [c[0] for c in self.calls if needle in c[0]]


class ConfigStore:
    def __init__(self, initial: dict[str, Any] | None = None) -> None:
        self.value: dict[str, Any] = dict(initial or {})

    def fetch(self, space_id: str) -> dict[str, Any]:
        return dict(self.value)

    def write(self, space_id: str, cfg: dict[str, Any]) -> dict[str, Any]:
        self.value = spaces.parse_space_embeddings_config(
            spaces.format_space_embeddings_config(cfg)
        )
        return dict(self.value)


posts: list[dict[str, Any]] = []
_dns_addr = "8.8.8.8"
_keys = {"GEMINI": SECRET, "OTHER": SECRET}


def public_dns(host: str, port: int, *args: Any, **kwargs: Any) -> list[Any]:
    return [(2, 1, 6, "", (_dns_addr, port or 443))]


def post_json(
    url: str, payload: dict[str, Any], headers: dict[str, str], *, service: str
) -> dict[str, Any]:
    posts.append(
        {"url": url, "payload": payload, "headers": dict(headers), "service": service}
    )
    return {"embedding": {"values": list(VECTOR)}}


def resolve_key(space_id: str, name: str) -> str | None:
    return _keys.get(name)


def install(store: ConfigStore, recorder: CypherRecorder) -> None:
    posts.clear()
    emb.spaces.fetch_space_embeddings_config = store.fetch  # type: ignore[assignment]
    emb.spaces.write_space_embeddings_config = store.write  # type: ignore[assignment]
    emb.graph.run_cypher_for_space = recorder  # type: ignore[assignment]
    emb.socket.getaddrinfo = public_dns  # type: ignore[assignment]
    emb._post_json = post_json  # type: ignore[assignment]
    emb._call_ollama = lambda path, payload, base_url=None: {  # type: ignore[assignment]
        "embeddings": [list(VECTOR)]
    }
    emb.credentials.resolve = resolve_key  # type: ignore[assignment]


def raises_value(fn) -> bool:
    try:
        fn()
    except ValueError:
        return True
    return False


# --- cloud URL policy -------------------------------------------------------
install(ConfigStore(), CypherRecorder())

for blocked in (
    "http://generativelanguage.googleapis.com/v1beta",
    "https://127.0.0.1/v1beta",
    "https://10.0.0.5/v1beta",
    "https://169.254.169.254/v1beta",
    "https://localhost/v1beta",
    "https://generativelanguage.googleapis.com/v1beta?key=secret",
    "https://user:pass@generativelanguage.googleapis.com/v1beta",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    "",
):
    check(f"cloud URL {blocked!r} rejected", raises_value(lambda blocked=blocked: emb.validate_cloud_embed_url(blocked)))

os.environ["PONA_FLOW_ALLOW_PRIVATE_OUTBOUND"] = "1"
check(
    "private-outbound flag does not allow a cloud link-local host",
    raises_value(lambda: emb.validate_cloud_embed_url("https://169.254.169.254/v1")),
)
os.environ.pop("PONA_FLOW_ALLOW_PRIVATE_OUTBOUND", None)

check(
    "a public https API root is accepted",
    emb.validate_cloud_embed_url(GOOGLE + "/") == GOOGLE,
)

_dns_addr = "10.1.2.3"
check(
    "a hostname that resolves to a private address is rejected",
    raises_value(lambda: emb.validate_cloud_embed_url("https://embeddings.example.com/v1beta")),
)
_dns_addr = "8.8.8.8"

os.environ["PONA_FLOW_EMBED_ALLOWED_HOSTS"] = "embeddings.internal"

def dns_must_not_run(host: str, port: int, *args: Any, **kwargs: Any) -> list[Any]:
    raise AssertionError("allowlisted hosts are not resolved")


emb.socket.getaddrinfo = dns_must_not_run  # type: ignore[assignment]
check(
    "an allowlisted host is accepted without a public-address check",
    emb.validate_cloud_embed_url("https://embeddings.internal/v1beta")
    == "https://embeddings.internal/v1beta",
)
check(
    "a host outside the cloud allowlist is rejected",
    raises_value(lambda: emb.validate_cloud_embed_url(GOOGLE)),
)
os.environ.pop("PONA_FLOW_EMBED_ALLOWED_HOSTS", None)
emb.socket.getaddrinfo = public_dns  # type: ignore[assignment]

# --- request shape ----------------------------------------------------------
def gemini_cfg(model: str) -> dict[str, Any]:
    return {
        "provider": "gemini",
        "base_url": GOOGLE,
        "embed_model": model,
        "credential": "GEMINI",
        "source": "space",
        "space_id": SPACE,
    }


posts.clear()
vector = emb.embed_text("hello", gemini_cfg("gemini-embedding-2"), purpose=emb.PURPOSE_DOCUMENT)
doc = posts[-1]
check("embedding.values is the vector", vector == VECTOR)
check(
    "embedding-2 documents use the title prefix",
    doc["payload"]["content"]["parts"][0]["text"] == "title: none | text: hello",
)
check("embedding-2 sends no taskType", "taskType" not in doc["payload"])
check(
    "the embedContent path names the model",
    doc["url"] == f"{GOOGLE}/models/gemini-embedding-2:embedContent",
)
check("the API key is the x-goog-api-key header", doc["headers"].get("x-goog-api-key") == SECRET)
check("the API key is not in the URL", SECRET not in doc["url"] and "key=" not in doc["url"])

posts.clear()
emb.embed_text("find this", gemini_cfg("gemini-embedding-2"), purpose=emb.PURPOSE_QUERY)
query = posts[-1]["payload"]
check(
    "embedding-2 queries use the search-result prefix",
    query["content"]["parts"][0]["text"] == "task: search result | query: find this",
)
check("embedding-2 queries send no taskType", "taskType" not in query)

posts.clear()
emb.embed_text("record", gemini_cfg("gemini-embedding-001"), purpose=emb.PURPOSE_DOCUMENT)
older = posts[-1]["payload"]
check("gemini-embedding-001 sends the raw document text", older["content"]["parts"][0]["text"] == "record")
check("gemini-embedding-001 documents use RETRIEVAL_DOCUMENT", older.get("taskType") == "RETRIEVAL_DOCUMENT")

posts.clear()
emb.embed_text("q", gemini_cfg("gemini-embedding-001"), purpose=emb.PURPOSE_QUERY)
check(
    "gemini-embedding-001 queries use RETRIEVAL_QUERY",
    posts[-1]["payload"].get("taskType") == "RETRIEVAL_QUERY",
)

before = len(posts)
check(
    "a model id with a slash is rejected",
    raises_value(lambda: emb.embed_text("x", gemini_cfg("gemini/embedding"))),
)
check("a rejected model id makes no request", len(posts) == before)


def leak(url: str, payload: dict[str, Any], headers: dict[str, str], *, service: str) -> dict[str, Any]:
    raise emb.EmbeddingsUnavailable(f"upstream echoed {headers['x-goog-api-key']}")


emb._post_json = leak  # type: ignore[assignment]
try:
    emb.embed_text("hello", gemini_cfg("gemini-embedding-2"))
    check("a reflected API key is removed from the error", False)
except emb.EmbeddingsUnavailable as e:
    check("a reflected API key is removed from the error", SECRET not in str(e) and "[redacted]" in str(e))
emb._post_json = post_json  # type: ignore[assignment]

# --- save: credential, identity, no secret in the column --------------------
store, rec = ConfigStore(), CypherRecorder()
install(store, rec)
try:
    emb.apply_space_config(
        SPACE,
        enabled=True,
        provider="gemini",
        embed_model="gemini-embedding-2",
        credential="MISSING",
        base_url=GOOGLE,
    )
    check("enabling cloud without a configured credential is rejected", False)
except ValueError as e:
    check(
        "enabling cloud without a configured credential is rejected",
        "MISSING" in str(e) and SECRET not in str(e),
    )
check("a rejected cloud save creates no index", rec.matching("CREATE VECTOR INDEX") == [])

store, rec = ConfigStore(), CypherRecorder()
install(store, rec)
result = emb.apply_space_config(
    SPACE,
    enabled=True,
    provider="gemini",
    embed_model="gemini-embedding-2",
    credential="GEMINI",
    base_url="",
)
blob = json.dumps(store.value)
check("a blank cloud URL is saved as the Google root", store.value.get("base_url") == GOOGLE)
check("the credential name is saved", result.get("credential") == "GEMINI")
check("the API key is not in the saved settings", SECRET not in blob)
health = emb.health(SPACE)
check("the API key is not in the health payload", SECRET not in json.dumps(health))
check("health reports the credential as configured", health.get("credential_configured") is True)

store, rec = ConfigStore(
    {
        "enabled": True,
        "provider": "ollama",
        "ollama_url": "http://127.0.0.1:11434",
        "embed_model": "same-model",
        "dimensions": 4,
    }
), CypherRecorder()
install(store, rec)
result = emb.apply_space_config(
    SPACE,
    enabled=True,
    provider="gemini",
    embed_model="same-model",
    credential="GEMINI",
    base_url=GOOGLE,
)
check("switching provider is an embedding-identity change", result["model_changed"] is True)
check("switching provider drops the indexes", len(rec.matching("DROP INDEX")) == 2)
check(
    "switching provider clears stored vectors",
    len(rec.matching(f"REMOVE n.`{emb.EMBEDDING_PROPERTY}`")) == 1,
)

store, rec = ConfigStore(
    {
        "enabled": True,
        "provider": "gemini",
        "base_url": GOOGLE,
        "embed_model": "gemini-embedding-2",
        "credential": "GEMINI",
        "dimensions": 4,
    }
), CypherRecorder()
install(store, rec)
result = emb.apply_space_config(
    SPACE,
    enabled=True,
    provider="gemini",
    embed_model="gemini-embedding-2",
    credential="GEMINI",
    base_url=OTHER,
)
check("changing the cloud base URL clears vectors", result["model_changed"] is True)
check("changing the cloud base URL drops the indexes", len(rec.matching("DROP INDEX")) == 2)

store, rec = ConfigStore(
    {
        "enabled": True,
        "provider": "gemini",
        "base_url": GOOGLE,
        "embed_model": "gemini-embedding-2",
        "credential": "GEMINI",
        "dimensions": 4,
    }
), CypherRecorder()
install(store, rec)
result = emb.apply_space_config(
    SPACE,
    enabled=True,
    provider="gemini",
    embed_model="gemini-embedding-2",
    credential="OTHER",
    base_url=GOOGLE,
)
check("changing only the credential keeps the vectors", result["model_changed"] is False)
check("changing only the credential does not drop indexes", rec.matching("DROP INDEX") == [])

store, rec = ConfigStore(
    {
        "enabled": True,
        "provider": "ollama",
        "ollama_url": "http://127.0.0.1:11434",
        "embed_model": "nomic-embed-text",
        "dimensions": 4,
    }
), CypherRecorder()
install(store, rec)
result = emb.apply_space_config(
    SPACE,
    enabled=True,
    provider="ollama",
    ollama_url="http://localhost:11434",
    embed_model="nomic-embed-text",
)
check("changing only the Ollama URL is not an identity change", result["model_changed"] is False)
check("changing only the Ollama URL keeps the vectors", rec.matching("DROP INDEX") == [])

print()
if failures:
    print(f"embeddings-cloud-provider: {len(failures)} FAILED")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("embeddings-cloud-provider: ok")
