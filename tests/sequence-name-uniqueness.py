"""
Diagnostic test for sequence-name and group-title uniqueness (spaces module).

A sequence's name becomes its wrapping STEP node's attributive_label. Two sequences in
the same space may not share a create-time name. A stored sequence belongs to a space
when one of its STEP labels is registered on that space's ``labels``. Group titles must
be unique (case-insensitive) within a space.

This test stands up a real temporary catalog DB and monkeypatches connection resolution
so spaces.sequence_name_conflict, spaces.canonical_group_title, spaces.append_space_group,
and spaces.set_space_groups run for real without Neo4j.

Run: `python tests/sequence-name-uniqueness.py` from the repo root.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config, spaces  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")
    if not condition:
        failures.append(name)


# --- Temp catalog DB ---------------------------------------------------------------------
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
DB_PATH = Path(_tmp.name)

config.catalog_sqlite_path = lambda: DB_PATH  # type: ignore


def seed() -> None:
    conn = config.connect_sqlite(DB_PATH)
    try:
        conn.executescript(
            """
            CREATE TABLE spaces (
              id TEXT PRIMARY KEY, name TEXT, labels TEXT, groups TEXT,
              neo4j_uri_key TEXT, neo4j_user_key TEXT
            );
            CREATE TABLE queries (
              id TEXT PRIMARY KEY, name TEXT, kind TEXT, cypher TEXT
            );
            """
        )

        def space(sid, labels):
            conn.execute(
                "INSERT INTO spaces (id, name, labels, groups, neo4j_uri_key, "
                "neo4j_user_key) VALUES (?,?,?,?,?,?)",
                (
                    sid,
                    sid,
                    spaces.format_space_labels_column(labels),
                    spaces.format_space_groups_column([]),
                    f"{sid}_NEO4J_URI",
                    f"{sid}_NEO4J_USER",
                ),
            )

        space("A", ["Alpha"])
        space("B", ["Beta"])

        def sequence(qid, name, step_label):
            conn.execute(
                "INSERT INTO queries (id, name, kind, cypher) VALUES (?,?,?,?)",
                (
                    qid,
                    name,
                    "sequence",
                    f'["MATCH (s:STEP {{ attributive_label: \'{step_label}\' }}) RETURN s"]',
                ),
            )

        sequence("q-alpha", "Alpha", "Alpha")
        sequence("q-beta", "Beta", "Beta")
        conn.commit()
    finally:
        conn.close()


seed()

# --- sequence_name_conflict --------------------------------------------------------------
check(
    "duplicate name in the same space conflicts",
    spaces.sequence_name_conflict("A", "Alpha") == "Alpha",
)
check(
    "duplicate name is case-insensitive",
    spaces.sequence_name_conflict("A", "alpha") == "Alpha",
)
check(
    "fresh name in the same space is allowed",
    spaces.sequence_name_conflict("A", "Gamma") is None,
)
check(
    "re-saving the same sequence is allowed (exclude_id)",
    spaces.sequence_name_conflict("A", "Alpha", exclude_id="q-alpha") is None,
)
check(
    "another space's sequence name does not conflict",
    spaces.sequence_name_conflict("A", "Beta") is None,
)
check(
    "name used only in space B does not block space A",
    spaces.sequence_name_conflict("B", "Alpha") is None,
)
check("empty name never conflicts", spaces.sequence_name_conflict("A", "  ") is None)
check(
    "unknown space has no labels so no conflict",
    spaces.sequence_name_conflict("ZZZ", "Alpha") is None,
)

# --- remove_attributive_labels_from_all_spaces ------------------------------------------
stripped = spaces.remove_attributive_labels_from_all_spaces(["Alpha"])
check("purge strip hits every space that listed the label", stripped == {"A": ["Alpha"]})
check("space A labels empty after strip", spaces.fetch_space_labels("A") == [])
check("space B labels untouched", spaces.fetch_space_labels("B") == ["Beta"])
# Restore A's label for the group-title checks below.
spaces.append_space_attributive_labels("A", ["Alpha"])

# --- group titles: unique (case-insensitive) within a space ------------------------------
spaces.append_space_group("A", "Reports")
spaces.append_space_group("A", "reports")  # case-only duplicate must not add a second group
check("group dedup is case-insensitive", spaces.fetch_space_groups("A") == ["Reports"])
check(
    "canonical_group_title resolves to existing casing",
    spaces.canonical_group_title("A", "REPORTS") == "Reports",
)
check(
    "canonical_group_title passes through a new title",
    spaces.canonical_group_title("A", "Dashboards") == "Dashboards",
)

spaces.set_space_groups("A", ["One", "one", "Two"])
check("set_space_groups drops case-only duplicates", spaces.fetch_space_groups("A") == ["One", "Two"])

DB_PATH.unlink(missing_ok=True)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
