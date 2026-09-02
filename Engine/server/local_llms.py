"""
Named local LLM configs — CRUD + Ollama generate for Local LLM STEPs.

Purpose in the project
----------------------
Authors save named Ollama setups (model, system prompt, sampling options, optional
JSON-schema response format) per space. A CREATE STEP of kind ``local_llm`` picks one
config; at run time the engine calls Ollama ``/api/generate`` with those settings and
the sequence's ``prompt`` parameter. A run may also override any saved setting for
that call through the optional sequence parameters in :data:`OVERRIDE_KEYS`.

Ollama is reached only from this module (and embeddings), as a trusted
engine-owned localhost client. Endpoint STEPs cannot call loopback (D7).
"""

from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config, embeddings, id_generator

_SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schema"
_TABLE_SQL = _SCHEMA_DIR / "local-llm-configs-table.sql"

_GENERATE_TIMEOUT_SECONDS = 300
_OLLAMA_RESPONSE_MAX_BYTES = 16 * 1024 * 1024

_OPTION_KEYS = (
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "repeat_penalty",
    "num_ctx",
    "num_predict",
    "seed",
    "stop",
)
_INT_OPTION_KEYS = frozenset({"top_k", "num_ctx", "num_predict", "seed"})

# Sequence parameters a Local LLM STEP may supply to override its saved config for
# one run. ``prompt`` is the required input; everything here is optional and blank
# means "keep the saved config's value".
OVERRIDE_KEYS = ("system_prompt", "response_format", "json_schema", *_OPTION_KEYS)


class LocalLlmUnavailable(RuntimeError):
    """Ollama is down, misconfigured, or rejected the generate request."""


class ConfigNotFound(LookupError):
    def __init__(self, config_id: str) -> None:
        super().__init__(f"local LLM config '{config_id}' not found")
        self.config_id = config_id


def _conn() -> sqlite3.Connection:
    return config.connect_sqlite(config.catalog_sqlite_path())


def _ensure_table(conn: sqlite3.Connection) -> None:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_llm_configs'"
    )
    if cur.fetchone() is None and _TABLE_SQL.is_file():
        conn.executescript(_TABLE_SQL.read_text(encoding="utf-8"))
        conn.commit()


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_json_object(raw: str | None, *, default: dict[str, Any]) -> dict[str, Any]:
    if not raw or not str(raw).strip():
        return dict(default)
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return dict(default)
    return data if isinstance(data, dict) else dict(default)


def normalize_options(raw: Any) -> dict[str, Any]:
    """Keep only known option keys; drop nulls/empties; coerce numeric types."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in _OPTION_KEYS:
        if key not in raw:
            continue
        value = raw[key]
        if value is None or value == "":
            continue
        if key == "stop":
            if isinstance(value, list):
                cleaned = [str(item) for item in value if str(item).strip()]
                if cleaned:
                    out["stop"] = cleaned
            elif isinstance(value, str) and value.strip():
                parts = [p.strip() for p in value.split(",") if p.strip()]
                if parts:
                    out["stop"] = parts
            continue
        try:
            if key in _INT_OPTION_KEYS:
                out[key] = int(value)
            else:
                out[key] = float(value)
        except (TypeError, ValueError):
            continue
    return out


def normalize_response_format(raw: Any) -> dict[str, Any]:
    """``{type: text|json_schema, json_schema?}`` — schema required for json_schema."""
    if not isinstance(raw, dict):
        return {"type": "text"}
    fmt_type = str(raw.get("type") or "text").strip().lower()
    if fmt_type not in ("text", "json_schema"):
        raise ValueError("response_format.type must be 'text' or 'json_schema'")
    if fmt_type == "text":
        return {"type": "text"}
    schema = raw.get("json_schema")
    if not isinstance(schema, dict) or not schema:
        raise ValueError("json_schema is required when response_format.type is json_schema")
    return {"type": "json_schema", "json_schema": schema}


def _row_to_config(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "space_id": row["space_id"],
        "name": row["name"],
        "model": row["model"],
        "system_prompt": row["system_prompt"] or "",
        "options": normalize_options(_parse_json_object(row["options"], default={})),
        "response_format": normalize_response_format(
            _parse_json_object(row["response_format"], default={"type": "text"})
        ),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _validate_payload(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name") or "").strip()
    model = str(body.get("model") or "").strip()
    if not name:
        raise ValueError("name is required")
    if not model:
        raise ValueError("model is required")
    system_prompt = body.get("system_prompt")
    if system_prompt is None:
        system_prompt = ""
    else:
        system_prompt = str(system_prompt)
    options = normalize_options(body.get("options") if "options" in body else {})
    response_format = normalize_response_format(
        body.get("response_format") if "response_format" in body else {"type": "text"}
    )
    return {
        "name": name,
        "model": model,
        "system_prompt": system_prompt,
        "options": options,
        "response_format": response_format,
    }


def list_configs(space_id: str) -> list[dict[str, Any]]:
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    conn = _conn()
    try:
        _ensure_table(conn)
        rows = conn.execute(
            "SELECT * FROM local_llm_configs WHERE space_id = ? ORDER BY name COLLATE NOCASE, id",
            (sid,),
        ).fetchall()
        return [_row_to_config(row) for row in rows]
    finally:
        conn.close()


def get_config(space_id: str, config_id: str) -> dict[str, Any]:
    sid = (space_id or "").strip()
    cid = (config_id or "").strip()
    if not sid or not cid:
        raise ValueError("space_id and config_id are required")
    conn = _conn()
    try:
        _ensure_table(conn)
        row = conn.execute(
            "SELECT * FROM local_llm_configs WHERE space_id = ? AND id = ?",
            (sid, cid),
        ).fetchone()
        if row is None:
            raise ConfigNotFound(cid)
        return _row_to_config(row)
    finally:
        conn.close()


def create_config(space_id: str, body: dict[str, Any]) -> dict[str, Any]:
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    payload = _validate_payload(body)
    cid = id_generator.generate_id()
    now = _utcnow_iso()
    conn = _conn()
    try:
        _ensure_table(conn)
        conn.execute(
            "INSERT INTO local_llm_configs "
            "(id, space_id, name, model, system_prompt, options, response_format, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                cid,
                sid,
                payload["name"],
                payload["model"],
                payload["system_prompt"],
                json.dumps(payload["options"]),
                json.dumps(payload["response_format"]),
                now,
                now,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return get_config(sid, cid)


def replace_config(space_id: str, config_id: str, body: dict[str, Any]) -> dict[str, Any]:
    sid = (space_id or "").strip()
    cid = (config_id or "").strip()
    if not sid or not cid:
        raise ValueError("space_id and config_id are required")
    payload = _validate_payload(body)
    now = _utcnow_iso()
    conn = _conn()
    try:
        _ensure_table(conn)
        cur = conn.execute(
            "UPDATE local_llm_configs SET name = ?, model = ?, system_prompt = ?, "
            "options = ?, response_format = ?, updated_at = ? "
            "WHERE space_id = ? AND id = ?",
            (
                payload["name"],
                payload["model"],
                payload["system_prompt"],
                json.dumps(payload["options"]),
                json.dumps(payload["response_format"]),
                now,
                sid,
                cid,
            ),
        )
        if cur.rowcount == 0:
            raise ConfigNotFound(cid)
        conn.commit()
    finally:
        conn.close()
    return get_config(sid, cid)


def delete_config(space_id: str, config_id: str) -> None:
    sid = (space_id or "").strip()
    cid = (config_id or "").strip()
    if not sid or not cid:
        raise ValueError("space_id and config_id are required")
    conn = _conn()
    try:
        _ensure_table(conn)
        cur = conn.execute(
            "DELETE FROM local_llm_configs WHERE space_id = ? AND id = ?",
            (sid, cid),
        )
        if cur.rowcount == 0:
            raise ConfigNotFound(cid)
        conn.commit()
    finally:
        conn.close()


def _ollama_base_url(space_id: str) -> str:
    """Reuse the space's embeddings Ollama URL (and the same host allowlist)."""
    cfg = embeddings.resolve_config(space_id)
    url = str(cfg.get("ollama_url") or "").strip() or config.ollama_url()
    return embeddings.validate_ollama_url(url)


def _call_ollama_json(
    method: str,
    path: str,
    *,
    base_url: str,
    payload: dict[str, Any] | None = None,
    timeout: float = _GENERATE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}{path}"
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            raw = resp.read(_OLLAMA_RESPONSE_MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        try:
            body = e.read(_OLLAMA_RESPONSE_MAX_BYTES + 1)
        except Exception:  # noqa: BLE001
            body = b""
        try:
            err_data = json.loads(body.decode("utf-8")) if body else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            err_data = {}
        detail = str(err_data.get("error") or "").strip() or f"HTTP {e.code}"
        raise LocalLlmUnavailable(f"Ollama rejected the request: {detail}") from e
    except Exception as e:  # noqa: BLE001
        raise LocalLlmUnavailable(f"Ollama is unavailable at {base_url}: {e}") from e
    if len(raw) > _OLLAMA_RESPONSE_MAX_BYTES:
        raise LocalLlmUnavailable("Ollama response exceeded the size limit")
    try:
        data_out = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise LocalLlmUnavailable("Invalid Ollama response (not JSON)") from e
    if not isinstance(data_out, dict):
        raise LocalLlmUnavailable("Invalid Ollama response (not an object)")
    return data_out


def health(space_id: str) -> dict[str, Any]:
    """Report whether Ollama answers ``/api/tags`` for this space's URL."""
    try:
        base = _ollama_base_url(space_id)
    except ValueError as e:
        return {
            "status": "error",
            "ollama": False,
            "ollama_url": "",
            "ollama_error": str(e),
        }
    try:
        _call_ollama_json("GET", "/api/tags", base_url=base, timeout=5.0)
        return {
            "status": "ok",
            "ollama": True,
            "ollama_url": base,
            "ollama_error": None,
        }
    except LocalLlmUnavailable as e:
        return {
            "status": "error",
            "ollama": False,
            "ollama_url": base,
            "ollama_error": str(e),
        }


def list_models(space_id: str) -> list[dict[str, Any]]:
    base = _ollama_base_url(space_id)
    data = _call_ollama_json("GET", "/api/tags", base_url=base, timeout=15.0)
    models = data.get("models") if isinstance(data.get("models"), list) else []
    out: list[dict[str, Any]] = []
    for item in models:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        out.append(
            {
                "name": name,
                "size": item.get("size"),
                "modified_at": item.get("modified_at"),
            }
        )
    out.sort(key=lambda m: m["name"].lower())
    return out


def generate(
    *,
    model: str,
    prompt: str,
    system: str = "",
    options: dict[str, Any] | None = None,
    format_payload: dict[str, Any] | str | None = None,
    base_url: str,
) -> dict[str, Any]:
    """POST ``/api/generate`` (non-streaming) and return Ollama's JSON object."""
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "stream": False,
    }
    if system:
        payload["system"] = system
    cleaned = normalize_options(options or {})
    if cleaned:
        payload["options"] = cleaned
    if format_payload is not None:
        payload["format"] = format_payload
    return _call_ollama_json(
        "POST",
        "/api/generate",
        base_url=base_url,
        payload=payload,
        timeout=_GENERATE_TIMEOUT_SECONDS,
    )


def _parse_schema_override(raw: Any) -> dict[str, Any]:
    """A ``json_schema`` override travels as JSON text (parameters have no object type)."""
    if isinstance(raw, dict):
        schema: Any = raw
    else:
        text = str(raw or "").strip()
        if not text:
            return {}
        try:
            schema = json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(f"json_schema must be valid JSON: {e.msg}") from e
    if not isinstance(schema, dict) or not schema:
        raise ValueError("json_schema must be a non-empty JSON object")
    return schema


def _resolve_format_payload(
    saved_format: dict[str, Any] | None, overrides: dict[str, Any]
) -> dict[str, Any] | None:
    """The ``format`` Ollama receives, after applying the run's format overrides.

    An explicit ``response_format`` wins over the saved config — including "text",
    which suppresses a saved schema. A ``json_schema`` override with no explicit
    ``response_format`` implies schema mode.
    """
    saved = saved_format or {"type": "text"}
    schema_override = _parse_schema_override(overrides.get("json_schema"))
    fmt_type = str(overrides.get("response_format") or "").strip().lower()
    if not fmt_type:
        fmt_type = "json_schema" if schema_override else str(saved.get("type") or "text")
    if fmt_type not in ("text", "json_schema"):
        raise ValueError("response_format must be 'text' or 'json_schema'")
    if fmt_type == "text":
        return None
    schema = schema_override or saved.get("json_schema")
    if not isinstance(schema, dict) or not schema:
        raise ValueError(
            "response_format 'json_schema' needs a schema: supply a json_schema "
            "parameter or save one on the config"
        )
    return schema


def run_config(
    space_id: str,
    config_id: str,
    prompt: str,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Load a saved config and run it against Ollama with the given prompt.

    ``overrides`` holds this run's optional settings (see :data:`OVERRIDE_KEYS`).
    Each one replaces the saved config's value for this call only; sampling options
    merge key-by-key, so overriding ``temperature`` leaves the saved ``top_p`` alone.
    """
    text = prompt if isinstance(prompt, str) else str(prompt or "")
    if not text.strip():
        raise ValueError("prompt is required")
    cfg = get_config(space_id, config_id)
    base = _ollama_base_url(space_id)
    overrides = overrides or {}
    format_payload = _resolve_format_payload(cfg.get("response_format"), overrides)
    options = dict(cfg.get("options") or {})
    # normalize_options keeps only the sampling keys, so the non-option overrides
    # (system_prompt / response_format / json_schema) drop out here.
    options.update(normalize_options(overrides))
    system_override = str(overrides.get("system_prompt") or "")
    system = system_override if system_override.strip() else (cfg.get("system_prompt") or "")
    result = generate(
        model=cfg["model"],
        prompt=text,
        system=system,
        options=options,
        format_payload=format_payload,
        base_url=base,
    )
    response_text = str(result.get("response") or "")
    parsed: Any = None
    if format_payload is not None and response_text:
        try:
            parsed = json.loads(response_text)
        except json.JSONDecodeError:
            parsed = None
    return {
        "config_id": cfg["id"],
        "model": str(result.get("model") or cfg["model"]),
        "response": response_text,
        "parsed": parsed,
        "done_reason": result.get("done_reason"),
        "eval_count": result.get("eval_count"),
    }
