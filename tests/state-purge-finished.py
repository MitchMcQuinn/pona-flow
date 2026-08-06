"""
Diagnostic test for ``catalog.purge_finished_state_packages``.

Verifies that cleaning up the ``state`` table after a run removes only finished
run packages (status ``inactive`` with a ``run_start_date``) while preserving:
  - freshly composed-but-unrun packages (``run_start_date`` NULL),
  - in-flight runs (``active`` / ``pending``),
  - the explicitly excluded row (a just-finished run that may be re-run).

Runs against a throwaway SQLite catalog DB (no Neo4j needed).

Run: ``python tests/state-purge-finished.py`` from the repo root.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import catalog, config  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def _existing_ids() -> set[str]:
    conn = catalog.catalog_conn()
    try:
        return {row[0] for row in conn.execute("SELECT id FROM state").fetchall()}
    finally:
        conn.close()


tmpdir = tempfile.mkdtemp(prefix="pona-flow-purge-test-")
tmp_db = Path(tmpdir) / "data.db"
_original_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

try:
    pkg = {"steps": [], "response_parameters": []}

    composed_id = catalog.insert_state_package(pkg, status="inactive", run_start_date=None)
    finished_a = catalog.insert_state_package(pkg, status="inactive", run_start_date="2026-01-01T00:00:00")
    finished_b = catalog.insert_state_package(pkg, status="inactive", run_start_date="2026-01-02T00:00:00")
    active_id = catalog.insert_state_package(pkg, status="active", run_start_date="2026-01-03T00:00:00")
    pending_id = catalog.insert_state_package(pkg, status="pending", run_start_date="2026-01-04T00:00:00")

    check("seeded five state rows", len(_existing_ids()) == 5)

    # Purge excluding the most-recent finished run (as run_execution does).
    removed = catalog.purge_finished_state_packages(exclude_id=finished_b)
    remaining = _existing_ids()

    check("removed exactly one finished run", removed == 1)
    check("deleted the older finished run", finished_a not in remaining)
    check("kept the excluded (current) finished run", finished_b in remaining)
    check("kept the composed-but-unrun package", composed_id in remaining)
    check("kept the active run", active_id in remaining)
    check("kept the pending run", pending_id in remaining)

    # A second purge with no exclusion clears the remaining finished run too.
    removed2 = catalog.purge_finished_state_packages()
    remaining2 = _existing_ids()

    check("second purge removes the last finished run", removed2 == 1)
    check("finished run fully cleared", finished_b not in remaining2)
    check("composed/active/pending all survive", remaining2 == {composed_id, active_id, pending_id})

    # Purging when nothing qualifies is a no-op.
    removed3 = catalog.purge_finished_state_packages()
    check("no-op purge removes nothing", removed3 == 0)

    # --- delete_unrun_state_packages (compose replace-previous) ----------------
    def seq_pkg(seq: str, owner: str, space: str) -> dict:
        return {"steps": [], "sequence_query_id": seq, "owner_id": owner, "space_id": space}

    # Same user re-composing sequence S1 in space SP1: prior unrun row is replaced.
    unrun_old = catalog.insert_state_package(seq_pkg("S1", "userA", "SP1"))
    # Another user's unrun package for the same sequence must survive.
    other_user = catalog.insert_state_package(seq_pkg("S1", "userB", "SP1"))
    # Same user, different sequence: untouched.
    other_seq = catalog.insert_state_package(seq_pkg("S2", "userA", "SP1"))
    # Same user/sequence but already run (run_start_date set): not "unrun", untouched.
    already_run = catalog.insert_state_package(
        seq_pkg("S1", "userA", "SP1"), run_start_date="2026-02-01T00:00:00"
    )

    removed_unrun = catalog.delete_unrun_state_packages("S1", owner_id="userA", space_id="SP1")
    after = _existing_ids()

    check("replace removes exactly the prior unrun package", removed_unrun == 1)
    check("prior unrun package deleted", unrun_old not in after)
    check("other user's unrun package preserved", other_user in after)
    check("same user's other sequence preserved", other_seq in after)
    check("already-run package preserved", already_run in after)
finally:
    config.catalog_sqlite_path = _original_path  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
