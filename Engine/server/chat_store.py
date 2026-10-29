"""Catalog persistence for chat threads, messages, canvas stacks, and model settings.

Threads belong to one user inside one space. Messages hold the transcript and any
pending change batch. Stack items are the canvas tabs that thread restores.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from . import catalog, config, id_generator, spaces

_SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schema"
_CHAT_SQL = _SCHEMA_DIR / "chat-tables.sql"

STACK_KINDS = (
    "saved_console",
    "ephemeral_console",
    "proposal",
    "hitl",
    "builder",
    "run_log",
    "reasoning",
    "reads",
    "walkthrough",
)

MAX_ROUNDS_DEFAULT = 24
MAX_ROUNDS_MIN = 4
MAX_ROUNDS_MAX = 48


def clamp_max_rounds(value: Any) -> int:
    """Space-admin cap for one chat turn. Missing or junk values use the default."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return MAX_ROUNDS_DEFAULT
    return max(MAX_ROUNDS_MIN, min(MAX_ROUNDS_MAX, number))

CHAT_PROVIDERS = ("platform", "anthropic", "openai", "gemini", "local_llm")

_ensured_paths: set[str] = set()


def ensure_schema(conn: sqlite3.Connection | None = None) -> None:
    """Create the chat tables when this catalog predates them."""
    if conn is None:
        with catalog.catalog_connection() as own:
            ensure_schema(own)
        return
    path = str(config.catalog_sqlite_path())
    if path in _ensured_paths:
        return
    if _CHAT_SQL.is_file():
        conn.executescript(_CHAT_SQL.read_text(encoding="utf-8"))
        conn.commit()
    _ensured_paths.add(path)


def _conn() -> sqlite3.Connection:
    conn = catalog.catalog_conn()
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


def _loads(raw: Any, fallback: Any) -> Any:
    if raw is None or raw == "":
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


def _dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, default=str)


def _thread_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "space_id": row["space_id"],
        "user_id": row["user_id"],
        "title": row["title"] or "",
        "turn_status": row["turn_status"] or "idle",
        "active_stack_item_id": row["active_stack_item_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _message_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "thread_id": row["thread_id"],
        "role": row["role"],
        "content": row["content"] or "",
        "tool_calls": _loads(row["tool_calls"], []),
        "batch": _loads(row["batch"], None),
        "created_at": row["created_at"],
    }


def _stack_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "thread_id": row["thread_id"],
        "kind": row["kind"],
        "title": row["title"] or "",
        "payload": _loads(row["payload"], {}),
        "position": int(row["position"] or 0),
        "created_at": row["created_at"],
    }


def create_thread(space_id: str, user_id: str, title: str = "") -> dict[str, Any]:
    tid = id_generator.generate_id()
    conn = _conn()
    try:
        conn.execute(
            """
            INSERT INTO chat_threads (id, space_id, user_id, title)
            VALUES (?, ?, ?, ?)
            """,
            (tid, space_id.strip(), user_id.strip(), (title or "").strip()[:80]),
        )
        conn.commit()
    finally:
        conn.close()
    return get_thread(tid, space_id, user_id) or {"id": tid}


def list_threads(space_id: str, user_id: str) -> list[dict[str, Any]]:
    conn = _conn()
    try:
        rows = conn.execute(
            """
            SELECT * FROM chat_threads
            WHERE space_id = ? AND user_id = ?
            ORDER BY updated_at DESC, created_at DESC
            """,
            (space_id.strip(), user_id.strip()),
        ).fetchall()
        return [_thread_row(row) for row in rows]
    finally:
        conn.close()


def get_thread(thread_id: str, space_id: str, user_id: str) -> dict[str, Any] | None:
    """The thread plus its messages and stack, or None when it is not this user's."""
    conn = _conn()
    try:
        row = conn.execute(
            """
            SELECT * FROM chat_threads
            WHERE id = ? AND space_id = ? AND user_id = ?
            """,
            (thread_id.strip(), space_id.strip(), user_id.strip()),
        ).fetchone()
        if row is None:
            return None
        thread = _thread_row(row)
        messages = conn.execute(
            "SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC",
            (thread["id"],),
        ).fetchall()
        stack = conn.execute(
            "SELECT * FROM chat_stack_items WHERE thread_id = ? ORDER BY position ASC, created_at ASC",
            (thread["id"],),
        ).fetchall()
        thread["messages"] = [_message_row(item) for item in messages]
        thread["stack"] = [_stack_row(item) for item in stack]
        return thread
    finally:
        conn.close()


def touch_thread(thread_id: str, title: str | None = None) -> None:
    conn = _conn()
    try:
        if title is not None and title.strip():
            conn.execute(
                """
                UPDATE chat_threads
                SET updated_at = datetime('now'),
                    title = CASE WHEN title = '' THEN ? ELSE title END
                WHERE id = ?
                """,
                (title.strip()[:80], thread_id),
            )
        else:
            conn.execute(
                "UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?",
                (thread_id,),
            )
        conn.commit()
    finally:
        conn.close()


def set_turn_status(thread_id: str, status: str) -> None:
    chosen = status if status in ("idle", "running") else "idle"
    conn = _conn()
    try:
        conn.execute(
            "UPDATE chat_threads SET turn_status = ?, updated_at = datetime('now') WHERE id = ?",
            (chosen, thread_id),
        )
        conn.commit()
    finally:
        conn.close()


def set_active_stack_item(thread_id: str, item_id: str | None) -> None:
    conn = _conn()
    try:
        conn.execute(
            "UPDATE chat_threads SET active_stack_item_id = ? WHERE id = ?",
            ((item_id or "").strip() or None, thread_id),
        )
        conn.commit()
    finally:
        conn.close()


def append_message(
    thread_id: str,
    role: str,
    content: str,
    tool_calls: list[Any] | None = None,
    batch: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if role not in ("user", "assistant"):
        raise ValueError("role must be user or assistant")
    mid = id_generator.generate_id()
    conn = _conn()
    try:
        conn.execute(
            """
            INSERT INTO chat_messages (id, thread_id, role, content, tool_calls, batch)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                mid,
                thread_id,
                role,
                content or "",
                json.dumps(tool_calls or [], default=str),
                json.dumps(batch, default=str) if batch else None,
            ),
        )
        conn.execute(
            "UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?",
            (thread_id,),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM chat_messages WHERE id = ?", (mid,)).fetchone()
        return _message_row(row)
    finally:
        conn.close()


def update_message_batch(message_id: str, batch: dict[str, Any]) -> None:
    conn = _conn()
    try:
        conn.execute(
            "UPDATE chat_messages SET batch = ? WHERE id = ?",
            (json.dumps(batch, default=str), message_id),
        )
        conn.commit()
    finally:
        conn.close()


def pending_batch(thread: dict[str, Any]) -> dict[str, Any] | None:
    """The newest unresolved change batch on this thread, if any."""
    for message in reversed(thread.get("messages") or []):
        batch = message.get("batch")
        if isinstance(batch, dict) and batch.get("status") == "pending":
            return {"message_id": message["id"], **batch}
    return None


def add_stack_item(
    thread_id: str,
    kind: str,
    title: str,
    payload: dict[str, Any] | None = None,
    *,
    activate: bool = True,
) -> dict[str, Any]:
    if kind not in STACK_KINDS:
        raise ValueError(f"unknown canvas item kind {kind!r}")
    iid = id_generator.generate_id()
    body = payload if isinstance(payload, dict) else {}
    conn = _conn()
    try:
        position = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM chat_stack_items WHERE thread_id = ?",
            (thread_id,),
        ).fetchone()[0]
        conn.execute(
            """
            INSERT INTO chat_stack_items (id, thread_id, kind, title, payload, position)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (iid, thread_id, kind, (title or kind)[:120], _dumps(body), int(position or 0)),
        )
        if activate:
            conn.execute(
                """
                UPDATE chat_threads
                SET active_stack_item_id = ?, updated_at = datetime('now')
                WHERE id = ?
                """,
                (iid, thread_id),
            )
        else:
            conn.execute(
                "UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?",
                (thread_id,),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM chat_stack_items WHERE id = ?", (iid,)).fetchone()
        return _stack_row(row)
    finally:
        conn.close()


def update_stack_item(
    thread_id: str,
    item_id: str,
    *,
    title: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT * FROM chat_stack_items WHERE id = ? AND thread_id = ?",
            (item_id, thread_id),
        ).fetchone()
        if row is None:
            return None
        next_title = row["title"] if title is None else title[:120]
        next_payload = _loads(row["payload"], {}) if payload is None else payload
        conn.execute(
            "UPDATE chat_stack_items SET title = ?, payload = ? WHERE id = ?",
            (next_title, _dumps(next_payload), item_id),
        )
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM chat_stack_items WHERE id = ?", (item_id,)
        ).fetchone()
        return _stack_row(updated)
    finally:
        conn.close()


def default_chat_model() -> dict[str, Any]:
    return {
        "provider": "platform",
        "model": "",
        "credential_name": "",
        "local_llm_base_url": "http://127.0.0.1:8000",
        "local_llm_config_id": "",
        "max_rounds": MAX_ROUNDS_DEFAULT,
    }


def get_chat_model(space_id: str) -> dict[str, Any]:
    """Per-space chat model settings. Never includes a secret value."""
    spaces.ensure_catalog_space_schema()
    cfg = default_chat_model()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT chat_model FROM spaces WHERE id = ?", (space_id.strip(),)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return cfg
    parsed = _loads(row["chat_model"], {})
    if not isinstance(parsed, dict):
        return cfg
    provider = str(parsed.get("provider") or "platform").strip()
    cfg["provider"] = provider if provider in CHAT_PROVIDERS else "platform"
    cfg["model"] = str(parsed.get("model") or "").strip()
    cfg["credential_name"] = str(parsed.get("credential_name") or "").strip()
    base = str(parsed.get("local_llm_base_url") or "").strip()
    cfg["local_llm_base_url"] = base or cfg["local_llm_base_url"]
    cfg["local_llm_config_id"] = str(parsed.get("local_llm_config_id") or "").strip()
    cfg["max_rounds"] = clamp_max_rounds(parsed.get("max_rounds", MAX_ROUNDS_DEFAULT))
    return cfg


def set_chat_model(space_id: str, raw: dict[str, Any]) -> dict[str, Any]:
    current = get_chat_model(space_id)
    provider = str(raw.get("provider") or current["provider"]).strip()
    if provider not in CHAT_PROVIDERS:
        raise ValueError("provider must be platform, anthropic, openai, gemini, or local_llm")
    current["provider"] = provider
    if "model" in raw:
        current["model"] = str(raw.get("model") or "").strip()
    if "credential_name" in raw:
        current["credential_name"] = str(raw.get("credential_name") or "").strip()
    if "local_llm_base_url" in raw:
        base = str(raw.get("local_llm_base_url") or "").strip()
        current["local_llm_base_url"] = base or "http://127.0.0.1:8000"
    if "local_llm_config_id" in raw:
        current["local_llm_config_id"] = str(raw.get("local_llm_config_id") or "").strip()
    if "max_rounds" in raw:
        current["max_rounds"] = clamp_max_rounds(raw.get("max_rounds"))
    spaces.ensure_catalog_space_schema()
    conn = _conn()
    try:
        cur = conn.execute(
            "UPDATE spaces SET chat_model = ? WHERE id = ?",
            (json.dumps(current), space_id.strip()),
        )
        if cur.rowcount == 0:
            raise ValueError(f"Unknown space id: {space_id!r}")
        conn.commit()
    finally:
        conn.close()
    return get_chat_model(space_id)
