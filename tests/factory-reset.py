"""
Diagnostic test for space reset and factory reset (Engine/server/reset.py).

Space reset clears one space's graph and the SQLite rows tied to its labels, and
leaves the space, its credentials, members, settings, and other spaces in place.
Factory reset erases accounts and catalog data so first-run setup is required again.

Runs against a throwaway SQLite file. Neo4j is stubbed.

Run (from repo root, with the project venv):
    .venv/bin/python tests/factory-reset.py
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config, credentials, embeddings, graph, reset, spaces  # noqa: E402

failures: list[str] = []
SCHEMA = config.ROOT / "Engine" / "schema"


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def build_db() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="pona-flow-reset-test-")) / "data.db"
    conn = config.connect_sqlite(tmp)
    for filename in (
        "queries-table.sql",
        "entities-table.sql",
        "events-table.sql",
        "users-table.sql",
        "local-credentials-table.sql",
        "space-credentials-table.sql",
        "space-members-table.sql",
        "audit-log-table.sql",
        "chat-tables.sql",
        "state-table.sql",
        "sessions-table.sql",
        "regex-table.sql",
    ):
        conn.executescript((SCHEMA / filename).read_text(encoding="utf-8"))
    conn.execute(
        "CREATE TABLE IF NOT EXISTS spaces ("
        "id TEXT PRIMARY KEY, name TEXT, creation_date TEXT, "
        "sqlite_database_path_key TEXT, labels TEXT, groups TEXT, "
        "event_groups TEXT, console_groups TEXT, chat_model TEXT, description TEXT)"
    )
    conn.execute(
        "INSERT INTO spaces (id, name, creation_date, sqlite_database_path_key, labels, "
        "groups, event_groups, console_groups, chat_model, description) VALUES "
        "(?, ?, datetime('now'), 'SQLITE_DATABASE_PATH', ?, ?, ?, ?, ?, ?)",
        (
            "clinic",
            "Clinic",
            spaces.format_space_labels_column(["badge", "nurse"]),
            spaces.format_space_groups_column(["Nightly"]),
            spaces.format_space_groups_column(["Alerts"]),
            spaces.format_space_groups_column(["Boards"]),
            '{"provider":"ollama"}',
            "ward tools",
        ),
    )
    conn.execute(
        "INSERT INTO spaces (id, name, creation_date, sqlite_database_path_key, labels, "
        "groups, event_groups, console_groups, chat_model, description) VALUES "
        "(?, ?, datetime('now'), 'SQLITE_DATABASE_PATH', ?, '{}', '{}', '{}', '{}', '')",
        ("other", "Other", spaces.format_space_labels_column(["invoice"])),
    )
    badge = json.dumps(["MATCH (n:INSTANCE {attributive_label: 'badge'}) RETURN n"])
    invoice = json.dumps(["MATCH (n:INSTANCE {attributive_label: 'invoice'}) RETURN n"])
    orphan = json.dumps(["RETURN 1"])
    system = json.dumps(["MATCH (n:STEP {attributive_label: 'badge'}) RETURN n"])
    conn.execute(
        "INSERT INTO queries (id, name, kind, cypher) VALUES (?, ?, 'operation', ?)",
        ("q_badge", "badge count", badge),
    )
    conn.execute(
        "INSERT INTO queries (id, name, kind, cypher) VALUES (?, ?, 'operation', ?)",
        ("q_invoice", "invoice count", invoice),
    )
    conn.execute(
        "INSERT INTO queries (id, name, kind, cypher) VALUES (?, ?, 'operation', ?)",
        ("q_orphan", "orphan", orphan),
    )
    conn.execute(
        "INSERT INTO queries (id, name, kind, cypher) VALUES (?, ?, 'system', ?)",
        ("sys_keep", "system badge", system),
    )
    conn.execute(
        "INSERT INTO entities (id, node_label, common_label, payload) VALUES "
        "('e_badge', 'SCHEMA', 'badge', '{}')"
    )
    conn.execute(
        "INSERT INTO entities (id, node_label, common_label, payload) VALUES (?, 'STEP', 'badge', ?)",
        ("e_orphan", json.dumps({"query_id": "q_orphan"})),
    )
    conn.execute(
        "INSERT INTO entities (id, node_label, common_label, payload) VALUES "
        "('e_invoice', 'SCHEMA', 'invoice', '{}')"
    )
    conn.execute(
        "INSERT INTO events (id, space_id, name) VALUES ('ev_clinic', 'clinic', 'sweep')"
    )
    conn.execute(
        "INSERT INTO events (id, space_id, name) VALUES ('ev_other', 'other', 'billing')"
    )
    conn.execute(
        "INSERT INTO space_credentials (id, space_id, name, env_key) VALUES "
        "('cred1', 'clinic', 'HOOK', 'CLINIC_CRED_HOOK')"
    )
    conn.execute(
        "INSERT INTO users (id, email, is_instance_admin) VALUES ('u1', 'ada@example.com', 1)"
    )
    conn.execute(
        "INSERT INTO local_credentials (user_id, email, password_hash) VALUES "
        "('u1', 'ada@example.com', 'scrypt$1$1$1$aa$bb')"
    )
    conn.execute(
        "INSERT INTO space_members (id, space_id, principal_id, invited_email, is_owner) "
        "VALUES ('m1', 'clinic', 'u1', 'ada@example.com', 1)"
    )
    conn.execute("INSERT INTO audit_log (id, space_id) VALUES ('a1', 'clinic')")
    conn.execute(
        "INSERT INTO chat_threads (id, space_id, user_id, title) VALUES "
        "('t1', 'clinic', 'u1', 'hello')"
    )
    conn.execute(
        "INSERT INTO state (id, package) VALUES ('s1', ?)",
        (json.dumps({"space_id": "clinic"}),),
    )
    conn.commit()
    conn.close()
    return tmp


def ids(conn, table: str) -> list[str]:
    return [str(row[0]) for row in conn.execute(f"SELECT id FROM {table}")]


def main() -> None:
    tmp = build_db()
    config.catalog_sqlite_path = lambda: tmp  # type: ignore[assignment]
    spaces.sqlite_path_for_space = lambda space_id: tmp  # type: ignore[assignment]

    calls: list[tuple[str, str]] = []
    drops: list[str] = []
    deleted_secrets: list[str] = []
    mode = {"fail": True, "shared": True}

    def fake_cypher(space_id, cypher, params=None):
        if mode["fail"]:
            raise RuntimeError("neo4j down")
        calls.append((space_id, cypher))
        return {}

    def fake_drop(space_id):
        drops.append(space_id)
        return {}

    def fake_neo4j(space_id):
        uri = "bolt://shared" if mode["shared"] else f"bolt://{space_id}"
        return {"uri": uri, "user": "neo4j", "password": "pw"}

    class Store:
        def delete(self, env_key: str) -> None:
            deleted_secrets.append(env_key)

    graph.run_cypher_for_space = fake_cypher  # type: ignore[assignment]
    embeddings.drop_vector_indexes = fake_drop  # type: ignore[assignment]
    spaces.neo4j_config_for_space = fake_neo4j  # type: ignore[assignment]
    credentials.get_store = lambda: Store()  # type: ignore[assignment]

    try:
        reset.reset_space("clinic")
        check("graph failure raises", False)
    except RuntimeError:
        check("graph failure raises", True)
    conn = config.connect_sqlite(tmp)
    check("graph failure keeps entities", "e_badge" in ids(conn, "entities"))
    check("graph failure keeps the space", "clinic" in ids(conn, "spaces"))
    conn.close()

    mode["fail"] = False
    reset.reset_space("clinic")
    clinic_calls = [cypher for sid, cypher in calls if sid == "clinic"]
    check(
        "shared graph deletes only this space's labels",
        any("attributive_label IN $labels" in cypher for cypher in clinic_calls)
        and all(cypher != "MATCH (n) DETACH DELETE n" for cypher in clinic_calls),
    )
    check("shared graph keeps the other space's vector index", drops == [])

    conn = config.connect_sqlite(tmp)
    entity_ids = ids(conn, "entities")
    query_ids = ids(conn, "queries")
    check(
        "space reset removes its entities",
        "e_badge" not in entity_ids and "e_orphan" not in entity_ids,
    )
    check("space reset keeps the other space's entities", "e_invoice" in entity_ids)
    check(
        "space reset removes its queries",
        "q_badge" not in query_ids and "q_orphan" not in query_ids,
    )
    check("space reset keeps the other space's queries", "q_invoice" in query_ids)
    check("space reset keeps system queries", "sys_keep" in query_ids)
    check("space reset removes its events", "ev_clinic" not in ids(conn, "events"))
    check("space reset keeps the other space's events", "ev_other" in ids(conn, "events"))
    check("space reset removes its chat", ids(conn, "chat_threads") == [])
    check("space reset removes its in-flight runs", ids(conn, "state") == [])
    check("space reset keeps credentials", "cred1" in ids(conn, "space_credentials"))
    check("space reset keeps members", "m1" in ids(conn, "space_members"))
    check("space reset keeps the account", "u1" in ids(conn, "users"))
    check("space reset keeps the audit log", "a1" in ids(conn, "audit_log"))
    labels = conn.execute(
        "SELECT labels, chat_model, description FROM spaces WHERE id = 'clinic'"
    ).fetchone()
    check("space reset clears authored labels", json.loads(labels[0])["labels"] == [])
    check("space reset keeps chat settings", labels[1] == '{"provider":"ollama"}')
    check("space reset keeps the description", labels[2] == "ward tools")
    other_labels = conn.execute("SELECT labels FROM spaces WHERE id = 'other'").fetchone()
    check("other space labels stay", json.loads(other_labels[0])["labels"] == ["invoice"])
    conn.close()

    calls.clear()
    result = reset.factory_reset()
    check("factory reset asks for setup", result.get("setup_required") is True)
    check("factory reset removes credential secrets", deleted_secrets == ["CLINIC_CRED_HOOK"])
    check(
        "factory reset wipes each space graph",
        {sid for sid, cypher in calls if cypher == "MATCH (n) DETACH DELETE n"}
        == {"clinic", "other"},
    )
    conn = config.connect_sqlite(tmp)
    check("factory reset removes spaces", ids(conn, "spaces") == [])
    check("factory reset removes accounts", ids(conn, "users") == [])
    check("factory reset removes credentials", ids(conn, "space_credentials") == [])
    check("factory reset removes entities", ids(conn, "entities") == [])
    check("factory reset removes the audit log", ids(conn, "audit_log") == [])
    check(
        "factory reset restores system queries",
        "sys_create_step_node" in ids(conn, "queries") and "q_invoice" not in ids(conn, "queries"),
    )
    regex_names = [row[0] for row in conn.execute("SELECT name FROM regex")]
    check("factory reset restores regex patterns", "email" in regex_names)
    conn.close()

    exclusive = build_db()
    config.catalog_sqlite_path = lambda: exclusive  # type: ignore[assignment]
    spaces.sqlite_path_for_space = lambda space_id: exclusive  # type: ignore[assignment]
    mode["shared"] = False
    calls.clear()
    drops.clear()
    reset.reset_space("clinic")
    check(
        "exclusive graph is wiped entirely",
        ("clinic", "MATCH (n) DETACH DELETE n") in calls,
    )
    check("exclusive graph drops vector indexes", drops == ["clinic"])
    conn = config.connect_sqlite(exclusive)
    check(
        "exclusive reset still keeps the other space's entity",
        "e_invoice" in ids(conn, "entities"),
    )
    conn.close()


if __name__ == "__main__":
    main()
    if failures:
        print(f"\n{len(failures)} failed")
        sys.exit(1)
    print("\nfactory reset ok")
