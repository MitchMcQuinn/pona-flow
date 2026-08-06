"""
Diagnostic: schema_update._write_schema_payload keeps reusable relationship-type
copies in sync.

A SCHEMA relationship attributive_label is a reusable type: every POINTS_TO edge
sharing it carries an identical payload copy in the entities table. A validated
schema update for a relationship must rewrite *all* copies (keyed by common_label),
while node schemas stay keyed by id.

Run:  .venv/bin/python tests/schema-rel-update-sync.py
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from Engine.server import schema_update, spaces  # noqa: E402

failures: list[str] = []


def check(name: str, got, want) -> None:
    if got != want:
        failures.append(f"{name}: got {got!r}, want {want!r}")


def make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE entities ("
        "id TEXT PRIMARY KEY NOT NULL, node_label TEXT NOT NULL, common_label TEXT, "
        "parameters TEXT, payload TEXT, "
        "creation_date TEXT NOT NULL DEFAULT (datetime('now')), "
        "modified_date TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    old_payload = json.dumps(
        {
            "schemata": [
                {
                    "property_schema": {
                        "name": "id",
                        "value_type": "UID",
                        "is_required": True,
                        "is_key": True,
                        "is_label": False,
                        "is_indexed": False,
                    }
                }
            ]
        }
    )
    rows = [
        # Two copies of the reusable HAS relationship type.
        ("ID_r1", "SCHEMA", "HAS", old_payload),
        ("ID_r2", "SCHEMA", "HAS", old_payload),
        # A node schema and an unrelated relationship type must stay untouched.
        ("ID_person", "SCHEMA", "PERSON", old_payload),
        ("ID_r3", "SCHEMA", "WORKS_AT", old_payload),
    ]
    conn.executemany(
        "INSERT INTO entities (id, node_label, common_label, parameters, payload) "
        "VALUES (?, ?, ?, '[]', ?)",
        rows,
    )
    conn.commit()
    return conn


class _NoCloseConn:
    """Keep the in-memory DB alive across _write_schema_payload's close()."""

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

NEW_CONSTRAINTS = [
    {
        "key": "id",
        "value_type": "UID",
        "is_required": True,
        "is_key": True,
        "is_label": False,
        "is_indexed": False,
    },
    {
        "key": "SINCE",
        "value_type": "string",
        "is_required": False,
        "is_key": False,
        "is_label": False,
        "is_indexed": False,
    },
]

try:
    # --- relationship type: every copy of HAS rewritten ---
    schema_update._write_schema_payload(
        "space-1", "ID_r1", NEW_CONSTRAINTS, relationship_label="HAS"
    )
    payloads = {
        row[0]: json.loads(row[1])
        for row in db.execute("SELECT id, payload FROM entities").fetchall()
    }
    for rel_id in ("ID_r1", "ID_r2"):
        names = [e["property_schema"]["name"] for e in payloads[rel_id]["schemata"]]
        check(f"{rel_id}_synced", names, ["id", "SINCE"])
    for other_id in ("ID_person", "ID_r3"):
        names = [e["property_schema"]["name"] for e in payloads[other_id]["schemata"]]
        check(f"{other_id}_untouched", names, ["id"])

    # --- node schema: still keyed by id only ---
    schema_update._write_schema_payload("space-1", "ID_person", NEW_CONSTRAINTS)
    payloads = {
        row[0]: json.loads(row[1])
        for row in db.execute("SELECT id, payload FROM entities").fetchall()
    }
    person_names = [e["property_schema"]["name"] for e in payloads["ID_person"]["schemata"]]
    check("node_updated", person_names, ["id", "SINCE"])
    r3_names = [e["property_schema"]["name"] for e in payloads["ID_r3"]["schemata"]]
    check("other_rel_still_untouched", r3_names, ["id"])

    # --- unknown relationship label raises ---
    try:
        schema_update._write_schema_payload(
            "space-1", "ID_rX", NEW_CONSTRAINTS, relationship_label="NO_SUCH_TYPE"
        )
        failures.append("missing_label: expected ValueError, none raised")
    except ValueError:
        pass
finally:
    spaces.connect_sqlite_for_space = _orig_connect
    spaces.entities_node_label_column = _orig_col
    db.close()

if failures:
    for f in failures:
        print("FAIL:", f)
    sys.exit(1)
print("schema-rel-update-sync: ok")
