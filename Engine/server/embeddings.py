"""
Local vector search over INSTANCE records (Ollama embeddings + Neo4j vector indexes).

Purpose in the project
----------------------
Semantic find for graph data: serialize an INSTANCE record to text, embed it with a
local Ollama model, and store the vector on the record itself so a similarity query
returns the graph nodes/relationships directly. Sequences take those hits and traverse
``POINTS_TO`` as usual — "find similar, then traverse" is two steps, not one read.

Design constraints (see Docs/VECTORIZATION-VISION.md)
-----------------------------------------------------
- **Neo4j holds the vectors.** No sidecar vector database, so a hit *is* the record.
  Because every data node is ``:INSTANCE`` and every data edge is ``:POINTS_TO``, a space
  gets **one** node index and **one** relationship index, which forces a single embedding
  model (and therefore a single dimension) per space.
- **The engine owns the Ollama call.** Ollama listens on localhost, which the D7 SSRF
  guard blocks for sequence endpoint STEPs. This module uses a trusted
  engine-to-localhost client instead.
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
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from typing import Any

from . import config, cypher_utils, graph, spaces

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
# Ollama going away mid-run should stop the loop, not retry thousands of times.
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


class EmbeddingsUnavailable(RuntimeError):
    """Ollama could not be reached, or answered with something unusable."""


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


def env_config() -> dict[str, Any]:
    """Instance-level fallback used by a space that has never saved settings."""
    model = config.ollama_embed_model()
    return {
        "enabled": bool(model),
        "ollama_url": config.ollama_url(),
        "embed_model": model,
        "dimensions": None,
        "source": "env",
    }


def resolve_config(space_id: str) -> dict[str, Any]:
    """The space's effective settings, falling back to the instance env vars.

    A space that never saved settings inherits the environment, so an operator can enable
    vector search instance-wide without touching every space. Once saved, the space's own
    ``enabled`` flag governs.
    """
    stored = spaces.fetch_space_embeddings_config(space_id)
    env = env_config()
    if not stored:
        return env
    return {
        "enabled": bool(stored.get("enabled")),
        "ollama_url": stored.get("ollama_url") or env["ollama_url"],
        "embed_model": stored.get("embed_model") or env["embed_model"],
        "dimensions": stored.get("dimensions"),
        "source": "space",
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
# Ollama client (localhost; the D7 SSRF guard deliberately does not apply)
# ---------------------------------------------------------------------------


def _call_ollama(
    path: str, payload: dict[str, Any], base_url: str | None = None
) -> dict[str, Any]:
    """POST to the local Ollama API and return its parsed JSON object.

    Shaped after other engine-owned localhost clients: explicit timeout, ``HTTPError`` body
    parsed for a usable message, response size capped, every transport failure turned
    into one exception type the callers can report.
    """
    url = (base_url or config.ollama_url()).rstrip("/")
    request = urllib.request.Request(
        f"{url}{path}",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
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
        detail = str(data.get("error") or "").strip() or f"HTTP {e.code}"
        raise EmbeddingsUnavailable(f"Ollama rejected the request: {detail}") from e
    except Exception as e:  # noqa: BLE001 - connection refused, DNS, timeout, ...
        raise EmbeddingsUnavailable(f"Ollama is unavailable at {url}: {e}") from e
    if len(raw) > _OLLAMA_RESPONSE_MAX_BYTES:
        raise EmbeddingsUnavailable("Ollama response exceeded the size limit")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise EmbeddingsUnavailable("Invalid Ollama response (not JSON)") from e
    if not isinstance(data, dict):
        raise EmbeddingsUnavailable("Invalid Ollama response (not an object)")
    return data


def _vector_from_response(data: dict[str, Any]) -> list[float]:
    """Read a single vector out of an ``/api/embed`` (or legacy) response."""
    embeddings = data.get("embeddings")
    if isinstance(embeddings, list) and embeddings:
        first = embeddings[0]
        if isinstance(first, list) and first:
            return [float(v) for v in first]
    # /api/embeddings (older single-vector shape) answers with "embedding".
    legacy = data.get("embedding")
    if isinstance(legacy, list) and legacy:
        return [float(v) for v in legacy]
    raise EmbeddingsUnavailable("Ollama returned no embedding vector")


def embed_text(text: str, cfg: dict[str, Any] | None = None) -> list[float]:
    """Embed one string with the configured Ollama embedding model."""
    settings = cfg or env_config()
    model = str(settings.get("embed_model") or "").strip()
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

    Doubles as a model check: a generate/chat model does not answer ``/api/embed`` with a
    vector, so this fails loudly instead of quietly building a wrong-width index.
    """
    dims = len(embed_text("dimension probe", cfg))
    if dims <= 0:
        raise EmbeddingsUnavailable("Ollama returned an empty embedding vector")
    return dims


def health(space_id: str | None = None) -> dict[str, Any]:
    """Report whether Ollama answers and which model/dimensions are in play.

    Returns the failure as data rather than raising, so the settings UI can render it as
    status instead of an error.
    """
    try:
        cfg = resolve_config(space_id) if space_id else env_config()
    except ValueError as e:
        return {"ok": False, "error": str(e), "enabled": False, "dimensions": None}
    out: dict[str, Any] = {
        "ollama_url": cfg.get("ollama_url"),
        "model": cfg.get("embed_model"),
        "enabled": bool(cfg.get("enabled")),
        "source": cfg.get("source"),
        "ok": False,
        "dimensions": cfg.get("dimensions"),
        "error": None,
    }
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


def apply_space_config(
    space_id: str,
    *,
    enabled: bool,
    ollama_url: str | None = None,
    embed_model: str | None = None,
) -> dict[str, Any]:
    """Save a space's vector-search settings and reconcile the Neo4j index to match.

    Enabling probes the model for its width and creates the indexes. Changing the model
    (or disabling) drops the indexes and clears stored vectors, because a dimension is
    baked into an index and vectors from two models cannot be compared.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    previous = resolve_config(sid)
    env = env_config()
    url = validate_ollama_url(ollama_url or previous.get("ollama_url") or env["ollama_url"])
    model = str(
        embed_model if embed_model is not None else (previous.get("embed_model") or "")
    ).strip()

    saved: dict[str, Any] = {
        "enabled": bool(enabled),
        "ollama_url": url,
        "embed_model": model,
        "dimensions": previous.get("dimensions"),
    }
    model_changed = model != str(previous.get("embed_model") or "").strip()
    cleared: dict[str, int] | None = None

    if not enabled:
        drop_vector_indexes(sid)
        cleared = clear_vectors(sid)
        saved["dimensions"] = None
    else:
        if not model:
            raise ValueError("An embedding model is required to enable vector search.")
        dims = probe_dimensions({"ollama_url": url, "embed_model": model})
        saved["dimensions"] = dims
        if model_changed and previous.get("dimensions"):
            drop_vector_indexes(sid)
            cleared = clear_vectors(sid)
        ensure_vector_indexes(sid, dims)

    stored = spaces.write_space_embeddings_config(sid, saved)
    result = dict(stored)
    result["space_id"] = sid
    result["model_changed"] = model_changed
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
    spend an Ollama round trip per record and pollute the shared index with types that
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

    Dimensions are probed up front so an unreachable Ollama or a non-embedding model
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
                vector = embed_text(text, cfg)
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
    still only asks Ollama for its vector width once. ``only_stale`` is the periodic job's
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

    Unlike a write, this cannot degrade when Ollama is down: the query itself has to be
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
    vector = embed_text(query, cfg)
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

    vector = embed_text(text, cfg)
    # Write the coerced int back under whichever name the LIMIT clause binds: Neo4j
    # rejects a string LIMIT, and run-panel forms submit every value as a string.
    out[k_name] = top_k
    out[_VECTOR_PARAM_QUERY] = vector
    out[_VECTOR_PARAM_INDEX] = index_name
    out[_VECTOR_PARAM_OVERFETCH] = overfetch
    return out
