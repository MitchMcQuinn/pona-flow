"""
Vector search over INSTANCE records (Ollama or Gemini embeddings + Neo4j vector indexes).

Purpose in the project
----------------------
Semantic find for graph data: serialize an INSTANCE record to text, embed it, and store
the vector on the record itself so a similarity query returns the graph nodes/relationships
directly. Sequences take those hits and traverse ``POINTS_TO`` as usual — "find similar,
then traverse" is two steps, not one read.

The default embedder is a local Ollama. A space can instead use a Gemini-compatible
``embedContent`` host. Either way the engine makes the call itself: sequence endpoint
STEPs stay behind the D7 SSRF guard and never see the API key.

Design constraints (see README.md § Vector search)
-----------------------------------------------------
- **Neo4j holds the vectors.** No sidecar vector database, so a hit *is* the record.
  Because every data node is ``:INSTANCE`` and every data edge is ``:POINTS_TO``, a space
  gets **one** node index and **one** relationship index, which forces a single embedding
  model (and therefore a single dimension) per space.
- **The engine owns the embedder call.** Ollama listens on localhost, which the D7 SSRF
  guard blocks for sequence endpoint STEPs. A cloud host is the inverse: https, and public
  unless the operator allowlists it. The API key is a credential name, resolved at call
  time and never stored in the space config.
- **Relationship work is INSTANCE-scoped.** ``POINTS_TO`` also carries STEP and SCHEMA
  pattern edges; every relationship statement here matches
  ``(:INSTANCE)-[:POINTS_TO]->(:INSTANCE)`` only, the same guard ``schema_currency`` uses.
- **Opt-in twice.** A SCHEMA opts in with ``is_vectorized``, and each property opts into the
  embedded text with ``is_embedded`` (falling back to the display label). Embedding every
  field of every type is the fastest way to make similarity results look random.
- **Long records are truncated, not summarized.** One vector per record.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from typing import Any

from . import config, credentials, cypher_utils, graph, spaces

# Reserved system properties, written here and nowhere else. Never authorable in a SCHEMA's
# ``schemata[]`` (see App/authoring/src/schemaRules.ts and schema_update.validate_schema_update)
# and never set from the builder. The vector's name is owned by ``graph`` because that module
# has to strip it from query results.
EMBEDDING_PROPERTY = graph.EMBEDDING_PROPERTY
EMBEDDING_STALE_PROPERTY = "embedding_stale"

# One shared index per kind per space (the 3-label ontology cannot give each SCHEMA
# its own index or its own model).
NODE_VECTOR_INDEX = "instance_embedding"
RELATIONSHIP_VECTOR_INDEX = "instance_rel_embedding"

SIMILARITY_FUNCTION = "cosine"

# Neo4j's documented ceiling for vector index dimensions.
MAX_VECTOR_DIMENSIONS = 4096

KIND_NODE = "node"
KIND_RELATIONSHIP = "relationship"

# Serialized text is truncated at this length rather than summarized: v1 keeps exactly
# one vector per record, so an over-long NOTES field loses its tail instead of spawning
# chunk nodes.
TEXT_MAX_CHARS = 6000

_OLLAMA_TIMEOUT_SECONDS = 60
# A 1024-float vector is ~20 KB of JSON; this only guards against a wrong endpoint
# streaming something enormous back.
_OLLAMA_RESPONSE_MAX_BYTES = 8 * 1024 * 1024

# Reindex reads a page at a time (each record costs one embed round trip) and refuses to
# run forever on a huge label.
REINDEX_PAGE_SIZE = 50
REINDEX_MAX_RECORDS = 5000
# The embedder going away mid-run should stop the loop, not retry thousands of times.
_REINDEX_MAX_CONSECUTIVE_FAILURES = 5

# Label filtering happens *after* the index returns its nearest neighbours, so ask for
# more than k: the shared :INSTANCE index mixes every vectorized type together, and
# without overfetch a k of 10 can come back entirely of the wrong type.
SEARCH_OVERFETCH_FACTOR = 10
SEARCH_MAX_OVERFETCH = 1000
SEARCH_DEFAULT_K = 10
SEARCH_MAX_K = 100

# Named endpoints (schema_currency uses anonymous ones) because relationship text is
# built from the endpoints' display labels.
_INSTANCE_REL_MATCH = "(a:INSTANCE)-[r:POINTS_TO {attributive_label: $al}]->(b:INSTANCE)"

_escape_identifier = cypher_utils.escape_identifier

PROVIDER_OLLAMA = "ollama"
PROVIDER_GEMINI = "gemini"

# Reindex and the dimension probe embed records. Search embeds the query text. Gemini
# wants those two purposes wrapped differently; the difference does not change the index.
PURPOSE_DOCUMENT = "document"
PURPOSE_QUERY = "query"

# The model id is placed in the embedContent path, so it cannot carry a slash or colon.
_GEMINI_MODEL_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class EmbeddingsUnavailable(RuntimeError):
    """The embedding provider could not be reached, or answered with something unusable."""


# ---------------------------------------------------------------------------
# Space configuration
# ---------------------------------------------------------------------------


def allowed_ollama_hosts() -> list[str]:
    """Extra hosts a space manager may point at (``PONA_FLOW_OLLAMA_ALLOWED_HOSTS``).

    Empty by default, which restricts the configurable URL to loopback.
    """
    raw = (os.environ.get("PONA_FLOW_OLLAMA_ALLOWED_HOSTS") or "").strip()
    return [host.strip().lower() for host in raw.split(",") if host.strip()]


def validate_ollama_url(url: str) -> str:
    """Accept only an http(s) loopback URL (or an explicitly allowlisted host).

    The write path calls this URL from inside the engine, which is exactly the position
    D7's SSRF guard protects for sequence endpoint STEPs. A space manager must therefore
    not be able to aim it at an arbitrary internal address; widening it is an operator
    decision made through the environment, not a per-space setting.
    """
    text = (url or "").strip().rstrip("/")
    if not text:
        raise ValueError("Ollama URL is required")
    parts = urllib.parse.urlsplit(text)
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"Ollama URL scheme {parts.scheme!r} is not allowed (use http/https).")
    host = (parts.hostname or "").strip()
    if not host:
        raise ValueError("Ollama URL host is missing.")
    if host.lower() in allowed_ollama_hosts():
        return text
    if host.lower() == "localhost":
        return text
    try:
        if ipaddress.ip_address(host).is_loopback:
            return text
    except ValueError:
        pass
    raise ValueError(
        f"Ollama host {host!r} is not allowed. Vector search runs against a local Ollama; "
        "set PONA_FLOW_OLLAMA_ALLOWED_HOSTS to permit another host."
    )


def allowed_embed_hosts() -> list[str]:
    """Hosts a cloud embedding URL may use (``PONA_FLOW_EMBED_ALLOWED_HOSTS``).

    Empty means any public https host. A listed host may be private: that is how an
    operator names an internal Gemini-compatible server. This does not consult
    ``PONA_FLOW_ALLOW_PRIVATE_OUTBOUND``.
    """
    raw = (os.environ.get("PONA_FLOW_EMBED_ALLOWED_HOSTS") or "").strip()
    return [host.strip().lower() for host in raw.split(",") if host.strip()]


def _ip_is_blocked(addr: str) -> bool:
    """True when ``addr`` is an IP that must not be used as a public cloud host.

    A hostname (not an IP literal) is not blocked here; the caller resolves it.
    An address that does not parse as an IP is treated as blocked, which is the
    safe answer for a resolved sockaddr that is somehow not an IP.
    """
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return True
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _host_literal_is_blocked(host: str) -> bool:
    """True for localhost and for IP literals that are not public. Hostnames pass."""
    if host.lower().rstrip(".") == "localhost":
        return True
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return _ip_is_blocked(host)


def validate_cloud_embed_url(url: str) -> str:
    """Accept an https Gemini-compatible API root, public unless the operator allowlists it.

    The client appends ``/models/{model}:embedContent``, so a URL that already names that
    method is rejected. Credentials and query strings are rejected too: the API key travels
    in a header, never in the URL.
    """
    text = (url or "").strip().rstrip("/")
    if not text:
        raise ValueError("Cloud embedding URL is required")
    if text.endswith(":embedContent"):
        raise ValueError(
            "Cloud embedding URL is the API root, not the embedContent method "
            "(for example https://generativelanguage.googleapis.com/v1beta)."
        )
    parts = urllib.parse.urlsplit(text)
    if parts.scheme != "https":
        raise ValueError(
            f"Cloud embedding URL scheme {parts.scheme!r} is not allowed (use https)."
        )
    if parts.username or parts.password:
        raise ValueError("Cloud embedding URL must not include credentials.")
    if parts.query or parts.fragment:
        raise ValueError("Cloud embedding URL must not include a query string.")
    host = (parts.hostname or "").strip()
    if not host:
        raise ValueError("Cloud embedding URL host is missing.")

    allowlist = allowed_embed_hosts()
    if allowlist:
        if host.lower() not in allowlist:
            raise ValueError(
                f"Cloud embedding host {host!r} is not in PONA_FLOW_EMBED_ALLOWED_HOSTS."
            )
        return text

    if _host_literal_is_blocked(host):
        raise ValueError(f"Cloud embedding host {host!r} is not a public address.")

    port = parts.port or 443
    try:
        infos = socket.getaddrinfo(host, port)
    except socket.gaierror as e:
        raise ValueError(f"Could not resolve cloud embedding host {host!r}: {e}") from e
    for info in infos:
        addr = info[4][0]
        if _ip_is_blocked(addr):
            raise ValueError(
                f"Cloud embedding host {host!r} resolves to a blocked address ({addr})."
            )
    return text


def validate_gemini_model(model: str) -> str:
    """Accept a Gemini model id that is safe to interpolate into the embedContent path."""
    text = (model or "").strip()
    if not text:
        raise ValueError("An embedding model is required to enable vector search.")
    if not _GEMINI_MODEL_RE.fullmatch(text):
        raise ValueError(
            "Gemini model id must contain only letters, digits, dots, underscores, and hyphens."
        )
    return text


def _normalize_provider(value: Any) -> str:
    """Map a missing or unknown provider to local Ollama."""
    text = str(value or "").strip().lower()
    if text == PROVIDER_GEMINI:
        return PROVIDER_GEMINI
    return PROVIDER_OLLAMA


def _require_provider(value: Any) -> str:
    """Accept only the two providers a space manager can save."""
    text = str(value or "").strip().lower()
    if text in (PROVIDER_OLLAMA, PROVIDER_GEMINI):
        return text
    raise ValueError(
        f"Embedding provider {text!r} is not supported (use ollama or gemini)."
    )


def env_config() -> dict[str, Any]:
    """Instance-level fallback used by a space that has never saved settings."""
    provider = config.embed_provider()
    if provider == PROVIDER_GEMINI:
        model = config.embed_model()
    else:
        provider = PROVIDER_OLLAMA
        model = config.embed_model() or config.ollama_embed_model()
    return {
        "enabled": bool(model),
        "provider": provider,
        "ollama_url": config.ollama_url(),
        "base_url": config.embed_base_url() if provider == PROVIDER_GEMINI else "",
        "embed_model": model,
        "credential": "",
        "dimensions": None,
        "source": "env",
    }


def resolve_config(space_id: str) -> dict[str, Any]:
    """The space's effective settings, falling back to the instance env vars.

    A space that never saved settings inherits the environment, so an operator can enable
    vector search instance-wide without touching every space. Once saved, the space's own
    ``enabled`` flag governs. ``space_id`` is attached for credential lookup and is not
    part of the stored column.
    """
    stored = spaces.fetch_space_embeddings_config(space_id)
    env = env_config()
    sid = (space_id or "").strip()
    if not stored:
        cfg = dict(env)
        cfg["space_id"] = sid
        return cfg
    provider = _normalize_provider(stored.get("provider"))
    stored_base = str(stored.get("base_url") or "").strip()
    if provider == PROVIDER_GEMINI:
        base_url = stored_base or env["base_url"] or config.embed_base_url()
    else:
        base_url = stored_base
    return {
        "enabled": bool(stored.get("enabled")),
        "provider": provider,
        "ollama_url": stored.get("ollama_url") or env["ollama_url"],
        "base_url": base_url,
        "embed_model": stored.get("embed_model") or env["embed_model"],
        "credential": str(stored.get("credential") or "").strip(),
        "dimensions": stored.get("dimensions"),
        "source": "space",
        "space_id": sid,
    }


def _require_enabled(cfg: dict[str, Any]) -> dict[str, Any]:
    if not cfg.get("enabled"):
        raise ValueError(
            "Vector search is not enabled for this space (enable it in the space's "
            "Embeddings settings)."
        )
    if not str(cfg.get("embed_model") or "").strip():
        raise ValueError("No embedding model is configured for this space.")
    return cfg


# ---------------------------------------------------------------------------
# Embedder clients. Ollama is loopback; Gemini is a public https host. Neither
# call goes through a sequence endpoint STEP, so D7 does not apply here.
# ---------------------------------------------------------------------------


def _error_detail(data: Any, status: int) -> str:
    """A short message from an Ollama string ``error`` or a Gemini ``error.message``."""
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            message = str(err.get("message") or "").strip()
            if message:
                return message
        if isinstance(err, str) and err.strip():
            return err.strip()
        if err not in (None, "", {}, []):
            text = str(err).strip()
            if text:
                return text
    return f"HTTP {status}"


def _redact(text: str, secret: str) -> str:
    if secret and secret in text:
        return text.replace(secret, "[redacted]")
    return text


def _post_json(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    *,
    service: str,
) -> dict[str, Any]:
    """POST JSON and return the parsed object. Transport failures become one exception type.

    ``headers`` may carry an API key. This function does not log them, and callers must
    not put the key in ``url``.
    """
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=_OLLAMA_TIMEOUT_SECONDS) as resp:
            raw = resp.read(_OLLAMA_RESPONSE_MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        try:
            body = e.read(_OLLAMA_RESPONSE_MAX_BYTES + 1)
        except Exception:  # noqa: BLE001 - error body is best-effort
            body = b""
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            data = {}
        detail = _error_detail(data, e.code)
        raise EmbeddingsUnavailable(f"{service} rejected the request: {detail}") from e
    except Exception as e:  # noqa: BLE001 - connection refused, DNS, timeout, ...
        raise EmbeddingsUnavailable(f"{service} is unavailable at {url}: {e}") from e
    if len(raw) > _OLLAMA_RESPONSE_MAX_BYTES:
        raise EmbeddingsUnavailable(f"{service} response exceeded the size limit")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise EmbeddingsUnavailable(f"Invalid {service} response (not JSON)") from e
    if not isinstance(data, dict):
        raise EmbeddingsUnavailable(f"Invalid {service} response (not an object)")
    return data


def _call_ollama(
    path: str, payload: dict[str, Any], base_url: str | None = None
) -> dict[str, Any]:
    """POST to the local Ollama API and return its parsed JSON object."""
    url = (base_url or config.ollama_url()).rstrip("/")
    return _post_json(
        f"{url}{path}",
        payload,
        {"Content-Type": "application/json"},
        service="Ollama",
    )


def _vector_from_response(data: dict[str, Any]) -> list[float]:
    """Read a single vector out of an ``/api/embed`` (or legacy) response."""
    embeddings = data.get("embeddings")
    if isinstance(embeddings, list) and embeddings:
        first = embeddings[0]
        if isinstance(first, list) and first:
            return [float(v) for v in first]
    # /api/embeddings (older single-vector shape) answers with "embedding" as a list.
    # Gemini's object-shaped ``embedding`` is handled by ``_vector_from_gemini``.
    legacy = data.get("embedding")
    if isinstance(legacy, list) and legacy:
        return [float(v) for v in legacy]
    raise EmbeddingsUnavailable("Ollama returned no embedding vector")


def _gemini_uses_prompt_prefix(model: str) -> bool:
    """``gemini-embedding-2`` rejects ``taskType`` and wants the task written into the text."""
    return "embedding-2" in model


def _gemini_text(text: str, model: str, purpose: str) -> tuple[str, str | None]:
    """Return ``(text to send, taskType or None)`` for one Gemini embed call."""
    if _gemini_uses_prompt_prefix(model):
        if purpose == PURPOSE_QUERY:
            return f"task: search result | query: {text}", None
        return f"title: none | text: {text}", None
    task = "RETRIEVAL_QUERY" if purpose == PURPOSE_QUERY else "RETRIEVAL_DOCUMENT"
    return text, task


def _gemini_endpoint(base_url: str, model: str) -> str:
    root = validate_cloud_embed_url(base_url)
    model_id = validate_gemini_model(model)
    return f"{root}/models/{urllib.parse.quote(model_id, safe='')}:embedContent"


def _vector_from_gemini(data: dict[str, Any]) -> list[float]:
    """Read ``embedding.values`` from an embedContent response."""
    embedding = data.get("embedding")
    if isinstance(embedding, dict):
        values = embedding.get("values")
        if isinstance(values, list) and values:
            return [float(v) for v in values]
    raise EmbeddingsUnavailable("Gemini returned no embedding vector")


def _embed_api_key(cfg: dict[str, Any]) -> str:
    """The cloud API key for this call. Never persist or log the return value."""
    if str(cfg.get("source") or "env") == "space":
        name = str(cfg.get("credential") or "").strip()
        if not name:
            raise EmbeddingsUnavailable(
                "A credential is required for the cloud embedding provider."
            )
        space_id = str(cfg.get("space_id") or "").strip()
        key = credentials.resolve(space_id, name) if space_id else None
        if not key:
            raise EmbeddingsUnavailable(
                f"Credential {name!r} is not configured for this space."
            )
        return key
    key = config.embed_api_key()
    if not key:
        raise EmbeddingsUnavailable(
            "No embedding API key is configured (set PONA_FLOW_EMBED_API_KEY)."
        )
    return key


def _call_gemini(
    base_url: str,
    model: str,
    text: str,
    api_key: str,
    *,
    purpose: str,
) -> dict[str, Any]:
    """POST embedContent. The key is an ``x-goog-api-key`` header, never a query parameter."""
    body_text, task_type = _gemini_text(text, model, purpose)
    payload: dict[str, Any] = {"content": {"parts": [{"text": body_text}]}}
    if task_type:
        payload["taskType"] = task_type
    try:
        return _post_json(
            _gemini_endpoint(base_url, model),
            payload,
            {"Content-Type": "application/json", "x-goog-api-key": api_key},
            service="Gemini",
        )
    except EmbeddingsUnavailable as e:
        redacted = _redact(str(e), api_key)
        if redacted != str(e):
            raise EmbeddingsUnavailable(redacted) from e
        raise


def _require_purpose(purpose: str) -> str:
    if purpose not in (PURPOSE_DOCUMENT, PURPOSE_QUERY):
        raise ValueError(f"Embedding purpose must be document or query, got {purpose!r}")
    return purpose


def embed_text(
    text: str,
    cfg: dict[str, Any] | None = None,
    *,
    purpose: str = PURPOSE_DOCUMENT,
) -> list[float]:
    """Embed one string with the configured provider.

    ``purpose`` is ``document`` for records and the dimension probe, and ``query`` for
    search text. Ollama ignores it. Gemini uses it to choose the retrieval wrapping.
    """
    settings = cfg or env_config()
    _require_purpose(purpose)
    model = str(settings.get("embed_model") or "").strip()
    provider = _normalize_provider(settings.get("provider"))
    if provider == PROVIDER_GEMINI:
        if not model:
            raise ValueError("No embedding model is configured (set PONA_FLOW_EMBED_MODEL).")
        validate_gemini_model(model)
        api_key = _embed_api_key(settings)
        base_url = str(settings.get("base_url") or "").strip() or config.embed_base_url()
        try:
            return _vector_from_gemini(
                _call_gemini(base_url, model, text, api_key, purpose=purpose)
            )
        except EmbeddingsUnavailable:
            raise
        except (TypeError, ValueError) as e:
            raise EmbeddingsUnavailable(
                _redact(f"Gemini returned a malformed vector: {e}", api_key)
            ) from e
    if not model:
        raise ValueError(
            "No embedding model is configured "
            "(set PONA_FLOW_OLLAMA_EMBED_MODEL to a model Ollama has pulled)."
        )
    payload = {"model": model, "input": text}
    try:
        return _vector_from_response(
            _call_ollama("/api/embed", payload, settings.get("ollama_url"))
        )
    except EmbeddingsUnavailable:
        raise
    except (TypeError, ValueError) as e:
        raise EmbeddingsUnavailable(f"Ollama returned a malformed vector: {e}") from e


def probe_dimensions(cfg: dict[str, Any] | None = None) -> int:
    """Embed a probe string to learn the model's vector width.

    Doubles as a model check: a generate/chat model does not answer with a vector, so
    this fails loudly instead of quietly building a wrong-width index. The probe is a
    document, the same wrapping reindex uses.
    """
    dims = len(embed_text("dimension probe", cfg, purpose=PURPOSE_DOCUMENT))
    if dims <= 0:
        raise EmbeddingsUnavailable("The embedding provider returned an empty vector")
    return dims


def _credential_configured(cfg: dict[str, Any]) -> bool:
    """Whether a cloud key can be resolved. The key itself is discarded."""
    if _normalize_provider(cfg.get("provider")) != PROVIDER_GEMINI:
        return False
    try:
        return bool(_embed_api_key(cfg))
    except (EmbeddingsUnavailable, ValueError):
        return False


def _public_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Settings safe to return from the API. No API key, no live secret."""
    return {
        "provider": _normalize_provider(cfg.get("provider")),
        "ollama_url": cfg.get("ollama_url") or "",
        "base_url": cfg.get("base_url") or "",
        "embed_model": cfg.get("embed_model") or "",
        "model": cfg.get("embed_model") or "",
        "credential": str(cfg.get("credential") or ""),
        "credential_configured": _credential_configured(cfg),
        "enabled": bool(cfg.get("enabled")),
        "source": cfg.get("source"),
        "dimensions": cfg.get("dimensions"),
    }


def health(space_id: str | None = None) -> dict[str, Any]:
    """Report whether the configured embedder answers, and the model's vector width.

    Returns the failure as data rather than raising, so the settings UI can render it as
    status instead of an error. ``credential_configured`` says a cloud key resolved; the
    key is not included.
    """
    try:
        cfg = resolve_config(space_id) if space_id else env_config()
    except ValueError as e:
        return {
            "ok": False,
            "error": str(e),
            "enabled": False,
            "dimensions": None,
            "provider": PROVIDER_OLLAMA,
            "credential_configured": False,
        }
    out = _public_config(cfg)
    out["ok"] = False
    out["error"] = None
    try:
        out["dimensions"] = probe_dimensions(cfg)
        out["ok"] = True
    except (EmbeddingsUnavailable, ValueError) as e:
        out["error"] = str(e)
    return out


# ---------------------------------------------------------------------------
# Vector index DDL
# ---------------------------------------------------------------------------


def _validate_dimensions(dimensions: Any) -> int:
    try:
        dims = int(dimensions)
    except (TypeError, ValueError) as e:
        raise ValueError(f"Vector dimensions must be an integer, got {dimensions!r}") from e
    if dims <= 0 or dims > MAX_VECTOR_DIMENSIONS:
        raise ValueError(
            f"Vector dimensions must be between 1 and {MAX_VECTOR_DIMENSIONS}, got {dims}"
        )
    return dims


def _create_index_cypher(name: str, target: str, var: str, dims: int) -> str:
    """Build ``CREATE VECTOR INDEX``.

    Index options cannot be parameterized, so the dimension is inlined — after
    ``_validate_dimensions`` has proven it is a plain integer.
    """
    ref = f"{var}.`{_escape_identifier(EMBEDDING_PROPERTY)}`"
    return (
        f"CREATE VECTOR INDEX {name} IF NOT EXISTS FOR {target} ON ({ref}) "
        "OPTIONS {indexConfig: {"
        f"`vector.dimensions`: {dims}, "
        f"`vector.similarity_function`: '{SIMILARITY_FUNCTION}'"
        "}}"
    )


def ensure_vector_indexes(space_id: str, dimensions: int) -> dict[str, bool]:
    """Create the space's shared node and relationship vector indexes (idempotent)."""
    dims = _validate_dimensions(dimensions)
    created: dict[str, bool] = {}
    for name, target, var in (
        (NODE_VECTOR_INDEX, "(n:INSTANCE)", "n"),
        (RELATIONSHIP_VECTOR_INDEX, "()-[r:POINTS_TO]-()", "r"),
    ):
        graph.run_cypher_for_space(space_id, _create_index_cypher(name, target, var, dims), {})
        created[name] = True
    return created


def drop_vector_indexes(space_id: str) -> dict[str, bool]:
    """Drop both vector indexes. Stored ``embedding`` values are left untouched."""
    dropped: dict[str, bool] = {}
    for name in (NODE_VECTOR_INDEX, RELATIONSHIP_VECTOR_INDEX):
        graph.run_cypher_for_space(space_id, f"DROP INDEX {name} IF EXISTS", {})
        dropped[name] = True
    return dropped


def clear_vectors(space_id: str) -> dict[str, int]:
    """Remove every stored vector, marking the records stale.

    Run when the model changes or the feature is switched off: vectors from a different
    model are not comparable (and may be the wrong width for the index), so they are
    deleted rather than left to poison results. ``embedding_stale`` remains as the record
    of what a later reindex still owes.
    """
    counts: dict[str, int] = {}
    statements = {
        "nodes": (
            f"MATCH (n:INSTANCE) WHERE n.`{EMBEDDING_PROPERTY}` IS NOT NULL "
            f"REMOVE n.`{EMBEDDING_PROPERTY}` "
            f"SET n.`{EMBEDDING_STALE_PROPERTY}` = true "
            "RETURN count(n) AS c"
        ),
        "relationships": (
            "MATCH (:INSTANCE)-[r:POINTS_TO]->(:INSTANCE) "
            f"WHERE r.`{EMBEDDING_PROPERTY}` IS NOT NULL "
            f"REMOVE r.`{EMBEDDING_PROPERTY}` "
            f"SET r.`{EMBEDDING_STALE_PROPERTY}` = true "
            "RETURN count(r) AS c"
        ),
    }
    for key, cypher in statements.items():
        out = graph.run_cypher_for_space(space_id, cypher, {})
        records = out.get("records") or []
        counts[key] = int(records[0].get("c") or 0) if records else 0
    return counts


def _pick_text(incoming: str | None, previous: Any) -> str:
    """Prefer a non-blank incoming value, otherwise the previous stored one."""
    if incoming is not None and str(incoming).strip():
        return str(incoming).strip()
    return str(previous or "").strip()


def apply_space_config(
    space_id: str,
    *,
    enabled: bool,
    provider: str | None = None,
    ollama_url: str | None = None,
    base_url: str | None = None,
    embed_model: str | None = None,
    credential: str | None = None,
) -> dict[str, Any]:
    """Save a space's vector-search settings and reconcile the Neo4j index to match.

    Enabling probes the model for its width and creates the indexes. Changing the
    embedding identity — provider, model, or (for Gemini) the base URL — drops the
    indexes and clears stored vectors, because a dimension is baked into an index and
    vectors from two models cannot be compared. An Ollama URL change alone does not:
    the same local model is the same vector space. A credential change does not either.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    previous = resolve_config(sid)
    env = env_config()
    provider_norm = (
        _require_provider(provider)
        if provider is not None
        else _normalize_provider(previous.get("provider"))
    )
    url = validate_ollama_url(
        _pick_text(ollama_url, previous.get("ollama_url")) or env["ollama_url"]
    )
    # None keeps the saved model. An explicit blank does not fall back — enabling
    # with no model is rejected below.
    model = (
        str(embed_model).strip()
        if embed_model is not None
        else str(previous.get("embed_model") or "").strip()
    )
    cred = str(credential).strip() if credential is not None else str(previous.get("credential") or "").strip()

    if provider_norm == PROVIDER_GEMINI:
        # An explicit blank base URL means the documented Google root, not "keep
        # whatever was saved". Omitted (None) keeps a previously saved root.
        if base_url is not None and not str(base_url).strip():
            raw_base = config.embed_base_url()
        else:
            raw_base = (
                _pick_text(base_url, previous.get("base_url")) or config.embed_base_url()
            )
        cloud = validate_cloud_embed_url(raw_base)
    elif base_url is not None:
        # Kept for a later switch to Gemini. Not contacted, so not resolved here.
        cloud = str(base_url).strip().rstrip("/")
    elif previous.get("source") == "space":
        cloud = str(previous.get("base_url") or "").strip()
    else:
        cloud = ""

    prev_provider = _normalize_provider(previous.get("provider"))
    prev_model = str(previous.get("embed_model") or "").strip()
    prev_base = str(previous.get("base_url") or "").strip().rstrip("/")
    identity_changed = model != prev_model or provider_norm != prev_provider
    if provider_norm == PROVIDER_GEMINI and cloud.rstrip("/") != prev_base:
        identity_changed = True

    saved: dict[str, Any] = {
        "enabled": bool(enabled),
        "provider": provider_norm,
        "ollama_url": url,
        "base_url": cloud,
        "embed_model": model,
        "credential": cred,
        "dimensions": previous.get("dimensions"),
    }
    cleared: dict[str, int] | None = None

    if not enabled:
        drop_vector_indexes(sid)
        cleared = clear_vectors(sid)
        saved["dimensions"] = None
    else:
        if not model:
            raise ValueError("An embedding model is required to enable vector search.")
        probe_cfg: dict[str, Any] = {
            "provider": provider_norm,
            "ollama_url": url,
            "base_url": cloud,
            "embed_model": model,
            "credential": cred,
            "source": "space",
            "space_id": sid,
        }
        if provider_norm == PROVIDER_GEMINI:
            validate_gemini_model(model)
            if not cred:
                raise ValueError("A credential is required to enable a cloud embedding model.")
            if not credentials.resolve(sid, cred):
                raise ValueError(f"Credential {cred!r} is not configured for this space.")
        dims = probe_dimensions(probe_cfg)
        saved["dimensions"] = dims
        if identity_changed and previous.get("dimensions"):
            drop_vector_indexes(sid)
            cleared = clear_vectors(sid)
        ensure_vector_indexes(sid, dims)

    stored = spaces.write_space_embeddings_config(sid, saved)
    result = dict(stored)
    result["space_id"] = sid
    result["model_changed"] = identity_changed
    if cleared is not None:
        result["cleared"] = cleared
    return result


# ---------------------------------------------------------------------------
# Serialization: record -> text
# ---------------------------------------------------------------------------


def embedded_keys(schemata: list[dict[str, Any]] | None) -> list[str]:
    """Property keys contributing to a record's text, in schema order.

    The include list is the properties marked ``is_embedded``. Embedding *every* field is
    what makes retrieval look random — a CUSTOMER vector dominated by ``ID_…`` and
    ``tax_id`` noise matches nothing useful — so this is opt-in per property.

    With nothing marked, the display-label property is used: that is what a freshly
    vectorized SCHEMA means, and it keeps a bare ``is_vectorized`` toggle useful on its own.
    """
    included: list[str] = []
    labels: list[str] = []
    for entry in schemata or []:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key") or entry.get("name") or "").strip()
        if not key or entry.get("is_key"):
            continue
        if entry.get("is_embedded"):
            included.append(key)
        elif entry.get("is_label"):
            labels.append(key)
    return included or labels


def resolve_embedded_keys(space_id: str, attributive_label: str) -> list[str]:
    """A vectorized SCHEMA's embedded property keys (node or relationship).

    Raises when the SCHEMA has not opted in: embedding a type nobody asked to embed would
    spend an embed round trip per record and pollute the shared index with types that
    then compete with the ones that were asked for.
    """
    definition = graph.fetch_schema_definition(space_id, attributive_label)
    if not definition.get("is_vectorized"):
        raise ValueError(
            f"SCHEMA {attributive_label!r} is not vectorized. Turn on is_vectorized for it "
            "before indexing its records."
        )
    return embedded_keys(definition.get("schemata") or [])


def _format_value(value: Any) -> str:
    if isinstance(value, (list, tuple, set)):
        return ", ".join(str(v).strip() for v in value if str(v).strip())
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip()


def build_record_text(
    properties: dict[str, Any],
    keys: list[str],
    *,
    attributive_label: str = "",
    source_label: str | None = None,
    target_label: str | None = None,
) -> str:
    """Serialize one record deterministically as ``KEY: value`` lines.

    Missing optional properties are skipped rather than emitted as empty placeholders.
    A relationship is led by its endpoints (``Alice WORKS_AT Acme``) because an edge's own
    properties rarely say enough on their own.
    """
    lines: list[str] = []
    if source_label or target_label:
        endpoints = " ".join(
            part
            for part in (
                _format_value(source_label or ""),
                (attributive_label or "").strip(),
                _format_value(target_label or ""),
            )
            if part
        )
        if endpoints:
            lines.append(endpoints)
    for key in keys:
        if key not in properties:
            continue
        formatted = _format_value(properties.get(key))
        if not formatted:
            continue
        lines.append(f"{key}: {formatted}")
    return "\n".join(lines)[:TEXT_MAX_CHARS]


# ---------------------------------------------------------------------------
# Reindex
# ---------------------------------------------------------------------------


def _validate_kind(kind: str) -> str:
    k = (kind or KIND_NODE).strip().lower()
    if k not in (KIND_NODE, KIND_RELATIONSHIP):
        raise ValueError(f"kind must be {KIND_NODE!r} or {KIND_RELATIONSHIP!r}, got {kind!r}")
    return k


def _value_list_expr(var: str, keys: list[str]) -> str:
    """A Cypher list of the embedded property values.

    Projecting only these keys keeps the (large) ``embedding`` property out of the read.
    """
    if not keys:
        return "[]"
    refs = ", ".join(f"{var}.`{_escape_identifier(key)}`" for key in keys)
    return f"[{refs}]"


def _pending_predicate(var: str) -> str:
    """A record with no vector, or one whose vector no longer describes it."""
    return (
        f"({var}.`{EMBEDDING_PROPERTY}` IS NULL "
        f"OR {var}.`{EMBEDDING_STALE_PROPERTY}` = true)"
    )


def _page_cypher(kind: str, keys: list[str], *, only_stale: bool = False) -> str:
    if kind == KIND_RELATIONSHIP:
        where = f"WHERE {_pending_predicate('r')} " if only_stale else ""
        return (
            f"MATCH {_INSTANCE_REL_MATCH} "
            f"{where}"
            f"RETURN r.id AS id, {_value_list_expr('r', keys)} AS vals, "
            "a.common_label AS source_label, b.common_label AS target_label "
            "ORDER BY r.id SKIP $skip LIMIT $limit"
        )
    where = f"WHERE {_pending_predicate('n')} " if only_stale else ""
    return (
        "MATCH (n:INSTANCE {attributive_label: $al}) "
        f"{where}"
        f"RETURN n.id AS id, {_value_list_expr('n', keys)} AS vals "
        "ORDER BY n.id SKIP $skip LIMIT $limit"
    )


def _write_vector_cypher(kind: str) -> str:
    if kind == KIND_RELATIONSHIP:
        return (
            "MATCH (:INSTANCE)-[r:POINTS_TO {attributive_label: $al, id: $id}]->(:INSTANCE) "
            f"SET r.`{EMBEDDING_PROPERTY}` = $vec "
            f"REMOVE r.`{EMBEDDING_STALE_PROPERTY}` "
            "RETURN count(r) AS c"
        )
    return (
        "MATCH (n:INSTANCE {attributive_label: $al, id: $id}) "
        f"SET n.`{EMBEDDING_PROPERTY}` = $vec "
        f"REMOVE n.`{EMBEDDING_STALE_PROPERTY}` "
        "RETURN count(n) AS c"
    )


def _mark_stale_cypher(kind: str) -> str:
    if kind == KIND_RELATIONSHIP:
        return (
            "MATCH (:INSTANCE)-[r:POINTS_TO {attributive_label: $al, id: $id}]->(:INSTANCE) "
            f"SET r.`{EMBEDDING_STALE_PROPERTY}` = true RETURN count(r) AS c"
        )
    return (
        "MATCH (n:INSTANCE {attributive_label: $al, id: $id}) "
        f"SET n.`{EMBEDDING_STALE_PROPERTY}` = true RETURN count(n) AS c"
    )


def reindex_label(
    space_id: str,
    attributive_label: str,
    *,
    kind: str = KIND_NODE,
    dimensions: int | None = None,
    only_stale: bool = False,
) -> dict[str, Any]:
    """Embed the INSTANCE records of one ``attributive_label``.

    Dimensions are probed up front so an unreachable embedder or a non-embedding model
    fails before any graph writes. Records are then walked a page at a time; a record
    whose text is empty is skipped, and a record whose embed call fails is stamped
    ``embedding_stale`` so it stays findable as "not yet in the index".

    ``only_stale`` limits the walk to records with no vector or a stale one, which is what
    the periodic job runs. Embedding a record removes it from that set, so those pages are
    re-read from the start instead of paging forward, and already-seen ids (a record that
    failed, and was re-marked stale) end the loop rather than being retried forever.
    """
    sid = (space_id or "").strip()
    al = (attributive_label or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    if not al:
        raise ValueError("attributive_label is required")
    k = _validate_kind(kind)

    cfg = _require_enabled(resolve_config(sid))

    keys = resolve_embedded_keys(sid, al)
    if not keys and k == KIND_NODE:
        raise ValueError(
            f"SCHEMA {al!r} has no embedded property and no display-label property, "
            "so there is nothing to embed."
        )

    dims = (
        _validate_dimensions(dimensions) if dimensions is not None else probe_dimensions(cfg)
    )
    ensure_vector_indexes(sid, dims)

    page_cypher = _page_cypher(k, keys, only_stale=only_stale)
    write_cypher = _write_vector_cypher(k)
    stale_cypher = _mark_stale_cypher(k)

    stats: dict[str, Any] = {
        "space_id": sid,
        "attributive_label": al,
        "kind": k,
        "dimensions": dims,
        "only_stale": only_stale,
        "scanned": 0,
        "embedded": 0,
        "skipped": 0,
        "failed": 0,
        "capped": False,
        "aborted": False,
    }
    consecutive_failures = 0
    skip = 0
    seen: set[str] = set()

    while True:
        if stats["scanned"] >= REINDEX_MAX_RECORDS:
            stats["capped"] = True
            break
        limit = min(REINDEX_PAGE_SIZE, REINDEX_MAX_RECORDS - stats["scanned"])
        out = graph.run_cypher_for_space(
            sid, page_cypher, {"al": al, "skip": skip, "limit": limit}
        )
        records = out.get("records") or []
        if only_stale:
            records = [
                row for row in records if str(row.get("id") or "").strip() not in seen
            ]
        if not records:
            break
        if not only_stale:
            skip += len(records)

        for row in records:
            stats["scanned"] += 1
            record_id = str(row.get("id") or "").strip()
            if not record_id:
                stats["skipped"] += 1
                continue
            seen.add(record_id)
            vals = row.get("vals") or []
            properties = {
                key: vals[i] for i, key in enumerate(keys) if i < len(vals)
            }
            text = build_record_text(
                properties,
                keys,
                attributive_label=al,
                source_label=row.get("source_label"),
                target_label=row.get("target_label"),
            )
            if not text:
                stats["skipped"] += 1
                continue
            try:
                vector = embed_text(text, cfg, purpose=PURPOSE_DOCUMENT)
            except (EmbeddingsUnavailable, ValueError):
                stats["failed"] += 1
                consecutive_failures += 1
                graph.run_cypher_for_space(sid, stale_cypher, {"al": al, "id": record_id})
                if consecutive_failures >= _REINDEX_MAX_CONSECUTIVE_FAILURES:
                    stats["aborted"] = True
                    return stats
                continue
            consecutive_failures = 0
            graph.run_cypher_for_space(
                sid, write_cypher, {"al": al, "id": record_id, "vec": vector}
            )
            stats["embedded"] += 1

    return stats


def _vectorized_labels(space_id: str) -> list[tuple[str, str]]:
    """Every ``(attributive_label, kind)`` in the space whose SCHEMA opted in.

    Reads each SCHEMA's stored payload, so a type nobody marked ``is_vectorized`` costs a
    lookup and nothing else.
    """
    out: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    candidates: list[tuple[str, str]] = [
        (str(node.get("attributive_label") or "").strip(), KIND_NODE)
        for node in graph.list_graph_nodes_by_label(space_id, "SCHEMA")
    ]
    candidates += [
        (str(rel.get("attributive_label") or "").strip(), KIND_RELATIONSHIP)
        for rel in graph.list_schema_graph_relationships(space_id)
    ]
    for label, kind in candidates:
        if not label or (label, kind) in seen:
            continue
        seen.add((label, kind))
        try:
            definition = graph.fetch_schema_definition(space_id, label)
        except ValueError:
            continue
        if definition.get("is_vectorized"):
            out.append((label, kind))
    return out


def reindex_space(space_id: str, *, only_stale: bool = False) -> dict[str, Any]:
    """Reindex every vectorized SCHEMA in the space.

    Dimensions are probed once and passed down, so a space with twenty vectorized types
    still only asks the embedder for its vector width once. ``only_stale`` is the periodic job's
    incremental pass; the Reindex button rebuilds everything.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    cfg = _require_enabled(resolve_config(sid))
    dims = probe_dimensions(cfg)
    ensure_vector_indexes(sid, dims)

    labels = _vectorized_labels(sid)
    results: list[dict[str, Any]] = []
    totals = {"scanned": 0, "embedded": 0, "skipped": 0, "failed": 0}
    capped = False
    aborted = False
    for label, kind in labels:
        try:
            stats = reindex_label(
                sid, label, kind=kind, dimensions=dims, only_stale=only_stale
            )
        except ValueError as e:
            results.append({"attributive_label": label, "kind": kind, "error": str(e)})
            continue
        results.append(stats)
        for key in totals:
            totals[key] += int(stats.get(key) or 0)
        capped = capped or bool(stats.get("capped"))
        aborted = aborted or bool(stats.get("aborted"))
    return {
        "space_id": sid,
        "dimensions": dims,
        "labels": len(labels),
        "only_stale": only_stale,
        "results": results,
        "capped": capped,
        "aborted": aborted,
        **totals,
    }


# ---------------------------------------------------------------------------
# Staleness
# ---------------------------------------------------------------------------


def mark_label_stale(space_id: str, attributive_label: str) -> dict[str, int]:
    """Flag every stored vector of one label as no longer describing its record.

    Only records that *have* a vector are touched: one without a vector is already owed an
    embedding, and ``embedding_stale`` exists to say "indexed, but out of date". The same
    ``attributive_label`` can name a node type or a relationship type, so both forms run —
    each is a single statement and matches nothing when the label is the other kind.
    """
    sid = (space_id or "").strip()
    al = (attributive_label or "").strip()
    if not sid or not al:
        return {"nodes": 0, "relationships": 0}
    statements = {
        "nodes": (
            "MATCH (n:INSTANCE {attributive_label: $al}) "
            f"WHERE n.`{EMBEDDING_PROPERTY}` IS NOT NULL "
            f"SET n.`{EMBEDDING_STALE_PROPERTY}` = true RETURN count(n) AS c"
        ),
        "relationships": (
            "MATCH (:INSTANCE)-[r:POINTS_TO {attributive_label: $al}]->(:INSTANCE) "
            f"WHERE r.`{EMBEDDING_PROPERTY}` IS NOT NULL "
            f"SET r.`{EMBEDDING_STALE_PROPERTY}` = true RETURN count(r) AS c"
        ),
    }
    counts: dict[str, int] = {}
    for key, cypher in statements.items():
        out = graph.run_cypher_for_space(sid, cypher, {"al": al})
        records = out.get("records") or []
        counts[key] = int(records[0].get("c") or 0) if records else 0
    return counts


def mark_endpoint_relationships_stale(space_id: str, attributive_label: str) -> int:
    """Flag the vectors of edges touching instances of a node label.

    A relationship's embedded text is led by its endpoints' display labels (see
    :func:`build_record_text`), so renaming a node — an ``is_label`` value edit — silently
    invalidates its edges' vectors even though no edge property changed.
    """
    sid = (space_id or "").strip()
    al = (attributive_label or "").strip()
    if not sid or not al:
        return 0
    out = graph.run_cypher_for_space(
        sid,
        "MATCH (n:INSTANCE {attributive_label: $al})-[r:POINTS_TO]-(:INSTANCE) "
        f"WHERE r.`{EMBEDDING_PROPERTY}` IS NOT NULL "
        f"SET r.`{EMBEDDING_STALE_PROPERTY}` = true RETURN count(r) AS c",
        {"al": al},
    )
    records = out.get("records") or []
    return int(records[0].get("c") or 0) if records else 0


def mark_labels_stale(
    space_id: str, labels: Iterable[str], *, log_context: str = ""
) -> None:
    """Best-effort staleness marking after an INSTANCE write (never raises).

    Shared by the ``/api/execute-query`` route and the executor's query step, the same two
    callers that release ``is_current`` markers via ``schema_currency.reconcile_labels``.
    Marking is label-scoped because a composed statement does not tell us which records it
    touched; re-embedding a label is the cost of not tracking that, and it is deferred to a
    reindex rather than paid on the write.

    Records whose text is unaffected are marked too, which is why the scheduled reindex
    embeds stale records only: the waste is one wasted embed per record, not a wrong result.
    """
    sid = (space_id or "").strip()
    if not sid:
        return
    suffix = f" ({log_context})" if log_context else ""
    try:
        if not resolve_config(sid).get("enabled"):
            return
    except Exception as e:  # noqa: BLE001 - a config read must not fail a write
        sys.stderr.write(f"embedding staleness config error{suffix}: {e}\n")
        return
    for raw in labels:
        label = (raw or "").strip()
        if not label:
            continue
        try:
            definition = graph.fetch_schema_definition(sid, label)
        except Exception:  # noqa: BLE001 - unresolvable label is not a write failure
            continue
        if not definition.get("is_vectorized"):
            # An unvectorized node type can still be an endpoint of a vectorized edge.
            try:
                mark_endpoint_relationships_stale(sid, label)
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f"embedding staleness error{suffix}: {e}\n")
            continue
        try:
            mark_label_stale(sid, label)
            mark_endpoint_relationships_stale(sid, label)
        except Exception as e:  # noqa: BLE001 - staleness is best-effort, like currency
            sys.stderr.write(f"embedding staleness error{suffix}: {e}\n")


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def _search_cypher(kind: str, *, filter_label: bool) -> str:
    if kind == KIND_RELATIONSHIP:
        where = "WHERE relationship.attributive_label = $al " if filter_label else ""
        return (
            "CALL db.index.vector.queryRelationships($index, $overfetch, $vec) "
            "YIELD relationship, score "
            f"{where}"
            "RETURN relationship.id AS id, "
            "relationship.attributive_label AS attributive_label, "
            "startNode(relationship).common_label AS source_label, "
            "endNode(relationship).common_label AS target_label, "
            "score AS score "
            "ORDER BY score DESC LIMIT $k"
        )
    where = "WHERE node.attributive_label = $al " if filter_label else ""
    return (
        "CALL db.index.vector.queryNodes($index, $overfetch, $vec) YIELD node, score "
        f"{where}"
        "RETURN node.id AS id, node.attributive_label AS attributive_label, "
        "node.common_label AS display_label, score AS score "
        "ORDER BY score DESC LIMIT $k"
    )


def search(
    space_id: str,
    text: str,
    *,
    k: int = SEARCH_DEFAULT_K,
    attributive_label: str | None = None,
    kind: str = KIND_NODE,
) -> dict[str, Any]:
    """Nearest-neighbour search over a space's vector index.

    Unlike a write, this cannot degrade when the embedder is down: the query itself has to be
    embedded with the same model, so failure raises instead of returning empty results.
    ``attributive_label`` is applied after the index returns candidates, so the request
    overfetches to keep k achievable for one type out of the shared index.
    """
    sid = (space_id or "").strip()
    query = (text or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    if not query:
        raise ValueError("search text is required")
    kind_norm = _validate_kind(kind)
    try:
        top_k = int(k)
    except (TypeError, ValueError) as e:
        raise ValueError(f"k must be an integer, got {k!r}") from e
    if top_k <= 0 or top_k > SEARCH_MAX_K:
        raise ValueError(f"k must be between 1 and {SEARCH_MAX_K}, got {top_k}")

    label = (attributive_label or "").strip()
    filter_label = bool(label)
    overfetch = (
        min(top_k * SEARCH_OVERFETCH_FACTOR, SEARCH_MAX_OVERFETCH) if filter_label else top_k
    )
    index_name = (
        RELATIONSHIP_VECTOR_INDEX if kind_norm == KIND_RELATIONSHIP else NODE_VECTOR_INDEX
    )

    cfg = _require_enabled(resolve_config(sid))
    vector = embed_text(query, cfg, purpose=PURPOSE_QUERY)
    params: dict[str, Any] = {
        "index": index_name,
        "overfetch": overfetch,
        "vec": vector,
        "k": top_k,
    }
    if filter_label:
        params["al"] = label
    out = graph.run_cypher_for_space(
        sid, _search_cypher(kind_norm, filter_label=filter_label), params
    )
    hits = [row for row in (out.get("records") or []) if isinstance(row, dict)]
    return {
        "space_id": sid,
        "kind": kind_norm,
        "attributive_label": label or None,
        "provider": _normalize_provider(cfg.get("provider")),
        "model": cfg.get("embed_model"),
        "k": top_k,
        "overfetch": overfetch,
        "count": len(hits),
        "hits": hits,
    }


# ---------------------------------------------------------------------------
# Query-step / execute-query pre-resolution
# ---------------------------------------------------------------------------

# Author-facing params synthesized by the composer; engine-filled ones are written here.
_VECTOR_PARAM_TEXT = "vector_query_text"
_VECTOR_PARAM_K = "vector_k"
_VECTOR_PARAM_QUERY = "vector_query"
_VECTOR_PARAM_INDEX = "vector_index"
_VECTOR_PARAM_OVERFETCH = "vector_overfetch"

_VECTOR_CALL_RE = re.compile(
    r"db\.index\.vector\.query(?:Nodes|Relationships)\s*\(",
    re.IGNORECASE,
)


def statements_need_vector_resolve(statements: Iterable[str] | None) -> bool:
    """True when any Cypher statement is a Neo4j vector-index CALL the engine must prep."""
    for stmt in statements or []:
        if _VECTOR_CALL_RE.search(str(stmt or "")):
            return True
    return False


def _vector_source_name(declared: Iterable[Any] | None, role: str, fallback: str) -> str:
    """Which parameter carries the text (or k) for a vector search.

    An author may back either with a parameter of their own naming so a sequence step can
    populate it; the composer marks that row ``vector_role``. A literal is declared under
    the reserved name instead, which is also what operations saved before this existed
    use — hence the fallback.
    """
    for p in declared or []:
        if not isinstance(p, dict):
            continue
        if str(p.get("vector_role") or "").strip() != role:
            continue
        name = str(p.get("name") or "").strip()
        if name:
            return name
    return fallback


def resolve_search_params(
    space_id: str,
    statements: list[str] | None,
    params: dict[str, Any] | None,
    declared: Iterable[Any] | None = None,
) -> dict[str, Any]:
    """Fill engine-owned vector-search parameters before Cypher runs.

    Detects ``db.index.vector.queryNodes`` / ``queryRelationships`` in the statements.
    When present, requires an enabled space config, coerces k, embeds the search text
    into ``vector_query``, and sets ``vector_index`` / ``vector_overfetch``. No-ops
    (returns a shallow copy) when no vector CALL is present, so ordinary reads pay
    nothing.

    ``declared`` is the referenced operation's catalog parameter rows. It names which
    parameters hold the text and k when the author parameterized them; without it the
    reserved ``vector_query_text`` / ``vector_k`` names are used.
    """
    out = dict(params or {})
    if not statements_need_vector_resolve(statements):
        return out

    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")

    cfg = _require_enabled(resolve_config(sid))

    text_name = _vector_source_name(declared, "text", _VECTOR_PARAM_TEXT)
    text = str(out.get(text_name) or "").strip()
    if not text:
        raise ValueError(f"{text_name} is required for vector search")

    k_name = _vector_source_name(declared, "k", _VECTOR_PARAM_K)
    raw_k = out.get(k_name, SEARCH_DEFAULT_K)
    if raw_k is None or raw_k == "":
        raw_k = SEARCH_DEFAULT_K
    try:
        top_k = int(raw_k)
    except (TypeError, ValueError) as e:
        raise ValueError(f"{k_name} must be an integer, got {raw_k!r}") from e
    if top_k <= 0 or top_k > SEARCH_MAX_K:
        raise ValueError(f"{k_name} must be between 1 and {SEARCH_MAX_K}, got {top_k}")

    # Prefer relationship index when any statement calls queryRelationships.
    kind = KIND_NODE
    for stmt in statements or []:
        if re.search(r"queryRelationships\s*\(", str(stmt or ""), re.IGNORECASE):
            kind = KIND_RELATIONSHIP
            break
    index_name = RELATIONSHIP_VECTOR_INDEX if kind == KIND_RELATIONSHIP else NODE_VECTOR_INDEX
    # Composed builder Cypher always filters by attributive_label, so overfetch.
    overfetch = min(top_k * SEARCH_OVERFETCH_FACTOR, SEARCH_MAX_OVERFETCH)

    vector = embed_text(text, cfg, purpose=PURPOSE_QUERY)
    # Write the coerced int back under whichever name the LIMIT clause binds: Neo4j
    # rejects a string LIMIT, and run-panel forms submit every value as a string.
    out[k_name] = top_k
    out[_VECTOR_PARAM_QUERY] = vector
    out[_VECTOR_PARAM_INDEX] = index_name
    out[_VECTOR_PARAM_OVERFETCH] = overfetch
    return out
