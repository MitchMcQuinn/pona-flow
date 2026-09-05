"""
Development-only "big red button": wipe every store back to a clean slate.

What it clears
--------------
1. Neo4j: ``MATCH (n) DETACH DELETE n`` on every distinct connection used by the catalog
   spaces (plus the shared default connection).
2. SQLite: every row of every table in every distinct catalog / per-space database file
   (``spaces``, ``queries``, ``state``, ``regex``, ``users``, ``space_members``,
   ``entities``, …). Table *schemas* are kept, so the app works immediately — no restart
   or migration needed.

Safety
------
- Defaults to a **dry run** that only reports what it would touch. Pass ``--confirm`` to
  actually mutate anything. This is irreversible.
- Intended for early-development scratch data only. Never point it at anything real.

Usage (from the repository root)
--------------------------------
    python tools/dev_reset.py              # dry run: list connections + files
    python tools/dev_reset.py --confirm    # actually wipe Neo4j + clear SQLite
    python tools/dev_reset.py --confirm --skip-graph   # SQLite only

Use the project venv so the neo4j driver is available (``pip install -r requirements.txt``):

    .venv/bin/python tools/dev_reset.py --confirm
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config, graph, spaces  # noqa: E402

_VENV_PYTHON = Path(__file__).resolve().parents[1] / ".venv" / "bin" / "python"


def _load_env() -> None:
    config.load_env_file(config.ROOT / ".env")


def _space_ids() -> list[str]:
    """All catalog space ids (empty if the catalog db does not exist yet)."""
    path = config.catalog_sqlite_path()
    if not path.is_file():
        return []
    conn = config.connect_sqlite(path)
    try:
        try:
            rows = conn.execute("SELECT id FROM spaces ORDER BY id").fetchall()
        except sqlite3.OperationalError:
            return []
        return [(row[0] or "").strip() for row in rows if (row[0] or "").strip()]
    finally:
        conn.close()


def _collect_neo4j_connections(space_ids: list[str]) -> list[tuple[str, str, str]]:
    """Distinct (uri, user, password) tuples across the default + every space."""
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str, str]] = []

    def add(cfg: dict[str, str]) -> None:
        key = (cfg["uri"], cfg["user"])
        if key in seen:
            return
        seen.add(key)
        out.append((cfg["uri"], cfg["user"], cfg["password"]))

    try:
        add(
            {
                "uri": config.env_value(spaces.DEFAULT_NEO4J_URI_KEY),
                "user": config.env_value(spaces.DEFAULT_NEO4J_USER_KEY),
                "password": config.env_value(spaces.DEFAULT_NEO4J_PASSWORD_KEY),
            }
        )
    except (KeyError, ValueError):
        pass

    for sid in space_ids:
        try:
            add(spaces.neo4j_config_for_space(sid))
        except (KeyError, ValueError) as exc:
            print(f"  ! skipping graph for space {sid!r}: {exc}")
    return out


def _collect_sqlite_paths(space_ids: list[str]) -> list[Path]:
    """Distinct, existing SQLite file paths across the catalog + every space."""
    seen: set[Path] = set()
    out: list[Path] = []

    def add(path: Path) -> None:
        resolved = path.resolve()
        if resolved in seen or not resolved.is_file():
            return
        seen.add(resolved)
        out.append(resolved)

    try:
        add(config.catalog_sqlite_path())
    except (KeyError, ValueError):
        pass
    for sid in space_ids:
        try:
            add(spaces.sqlite_path_for_space(sid))
        except (KeyError, ValueError) as exc:
            print(f"  ! skipping sqlite for space {sid!r}: {exc}")
    return out


def _neo4j_driver_hint() -> str:
    script = Path(__file__).relative_to(Path(__file__).resolve().parents[1])
    if _VENV_PYTHON.is_file():
        return f"Try: {_VENV_PYTHON} {script} --confirm"
    return "Install the driver: pip install neo4j  (or pip install -r requirements.txt)"


def _require_neo4j_driver(*, confirm: bool) -> bool:
    """Return True when the neo4j Python driver is importable."""
    if graph.GraphDatabase is not None:
        return True
    hint = _neo4j_driver_hint()
    if confirm:
        print(
            "ERROR: neo4j Python driver not installed — graph was NOT wiped.\n"
            f"  {hint}",
            file=sys.stderr,
        )
        return False
    print(f"  ! neo4j driver not installed; graph wipe would be skipped. {hint}")
    return False


def _wipe_graph(connections: list[tuple[str, str, str]]) -> bool:
    """Wipe every listed Neo4j connection. Return False if any connection failed."""
    ok = True
    for uri, user, password in connections:
        driver = None
        try:
            driver = graph.GraphDatabase.driver(
                graph.direct_bolt_uri(uri), auth=(user, password)
            )
            with driver.session() as session:
                summary = session.run("MATCH (n) DETACH DELETE n").consume()
                deleted = summary.counters.nodes_deleted
            print(f"  - {uri} ({user}): deleted {deleted} node(s)")
        except Exception as exc:
            ok = False
            print(f"  ! {uri} ({user}): failed ({exc})", file=sys.stderr)
        finally:
            if driver is not None:
                driver.close()
    return ok


def _clear_sqlite(paths: list[Path]) -> None:
    for path in paths:
        conn = config.connect_sqlite(path)
        try:
            tables = [
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' "
                    "AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            ]
            for table in tables:
                conn.execute(f'DELETE FROM "{table}"')
            conn.commit()
            conn.execute("VACUUM")
            print(f"  - {path}: cleared {len(tables)} table(s)")
        finally:
            conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Reset all pona flow dev stores.")
    parser.add_argument(
        "--confirm", action="store_true", help="Actually wipe (otherwise dry run)."
    )
    parser.add_argument(
        "--skip-graph", action="store_true", help="Clear SQLite only; leave Neo4j alone."
    )
    args = parser.parse_args()

    _load_env()
    space_ids = _space_ids()
    connections = [] if args.skip_graph else _collect_neo4j_connections(space_ids)
    paths = _collect_sqlite_paths(space_ids)

    print(f"Spaces in catalog: {len(space_ids)} -> {space_ids or '[]'}")
    print(f"Neo4j connections to wipe: {len(connections)}")
    for uri, user, _ in connections:
        print(f"  - {uri} ({user})")
    if connections and not args.skip_graph:
        _require_neo4j_driver(confirm=False)
    print(f"SQLite files to clear: {len(paths)}")
    for path in paths:
        print(f"  - {path}")

    if not args.confirm:
        print("\nDRY RUN — nothing changed. Re-run with --confirm to wipe.")
        return 0

    graph_ok = True
    print("\nWiping Neo4j graph(s)…")
    if not args.skip_graph:
        if not connections:
            print("  (no connections resolved)")
        elif not _require_neo4j_driver(confirm=True):
            graph_ok = False
        else:
            graph_ok = _wipe_graph(connections)
    else:
        print("  (skipped)")

    print("Clearing SQLite tables…")
    _clear_sqlite(paths)

    if not graph_ok:
        print(
            "\nSQLite was cleared, but Neo4j was not fully wiped. "
            "Fix the graph errors above and re-run.",
            file=sys.stderr,
        )
        return 1

    print("\nDone. All dev stores reset to a clean slate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
