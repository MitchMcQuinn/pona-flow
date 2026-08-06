"""
Configuration, environment, and low-level database utilities for the dev server.

Purpose in the project
----------------------
Every other server module depends on this file for:

- **Project layout**: ``ROOT`` (repository root) and ``APP_DIR`` (``App/`` static files).
- **Secrets and paths**: loading ``.env``, resolving *indirect* paths (catalog DB and
  per-space DBs are referenced by *key names* stored in SQLite, not literal paths in code).
- **SQLite connections**: a single ``connect_sqlite`` helper with ``sqlite3.Row`` factory.
- **Entity IDs**: re-export of ``id_generator.generate_id`` for ``ID_<uuid>`` strings used
  by the QUERY form and catalog row editor.

Importance
----------
This is the foundation layer. It has no business rules about graph nodes or query
packages—only "where is the project?" and "how do we read config and open SQLite?".

The catalog database path is controlled by ``PONA_FLOW_CATALOG_SQLITE_KEY`` (default
``SQLITE_DATABASE_PATH``), which typically points at ``data.db``. That file holds the
``spaces`` registry, saved ``queries``, ``regex`` patterns, and other catalog tables.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path

from . import id_generator

# Repository root (parent of Engine/) and browser UI directory.
ROOT = Path(__file__).resolve().parent.parent.parent
APP_DIR = ROOT / "App"

# Default .env key whose value is the catalog SQLite file path.
DEFAULT_CATALOG_SQLITE_ENV_KEY = "SQLITE_DATABASE_PATH"

# Credential store backend selector (see Engine/server/credentials.py).
#   passthrough -> read-only os.environ (default; today's behavior, never writes .env)
#   local       -> read/write the project .env file (local development)
#   hosted       -> reserved for a future provider adapter (treated as passthrough here)
DEFAULT_CREDENTIAL_BACKEND = "passthrough"

# Serializes concurrent .env writes from the credential API (single-writer guard).
_ENV_FILE_LOCK = threading.Lock()

def generate_entity_id() -> str:
    """Return a new ``ID_<uuid>`` string (see ``server.id_generator``)."""
    return id_generator.generate_id()


def load_env_file(path: Path) -> None:
    """
    Load KEY=value pairs from a .env file into os.environ (setdefault only).

    Used at server startup so Neo4j and SQLite paths resolve without exporting
    variables manually in the shell.
    """
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


def env_file_path() -> Path:
    """Absolute path to the project ``.env`` file (it may not exist yet)."""
    return ROOT / ".env"


def _format_env_line(key: str, value: str) -> str:
    """Render a ``KEY=value`` line, quoting when the value has whitespace or ``#``."""
    needs_quote = value != value.strip() or "#" in value or "'" in value
    if needs_quote:
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'{key}="{escaped}"'
    return f"{key}={value}"


def set_env_value(key: str, value: str) -> None:
    """
    Persist ``KEY=value`` to the project ``.env`` file and update ``os.environ``.

    Unlike :func:`load_env_file` (which uses ``setdefault`` for startup bootstrap), this
    overwrites an existing value both on disk and in the live process so credential updates
    take effect without a restart. Existing lines/comments are preserved; the matching key
    is rewritten in place, otherwise the pair is appended.
    """
    name = (key or "").strip()
    if not name:
        raise ValueError("Empty .env key name")
    val = "" if value is None else str(value)
    path = env_file_path()
    with _ENV_FILE_LOCK:
        lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
        new_line = _format_env_line(name, val)
        replaced = False
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            existing_key = stripped.partition("=")[0].strip()
            if existing_key == name:
                lines[i] = new_line
                replaced = True
                break
        if not replaced:
            lines.append(new_line)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.environ[name] = val


def delete_env_value(key: str) -> None:
    """Remove ``KEY`` from the project ``.env`` file and from ``os.environ`` (idempotent)."""
    name = (key or "").strip()
    if not name:
        raise ValueError("Empty .env key name")
    path = env_file_path()
    with _ENV_FILE_LOCK:
        if path.is_file():
            kept: list[str] = []
            for line in path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith("#") and "=" in stripped:
                    if stripped.partition("=")[0].strip() == name:
                        continue
                kept.append(line)
            path.write_text(("\n".join(kept) + "\n") if kept else "", encoding="utf-8")
    os.environ.pop(name, None)


def code_exec_enabled() -> bool:
    """Admin kill switch for code-execution steps (``PONA_FLOW_CODE_EXEC_ENABLED``).

    Defaults to enabled; set to ``0``/``false`` to refuse all code executions without
    a deploy. Read fresh from the environment so it can be flipped at runtime.
    """
    raw = (os.environ.get("PONA_FLOW_CODE_EXEC_ENABLED") or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def runner_url() -> str:
    """Base URL of the sandbox runner service (``PONA_FLOW_RUNNER_URL``).

    The runner is a separate low-privilege process (see Engine/runner) that owns all
    Docker access; the main app only ever talks to it over localhost HTTP.
    """
    return (
        os.environ.get("PONA_FLOW_RUNNER_URL") or "http://127.0.0.1:8766"
    ).strip().rstrip("/")


def runner_token() -> str:
    """Shared secret for authenticating to the sandbox runner (``PONA_FLOW_RUNNER_TOKEN``)."""
    return (os.environ.get("PONA_FLOW_RUNNER_TOKEN") or "").strip()


def credential_backend() -> str:
    """Selected credential store backend (``passthrough`` | ``local`` | ``hosted``).

    Read fresh from the environment so deployments can pin it without a code change.
    """
    raw = (os.environ.get("PONA_FLOW_CREDENTIAL_BACKEND") or "").strip().lower()
    return raw or DEFAULT_CREDENTIAL_BACKEND


def env_value(env_key_name: str, fallback_key: str | None = None) -> str:
    """
    Resolve a value from os.environ by key name; raise if missing or empty.

    When ``fallback_key`` is provided and the primary key is unset/empty (or the
    primary key name is blank), resolve ``fallback_key`` instead. This lets a
    space-specific override (e.g. ``NEW_SPACE_NEO4J_URI``) fall back to a shared
    default (e.g. ``NEO4J_URI``) when the override is not set.
    """
    name = (env_key_name or "").strip()
    val = os.environ.get(name) if name else None
    if val is None or not str(val).strip():
        if fallback_key:
            return env_value(fallback_key)
        if not name:
            raise ValueError("Empty .env key name")
        raise KeyError(f".env key {name!r} is not set")
    return str(val).strip()


def sqlite_path_for_env_key(env_key_name: str, fallback_key: str | None = None) -> Path:
    """Resolve a SQLite file path from an .env key (absolute or relative to ROOT)."""
    raw = env_value(env_key_name, fallback_key=fallback_key)
    p = Path(raw)
    return p if p.is_absolute() else ROOT / p


def catalog_sqlite_env_key() -> str:
    """Return the .env key name used for the catalog database path."""
    return (
        os.environ.get("PONA_FLOW_CATALOG_SQLITE_KEY", DEFAULT_CATALOG_SQLITE_ENV_KEY).strip()
        or DEFAULT_CATALOG_SQLITE_ENV_KEY
    )


def catalog_sqlite_path() -> Path:
    """Path to the DB that holds the spaces registry and catalog tables (e.g. data.db)."""
    return sqlite_path_for_env_key(catalog_sqlite_env_key())


def connect_sqlite(path: Path) -> sqlite3.Connection:
    """Open SQLite with Row factory for dict-like column access."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def superadmin_clerk_id() -> str:
    """Clerk user id (JWT ``sub``) of the single server superadmin, if configured."""
    return (os.environ.get("SUPERADMIN_CLERK_ID") or "").strip()


def superadmin_email() -> str:
    """Email of the single server superadmin (fallback to clerk id matching), if set."""
    return (os.environ.get("SUPERADMIN_EMAIL") or "").strip()


def clerk_secret_key() -> str:
    """Clerk Backend API secret key (``sk_...``), used to resolve user profiles server-side.

    Empty/unset disables backend lookups; identities then fall back to whatever the JWT
    carried. Read fresh from the environment so it can be toggled without a restart.
    """
    return (os.environ.get("CLERK_SECRET_KEY") or "").strip()


def clerk_api_base() -> str:
    """Base URL for the Clerk Backend API (override only for testing)."""
    return (os.environ.get("CLERK_API_BASE") or "https://api.clerk.com/v1").strip().rstrip("/")
