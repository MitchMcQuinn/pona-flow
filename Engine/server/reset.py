"""
Reset a space's authored data, or return the whole instance to first-run setup.

Space reset clears the graph that space is connected to and the SQLite rows that
belong to it (entities, sequences, events, consoles, chat, in-flight runs). The
space row stays, and so do members, roles, agent keys, credential metadata, chat
and embedding settings, and the audit log.

Factory reset does that for every space, then deletes accounts, sessions, and
catalog rows and restores the built-in system queries. With no local account
left, ``setup_required()`` is true and the UI opens the first-run setup page.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any

from . import config, credentials, cypher_utils, embeddings, graph, spaces, sqlite_util

log = logging.getLogger("pona_flow.reset")

_WIPE_GRAPH = "MATCH (n) DETACH DELETE n"
_WIPE_GRAPH_BY_LABEL = "MATCH (n) WHERE n.attributive_label IN $labels DETACH DELETE n"
_WIPE_RELS_BY_LABEL = "MATCH ()-[r]-() WHERE r.attributive_label IN $labels DELETE r"

# Catalog tables emptied by a factory reset, children before parents. Schema stays.
_FACTORY_TABLES = (
    "simulation_emissions",
    "simulation_sessions",
    "event_test_captures",
    "events",
    "chat_stack_items",
    "chat_messages",
    "chat_threads",
    "consoles",
    "template_imports",
    "state",
    "agent_keys",
    "space_credentials",
    "space_members",
    "space_roles",
    "audit_log",
    "queries",
    "entities",
    "sessions",
    "local_credentials",
    "users",
    "spaces",
    "regex",
)


def reset_space(space_id: str) -> dict[str, Any]:
    """Clear one space's graph and authored data. Settings and accounts stay."""
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    labels = spaces.fetch_space_labels(sid)
    _wipe_graph(sid, labels)
    query_ids = _query_ids_for_space(sid, labels)
    entities_removed = _wipe_space_entities(sid, labels)
    catalog_removed = _wipe_space_catalog(sid, query_ids)
    return {
        "ok": True,
        "space_id": sid,
        "entities_removed": entities_removed,
        **catalog_removed,
    }


def factory_reset() -> dict[str, Any]:
    """Erase every space and account so the instance shows first-run setup again."""
    from . import local_auth

    space_ids = _space_ids()
    for sid in space_ids:
        _wipe_graph(sid, None)
    paths = {Path(config.catalog_sqlite_path()).resolve()}
    for sid in space_ids:
        try:
            paths.add(Path(spaces.sqlite_path_for_space(sid)).resolve())
        except (ValueError, KeyError, OSError) as exc:
            log.warning("factory reset skipped sqlite path for %s: %s", sid, exc)
    for path in paths:
        _delete_all_entities(path)
    _wipe_catalog()
    return {"ok": True, "setup_required": local_auth.setup_required()}


def _space_ids() -> list[str]:
    conn = config.connect_sqlite(config.catalog_sqlite_path())
    try:
        if not sqlite_util.table_exists(conn, "spaces"):
            return []
        return [str(row[0]) for row in conn.execute("SELECT id FROM spaces") if row[0]]
    finally:
        conn.close()


def _connection_key(space_id: str) -> tuple[str, str] | None:
    try:
        cfg = spaces.neo4j_config_for_space(space_id)
    except (ValueError, KeyError, OSError):
        return None
    uri = str(cfg.get("uri") or "").strip()
    user = str(cfg.get("user") or "").strip()
    if not uri:
        return None
    return (uri, user)


def _graph_is_shared(space_id: str) -> bool:
    """True when another space uses the same Neo4j database.

    A space's graph is the database its connection opens. Spaces that share that
    connection also share nodes, so a full wipe would clear the other space too.
    """
    mine = _connection_key(space_id)
    if mine is None:
        return False
    try:
        others = spaces.fetch_spaces()
    except (ValueError, KeyError, sqlite3.Error, OSError):
        return False
    for other in others:
        oid = str(other.get("id") or "").strip()
        if not oid or oid == space_id:
            continue
        if _connection_key(oid) == mine:
            return True
    return False


def _wipe_graph(space_id: str, labels: list[str] | None) -> None:
    """Delete graph data for one space. ``labels is None`` wipes the whole database."""
    if labels is None or not _graph_is_shared(space_id):
        graph.run_cypher_for_space(space_id, _WIPE_GRAPH, {})
        try:
            embeddings.drop_vector_indexes(space_id)
        except (ValueError, OSError, RuntimeError) as exc:
            log.warning("vector index drop failed for %s: %s", space_id, exc)
        return
    names = _graph_label_values(labels)
    if not names:
        return
    params = {"labels": names}
    graph.run_cypher_for_space(space_id, _WIPE_GRAPH_BY_LABEL, params)
    graph.run_cypher_for_space(space_id, _WIPE_RELS_BY_LABEL, params)


def _label_set(labels: list[str]) -> set[str]:
    return {
        cypher_utils.normalize_attributive_label(label)
        for label in labels
        if cypher_utils.normalize_attributive_label(label)
    }


def _graph_label_values(labels: list[str]) -> list[str]:
    """Raw and normalized forms, so a graph property matches either spelling."""
    values: set[str] = set()
    for label in labels:
        raw = str(label or "").strip()
        if raw:
            values.add(raw)
        normalized = cypher_utils.normalize_attributive_label(label)
        if normalized:
            values.add(normalized)
    return sorted(values)


def _sqlite_is_dedicated(space_id: str) -> bool:
    """True when no other space, and not the catalog, uses this SQLite file."""
    try:
        path = Path(spaces.sqlite_path_for_space(space_id)).resolve()
    except (ValueError, KeyError, OSError):
        return False
    if path == Path(config.catalog_sqlite_path()).resolve():
        return False
    try:
        others = spaces.fetch_spaces()
    except (ValueError, KeyError, sqlite3.Error, OSError):
        return True
    for other in others:
        oid = str(other.get("id") or "").strip()
        if not oid or oid == space_id:
            continue
        try:
            other_path = Path(spaces.sqlite_path_for_space(oid)).resolve()
        except (ValueError, KeyError, OSError):
            continue
        if other_path == path:
            return False
    return True


def _wipe_space_entities(space_id: str, labels: list[str]) -> int:
    path = spaces.sqlite_path_for_space(space_id)
    conn = config.connect_sqlite(path)
    try:
        if not sqlite_util.table_exists(conn, "entities"):
            return 0
        if _sqlite_is_dedicated(space_id):
            cur = conn.execute("DELETE FROM entities")
            conn.commit()
            return int(cur.rowcount or 0)
        names = _label_set(labels)
        if not names:
            return 0
        ids = [
            str(row[0])
            for row in conn.execute("SELECT id, common_label FROM entities")
            if cypher_utils.normalize_attributive_label(row[1]) in names
        ]
        removed = _delete_ids(conn, "entities", ids)
        conn.commit()
        return removed
    finally:
        conn.close()


def _delete_all_entities(path: Path) -> None:
    if not path.is_file():
        return
    conn = config.connect_sqlite(path)
    try:
        if sqlite_util.table_exists(conn, "entities"):
            conn.execute("DELETE FROM entities")
            conn.commit()
    finally:
        conn.close()


def _wipe_space_catalog(space_id: str, query_ids: list[str]) -> dict[str, int]:
    conn = config.connect_sqlite(config.catalog_sqlite_path())
    try:
        removed = {
            "queries_removed": _delete_user_queries(conn, query_ids),
            "events_removed": _delete_space_events(conn, space_id),
            "consoles_removed": _delete_where(conn, "consoles", "space_id = ?", (space_id,)),
            "threads_removed": _delete_space_chat(conn, space_id),
            "imports_removed": _delete_where(
                conn, "template_imports", "space_id = ?", (space_id,)
            ),
            "runs_removed": _delete_space_runs(conn, space_id),
        }
        _clear_space_authored_lists(conn, space_id)
        conn.commit()
        return removed
    finally:
        conn.close()


def _query_ids_for_space(space_id: str, labels: list[str]) -> list[str]:
    """Non-system queries this space owns, collected before its entities are deleted.

    The queries table is global. A row belongs to this space when its Cypher names
    one of the space's attributive labels, or a STEP entity in this space points at
    it through ``payload.query_id``. ``kind = system`` rows are the built-in primitives
    and are never removed here.
    """
    names = _label_set(labels)
    dedicated = _sqlite_is_dedicated(space_id)
    extra: set[str] = set()
    entity_conn = config.connect_sqlite(spaces.sqlite_path_for_space(space_id))
    try:
        if sqlite_util.table_exists(entity_conn, "entities"):
            for common_label, payload in entity_conn.execute(
                "SELECT common_label, payload FROM entities"
            ):
                if dedicated or cypher_utils.normalize_attributive_label(common_label) in names:
                    extra.update(_payload_query_ids(payload))
    finally:
        entity_conn.close()
    conn = config.connect_sqlite(config.catalog_sqlite_path())
    try:
        if not sqlite_util.table_exists(conn, "queries"):
            return []
        ids: list[str] = []
        for row in conn.execute("SELECT id, kind, cypher FROM queries"):
            if str(row[1] or "") == "system":
                continue
            qid = str(row[0])
            found = {
                cypher_utils.normalize_attributive_label(match)
                for match in cypher_utils.ATTR_LABEL_RE.findall(str(row[2] or ""))
            }
            if qid in extra or (names and found & names):
                ids.append(qid)
        return ids
    finally:
        conn.close()


def _payload_query_ids(payload: str | None) -> set[str]:
    if not payload:
        return set()
    try:
        data = json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        return set()
    if not isinstance(data, dict):
        return set()
    qid = data.get("query_id")
    return {str(qid)} if qid else set()


def _delete_space_events(conn: sqlite3.Connection, space_id: str) -> int:
    if not sqlite_util.table_exists(conn, "events"):
        return 0
    event_ids = [
        str(row[0])
        for row in conn.execute("SELECT id FROM events WHERE space_id = ?", (space_id,))
    ]
    if event_ids and sqlite_util.table_exists(conn, "event_test_captures"):
        _delete_ids(conn, "event_test_captures", event_ids, column="event_id")
    _delete_where(conn, "simulation_emissions", "space_id = ?", (space_id,))
    _delete_where(conn, "simulation_sessions", "space_id = ?", (space_id,))
    return _delete_where(conn, "events", "space_id = ?", (space_id,))


def _delete_space_chat(conn: sqlite3.Connection, space_id: str) -> int:
    if not sqlite_util.table_exists(conn, "chat_threads"):
        return 0
    thread_ids = [
        str(row[0])
        for row in conn.execute("SELECT id FROM chat_threads WHERE space_id = ?", (space_id,))
    ]
    _delete_ids(conn, "chat_stack_items", thread_ids, column="thread_id")
    _delete_ids(conn, "chat_messages", thread_ids, column="thread_id")
    return _delete_where(conn, "chat_threads", "space_id = ?", (space_id,))


def _delete_space_runs(conn: sqlite3.Connection, space_id: str) -> int:
    if not sqlite_util.table_exists(conn, "state"):
        return 0
    return _delete_where(
        conn, "state", "json_extract(package, '$.space_id') = ?", (space_id,)
    )


def _clear_space_authored_lists(conn: sqlite3.Connection, space_id: str) -> None:
    if not sqlite_util.table_exists(conn, "spaces"):
        return
    cols = sqlite_util.column_names(conn, "spaces")
    assignments: list[str] = []
    params: list[str] = []
    if "labels" in cols:
        assignments.append("labels = ?")
        params.append(spaces.format_space_labels_column([]))
    for column in ("groups", "event_groups", "console_groups"):
        if column in cols:
            assignments.append(f"{column} = ?")
            params.append(spaces.format_space_groups_column([]))
    if not assignments:
        return
    params.append(space_id)
    conn.execute(
        f"UPDATE spaces SET {', '.join(assignments)} WHERE id = ?",
        params,
    )


def _delete_user_queries(conn: sqlite3.Connection, ids: list[str]) -> int:
    if not ids or not sqlite_util.table_exists(conn, "queries"):
        return 0
    placeholders = ",".join("?" for _ in ids)
    cur = conn.execute(
        f"DELETE FROM queries WHERE kind != 'system' AND id IN ({placeholders})",
        ids,
    )
    return int(cur.rowcount or 0)


def _delete_where(
    conn: sqlite3.Connection, table: str, where: str, params: tuple[Any, ...]
) -> int:
    if not sqlite_util.table_exists(conn, table):
        return 0
    cur = conn.execute(f"DELETE FROM {table} WHERE {where}", params)
    return int(cur.rowcount or 0)


def _delete_ids(
    conn: sqlite3.Connection,
    table: str,
    ids: list[str],
    *,
    column: str = "id",
) -> int:
    if not ids or not sqlite_util.table_exists(conn, table):
        return 0
    placeholders = ",".join("?" for _ in ids)
    cur = conn.execute(
        f"DELETE FROM {table} WHERE {column} IN ({placeholders})",
        ids,
    )
    return int(cur.rowcount or 0)


def _forget_credential_secrets(conn: sqlite3.Connection) -> None:
    if not sqlite_util.table_exists(conn, "space_credentials"):
        return
    store = credentials.get_store()
    for (env_key,) in conn.execute("SELECT env_key FROM space_credentials"):
        key = str(env_key or "").strip()
        if not key:
            continue
        try:
            store.delete(key)
        except PermissionError:
            log.info("credential backend is read-only; left secret %s in place", key)


def _wipe_catalog() -> None:
    conn = config.connect_sqlite(config.catalog_sqlite_path())
    try:
        _forget_credential_secrets(conn)
        for table in _FACTORY_TABLES:
            if sqlite_util.table_exists(conn, table):
                conn.execute(f"DELETE FROM {table}")
        conn.commit()
        _reseed(conn)
    finally:
        conn.close()


def _reseed(conn: sqlite3.Connection) -> None:
    schema = config.ROOT / "Engine" / "schema"
    if sqlite_util.table_exists(conn, "regex"):
        conn.executescript((schema / "regex-table.sql").read_text(encoding="utf-8"))
    if sqlite_util.table_exists(conn, "queries"):
        conn.executescript((schema / "queries-seed-system.sql").read_text(encoding="utf-8"))
