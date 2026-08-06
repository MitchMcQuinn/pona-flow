"""
Diagnostic: the automatic INSTANCE ``id`` is offered for RUD WHERE filters.

Every INSTANCE carries an engine-minted ``id`` graph property. When the SCHEMA author
defines no ``is_key``, the implicit UID ``id`` entry is injected into the schemata and
must now surface through graph.list_schema_property_keys_from_entities (it used to be
stripped as a reserved key), so read/update/delete WHERE filters can target it.

When the author defined their own domain ``is_key``, no implicit ``id`` entry exists
(the graph id mirrors the domain key value) and ``id`` must stay out of the list.

Run:  .venv/bin/python tests/instance-id-where-filter.py
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from Engine.server import graph, spaces  # noqa: E402

failures: list[str] = []


def check(name: str, got, want) -> None:
    if got != want:
        failures.append(f"{name}: got {got!r}, want {want!r}")


def entry(name: str, value_type: str = "string", is_key: bool = False) -> dict:
    return {
        "property_schema": {
            "name": name,
            "value_type": value_type,
            "is_required": False,
            "is_key": is_key,
            "is_label": False,
            "is_indexed": False,
        }
    }


def make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE entities ("
        "id TEXT PRIMARY KEY NOT NULL, node_label TEXT NOT NULL, common_label TEXT, "
        "parameters TEXT, payload TEXT, "
        "creation_date TEXT NOT NULL DEFAULT (datetime('now')), "
        "modified_date TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    rows = [
        # No author is_key: compose injects the implicit UID "id" entry.
        (
            "ID_person",
            "SCHEMA",
            "PERSON",
            json.dumps(
                {
                    "schemata": [
                        entry("id", "UID", is_key=True),
                        entry("NAME"),
                        entry("EMAIL"),
                    ]
                }
            ),
        ),
        # Legacy payload without the implicit entry: the server-side default
        # (_apply_schema_schemata_defaults) must still inject "id".
        (
            "ID_task",
            "SCHEMA",
            "TASK",
            json.dumps({"schemata": [entry("TITLE")]}),
        ),
        # Author-defined domain is_key: no automatic "id" entry exists, and the
        # graph id mirrors the domain key, so "id" must not be offered.
        (
            "ID_account",
            "SCHEMA",
            "ACCOUNT",
            json.dumps(
                {
                    "schemata": [
                        entry("HANDLE", is_key=True),
                        entry("PLAN"),
                    ]
                }
            ),
        ),
    ]
    conn.executemany(
        "INSERT INTO entities (id, node_label, common_label, parameters, payload) "
        "VALUES (?, ?, ?, '[]', ?)",
        rows,
    )
    conn.commit()
    return conn


class _NoCloseConn:
    """Keep the in-memory DB alive across the function's close()."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def close(self) -> None:
        pass

    def __getattr__(self, name):
        return getattr(self._conn, name)


db = make_db()
_orig_connect = spaces.connect_sqlite_for_space
_orig_col = spaces.entities_node_label_column
spaces.connect_sqlite_for_space = lambda space_id: _NoCloseConn(db)
spaces.entities_node_label_column = lambda conn: "node_label"

try:
    check(
        "implicit_uid_key_includes_id",
        graph.list_schema_property_keys_from_entities("space-1", "PERSON"),
        ["EMAIL", "id", "NAME"],
    )
    check(
        "legacy_payload_injects_id",
        graph.list_schema_property_keys_from_entities("space-1", "TASK"),
        ["id", "TITLE"],
    )
    check(
        "domain_key_excludes_id",
        graph.list_schema_property_keys_from_entities("space-1", "ACCOUNT"),
        ["HANDLE", "PLAN"],
    )
    check(
        "unknown_label_empty",
        graph.list_schema_property_keys_from_entities("space-1", ""),
        [],
    )
finally:
    spaces.connect_sqlite_for_space = _orig_connect
    spaces.entities_node_label_column = _orig_col
    db.close()

if failures:
    for f in failures:
        print("FAIL:", f)
    sys.exit(1)
print("instance-id-where-filter: ok")
