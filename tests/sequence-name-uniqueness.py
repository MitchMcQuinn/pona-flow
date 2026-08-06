"""
Diagnostic test for sequence-name and group-title uniqueness (spaces module).

A sequence's name becomes its wrapping STEP node's attributive_label, which must be unique
within an underlying graph. Spaces resolving to the same Neo4j store form one namespace; a
private space is isolated. Group titles must be unique (case-insensitive) within a space.

This test stands up a real temporary catalog DB and monkeypatches connection/env resolution
so spaces.sequence_name_conflict, spaces.space_ids_sharing_graph, spaces.canonical_group_title,
spaces.append_space_group, and spaces.set_space_groups run for real without Neo4j.

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

# Two public spaces (A, B) resolve to the same Neo4j store; a private space (P) is isolated.
ENV = {
    "A_NEO4J_URI": "bolt://shared",
    "B_NEO4J_URI": "bolt://shared",
    "P_NEO4J_URI": "bolt://private",
    "NEO4J_URI": "bolt://default",
    "NEO4J_USER": "neo4j",
}
config.env_value = lambda key, fallback_key=None: ENV.get(  # type: ignore
    key, ENV.get(fallback_key or "", "")
)


def seed() -> None:
    conn = config.connect_sqlite(DB_PATH)
    try:
        conn.executescript(
            """
            CREATE TABLE spaces (
              id TEXT PRIMARY KEY, name TEXT, labels TEXT, groups TEXT,
              neo4j_uri_key TEXT, neo4j_user_key TEXT, is_private INTEGER DEFAULT 0
            );
            CREATE TABLE queries (
              id TEXT PRIMARY KEY, name TEXT, kind TEXT, cypher TEXT
            );
            """
        )

        def space(sid, labels, private=0):
            conn.execute(
                "INSERT INTO spaces (id, name, labels, groups, neo4j_uri_key, "
                "neo4j_user_key, is_private) VALUES (?,?,?,?,?,?,?)",
                (
                    sid,
                    sid,
                    spaces.format_space_labels_column(labels),
                    spaces.format_space_groups_column([]),
                    f"{sid}_NEO4J_URI",
                    f"{sid}_NEO4J_USER",
                    private,
                ),
            )

        space("A", ["Alpha"])
        space("B", ["Beta"])
        space("P", ["Priv"], private=1)

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

        # Existing sequences. "Alpha" lives in public space A; "Priv" lives in private space P.
        sequence("q-alpha", "Alpha", "Alpha")
        sequence("q-priv", "Priv", "Priv")
        conn.commit()
    finally:
        conn.close()


seed()

# --- space_ids_sharing_graph -------------------------------------------------------------
check("public spaces with same store share a graph", set(spaces.space_ids_sharing_graph("A")) == {"A", "B"})
check("private space is its own cohort", spaces.space_ids_sharing_graph("P") == ["P"])
check("unknown space -> itself", spaces.space_ids_sharing_graph("ZZZ") == ["ZZZ"])

# --- sequence_name_conflict --------------------------------------------------------------
check(
    "duplicate name in same public graph conflicts",
    spaces.sequence_name_conflict("B", "Alpha") == "Alpha",
)
check(
    "duplicate name is case-insensitive",
    spaces.sequence_name_conflict("B", "alpha") == "Alpha",
)
check(
    "fresh name in same graph is allowed",
    spaces.sequence_name_conflict("B", "Gamma") is None,
)
check(
    "re-saving the same sequence is allowed (exclude_id)",
    spaces.sequence_name_conflict("A", "Alpha", exclude_id="q-alpha") is None,
)
check(
    "private-space sequence name does not leak to public graph",
    spaces.sequence_name_conflict("A", "Priv") is None,
)
check(
    "public-space sequence name does not leak into private graph",
    spaces.sequence_name_conflict("P", "Alpha") is None,
)
check("empty name never conflicts", spaces.sequence_name_conflict("A", "  ") is None)

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
