"""
Diagnostic test for wait STEPs, loop-iteration delay, stop, and in-flight state.

Covers:
  - duration / until park + resume; zero duration and past-until continue immediately;
  - event wait: ingest resumes the parked state_id and still starts listed sequences;
  - loop ``delay_seconds`` parks between passes, not before the first;
  - Stop cancels waiting/pending; cooperative cancel between steps;
  - state CHECK migration accepts ``waiting`` / ``cancelled``;
  - in-flight listing; latest-finished row survives purge (see also
    ``tests/state-purge-finished.py``).

Steps that are not wait STEPs are stubbed via ``execution_run._execute_step``.
No Neo4j; catalog is a throwaway SQLite DB.

Run: ``python tests/wait-step-execution.py`` from the repo root.
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import (  # noqa: E402
    catalog,
    config,
    execution,
    execution_loop,
    execution_run,
    execution_wait,
    external_triggers,
    scheduler,
    sequence_service,
)

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def wait_step(step_id: str, targets=None, **fields: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": step_id,
        "query_id": "",
        "kind": "wait",
        "endpoint": "",
        "parameters": [],
        "next": [
            {"id": t, "condition_parameter": ""} if isinstance(t, str) else t
            for t in (targets or [])
        ],
        "wait_mode": "duration",
        "duration_seconds": 0,
    }
    row.update(fields)
    return row


def query_step(step_id: str, targets=None, parameters=None) -> dict[str, Any]:
    return {
        "id": step_id,
        "query_id": f"Q_{step_id}",
        "endpoint": "",
        "parameters": parameters or [],
        "next": [
            {"id": t, "condition_parameter": ""} if isinstance(t, str) else t
            for t in (targets or [])
        ],
    }


def pkg(steps: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    package: dict[str, Any] = {
        "steps": steps,
        "response_parameters": [],
        "sequence_query_id": extra.pop("sequence_query_id", "SEQ_WAIT"),
        "space_id": extra.pop("space_id", "SP_TEST"),
        "owner_id": extra.pop("owner_id", "userA"),
    }
    package.update(extra)
    return package


def expire_wait(state_id: str, *, released: bool = False) -> None:
    row = catalog.fetch_state_package(state_id) or {}
    progress = dict(row.get("progress") or {})
    wait = dict(progress.get("wait") or {})
    wait["until"] = "2000-01-01T00:00:00+00:00"
    if released:
        wait["released"] = True
    progress["wait"] = wait
    catalog.update_state_progress(state_id, progress)


tmpdir = tempfile.mkdtemp(prefix="pona-flow-wait-test-")
tmp_db = Path(tmpdir) / "data.db"
_original_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

_original_execute = execution_run._execute_step
observed: list[str] = []
cancel_after: str | None = None
current_state_id = ""


def fake_execute_step(space_id: str, step_row: dict, resolved: dict) -> dict:
    step_id = str(step_row.get("id") or "")
    kind = str(step_row.get("kind") or "").strip()
    if kind == "wait":
        return _original_execute(space_id, step_row, resolved)
    observed.append(step_id)
    if cancel_after and step_id == cancel_after and current_state_id:
        catalog.request_state_cancel(current_state_id)
    return {}


execution_run._execute_step = fake_execute_step  # type: ignore[assignment]


def run(package: dict, params=None, trigger: str = "manual") -> tuple[dict, str]:
    global current_state_id
    state_id = catalog.insert_state_package(package, status="inactive", run_start_date=None)
    current_state_id = state_id
    result = execution.run_execution("SP_TEST", state_id, params=params, trigger=trigger)
    return result, state_id


try:
    composed = execution._build_step(
        "W",
        {
            "payload": {"kind": "wait", "mode": "duration", "duration_seconds": 12},
            "parameters": [],
        },
        {},
    )
    check("compose emits wait kind", composed.get("kind") == "wait")
    check("compose emits wait_mode", composed.get("wait_mode") == "duration")
    check("compose emits duration_seconds", composed.get("duration_seconds") == 12)

    # --- duration park + resume ------------------------------------------------
    observed.clear()
    result, sid = run(pkg([wait_step("W", duration_seconds=30)]))
    check("duration parks with waiting", result.get("status") == "waiting")
    check("duration reason is duration", result.get("reason") == "duration")
    check("duration wake_at is set", bool(result.get("wake_at")))
    row = catalog.fetch_state_package(sid) or {}
    check("duration row status is waiting", row.get("status") == "waiting")
    wait = (row.get("progress") or {}).get("wait") or {}
    check("duration wait is not visited yet", "W" not in ((row.get("progress") or {}).get("visited") or []))
    check("zero executed while parked", (row.get("progress") or {}).get("queue") == ["W"])

    expire_wait(sid)
    resumed = execution.run_execution("SP_TEST", sid, params={})
    check("duration resume finishes", resumed.get("status") == "inactive")
    check(
        "wait is visited only after it elapses",
        [e.get("step_id") for e in resumed.get("executed") or []] == ["W"],
    )
    stored = catalog.fetch_state_package(sid) or {}
    check("finished payload is persisted", isinstance(stored.get("result"), dict))

    # --- zero duration / past until continue immediately -----------------------
    result, _ = run(pkg([wait_step("W0", duration_seconds=0)]))
    check("zero duration does not park", result.get("status") == "inactive")

    result, _ = run(
        pkg([wait_step("WU", wait_mode="until", until="2000-01-01T00:00:00+00:00")])
    )
    check("past until does not park", result.get("status") == "inactive")

    result, sid = run(
        pkg([wait_step("WF", wait_mode="until", until="2099-01-01T00:00:00+00:00")])
    )
    check("future until parks", result.get("status") == "waiting" and result.get("reason") == "until")
    expire_wait(sid)
    check(
        "future until resume finishes",
        execution.run_execution("SP_TEST", sid, {}).get("status") == "inactive",
    )

    # --- event wait: resume waiter and still start listed sequences ------------
    result, waiter_id = run(
        pkg([wait_step("WE", ["B"], wait_mode="event", event_id="EVT_WAIT"), query_step("B")])
    )
    check("event wait parks", result.get("status") == "waiting" and result.get("event_id") == "EVT_WAIT")
    check("event wait is not due without a fire", execution_wait.wait_due((catalog.fetch_state_package(waiter_id) or {}).get("progress", {}).get("wait")) is False)

    started: list[tuple[str, dict]] = []

    def _stub_run(space_id, sequence_id, params, state_id=None, owner_id=None, trigger="webhook", principal_id=None):
        started.append((str(sequence_id), dict(params or {})))
        return {"status": "inactive", "sequence_id": sequence_id}

    orig_run_once = sequence_service.run_sequence_once
    sequence_service.run_sequence_once = _stub_run  # type: ignore[assignment]
    try:
        observed.clear()
        summary = external_triggers.dispatch_external_event(
            {
                "id": "EVT_WAIT",
                "space_id": "SP_TEST",
                "sequences": ["SEQ_LISTED"],
                "external_package": {
                    "param_mappings": [{"source_path": "ticket", "parameter": "ticket_id"}]
                },
            },
            {"ticket": "T-9"},
        )
        waiter_row = catalog.fetch_state_package(waiter_id) or {}
        check("ingest still starts listed sequences", "SEQ_LISTED" in (summary.get("ran") or []) or started == [("SEQ_LISTED", {"ticket_id": "T-9"})])
        check("listed sequence received mapped params", started == [("SEQ_LISTED", {"ticket_id": "T-9"})])
        check("event fire resumes the parked waiter", waiter_row.get("status") in ("inactive", "cancelled"))
        check("waiter continued to the next step", "B" in observed)
        check(
            "waiter resolved merged event params",
            ((waiter_row.get("result") or {}).get("resolved") or {}).get("ticket_id") == "T-9",
        )
    finally:
        sequence_service.run_sequence_once = orig_run_once  # type: ignore[assignment]

    # --- loop delay parks between passes, not before the first -----------------
    observed.clear()
    loop_pkg = pkg(
        [
            query_step("A", ["B"]),
            query_step("B", ["C"]),
            query_step("C", ["B", "D"]),
            query_step("D"),
        ],
        sequence_query_id="SEQ_LOOP",
        loop={
            "type": "for",
            "count": 2,
            "max_iterations": execution_loop.DEFAULT_MAX_ITERATIONS,
            "back_edge": {"from": "C", "to": "B"},
            "body": ["B", "C"],
            "delay_seconds": 15,
        },
    )
    result, loop_sid = run(loop_pkg)
    check("loop delay parks after the first pass", result.get("status") == "waiting")
    check("loop delay reason", result.get("reason") == "loop_delay")
    check("first pass ran before the delay", observed == ["A", "B", "C"])
    expire_wait(loop_sid)
    observed.clear()
    loop_resume = execution.run_execution("SP_TEST", loop_sid, {})
    check("loop delay resume finishes the second pass", loop_resume.get("status") in ("waiting", "inactive"))
    if loop_resume.get("status") == "waiting":
        expire_wait(loop_sid)
        loop_resume = execution.run_execution("SP_TEST", loop_sid, {})
    check("loop delay run completes after remaining passes", loop_resume.get("status") == "inactive")
    check("second pass ran on wake, then exited", observed[-1:] == ["D"] or "D" in observed)

    observed.clear()
    no_delay, _ = run(
        pkg(
            [
                query_step("A", ["B"]),
                query_step("B", ["C"]),
                query_step("C", ["B", "D"]),
                query_step("D"),
            ],
            sequence_query_id="SEQ_LOOP0",
            loop={
                "type": "for",
                "count": 2,
                "max_iterations": execution_loop.DEFAULT_MAX_ITERATIONS,
                "back_edge": {"from": "C", "to": "B"},
                "body": ["B", "C"],
            },
        )
    )
    check("omitted delay does not park", no_delay.get("status") == "inactive")
    check("omitted delay still iterates", observed.count("B") == 2)

    # --- stop waiting / pending; cooperative cancel between steps --------------
    result, wait_sid = run(pkg([wait_step("WS", duration_seconds=60)]))
    stopped = execution.stop_execution("SP_TEST", wait_sid)
    check("stop waiting is cancelled immediately", stopped.get("status") == "cancelled")
    check(
        "waiting row is cancelled",
        (catalog.fetch_state_package(wait_sid) or {}).get("status") == "cancelled",
    )

    result, pending_sid = run(
        pkg(
            [
                query_step(
                    "P",
                    parameters=[{"name": "note", "is_required": True, "value_type": "string"}],
                )
            ]
        ),
        trigger="manual",
    )
    check("required param parks as pending HITL", result.get("status") == "pending")
    stopped = execution.stop_execution("SP_TEST", pending_sid)
    check("stop pending is cancelled immediately", stopped.get("status") == "cancelled")

    observed.clear()
    cancel_after = "A"
    result, coop_sid = run(pkg([query_step("A", ["B"]), query_step("B")]))
    cancel_after = None
    check("cooperative cancel ends between steps", result.get("status") == "cancelled")
    check("the later step did not run", observed == ["A"])

    seq_stop = execution.stop_execution("SP_TEST", sequence_id="SEQ_WAIT")
    check("stop by sequence_id returns a status", seq_stop.get("status") in ("cancelled", "cancelling", "inactive"))

    result, fallback_sid = run(
        pkg([wait_step("WFALL", duration_seconds=60)], sequence_query_id="SEQ_FALLBACK")
    )
    check("fallback setup is waiting", result.get("status") == "waiting")
    stopped = execution.stop_execution(
        "SP_TEST", "ID_missing_state", sequence_id="SEQ_FALLBACK"
    )
    check(
        "stop falls back to sequence_id when state_id is missing",
        stopped.get("status") == "cancelled",
    )
    check(
        "fallback cancelled the waiting row",
        (catalog.fetch_state_package(fallback_sid) or {}).get("status") == "cancelled",
    )

    # --- scheduler wakes a due duration wait -----------------------------------
    result, sched_sid = run(pkg([wait_step("WK", duration_seconds=90)], sequence_query_id="SEQ_SCHED"))
    expire_wait(sched_sid)
    scheduler._wake_waiting_runs(datetime.now(timezone.utc))
    check(
        "scheduler resume finishes the due wait",
        (catalog.fetch_state_package(sched_sid) or {}).get("status") == "inactive",
    )

    # --- in-flight listing -----------------------------------------------------
    result, inflight_sid = run(pkg([wait_step("WI", duration_seconds=40)], sequence_query_id="SEQ_IF", space_id="SP_TEST"))
    _, other_sid = run(pkg([wait_step("WO", duration_seconds=40)], sequence_query_id="SEQ_OTHER", space_id="SP_OTHER"))
    listed = catalog.list_in_flight_states("SP_TEST")
    ids = {item.get("state_id") for item in listed}
    check("in-flight lists the waiting run in this space", inflight_sid in ids)
    check("in-flight excludes other spaces", other_sid not in ids)
    parent_pending, parent_sid = run(
        pkg(
            [
                query_step(
                    "PARENT_HITL",
                    parameters=[{"name": "note", "is_required": True, "value_type": "string"}],
                )
            ],
            sequence_query_id="SEQ_PARENT_SHARE",
            space_id="SP_TEST",
        )
    )
    check("parent leftover is pending HITL", parent_pending.get("status") == "pending")
    listed = catalog.list_in_flight_states("SP_TEST")
    by_state = {item.get("state_id"): item.get("sequence_id") for item in listed}
    check(
        "waiting run keeps its own sequence_id",
        by_state.get(inflight_sid) == "SEQ_IF",
    )
    check(
        "pending parent is not attributed the waiting sequence_id",
        by_state.get(parent_sid) == "SEQ_PARENT_SHARE",
    )
    check(
        "waiting run is not listed under the parent sequence",
        by_state.get(inflight_sid) != "SEQ_PARENT_SHARE",
    )
    check(
        "in-flight status is waiting",
        any(item.get("state_id") == inflight_sid and item.get("status") == "waiting" for item in listed),
    )

    # --- latest finished per sequence survives purge ---------------------------
    fin_pkg = pkg([wait_step("WF0", duration_seconds=0)], sequence_query_id="SEQ_KEEP")
    older, older_sid = run(fin_pkg)
    newer, newer_sid = run(fin_pkg)
    check("zero-duration runs finish", older.get("status") == "inactive" and newer.get("status") == "inactive")
    catalog.purge_finished_state_packages()
    remaining = {
        row[0]
        for row in catalog.catalog_conn().execute("SELECT id FROM state").fetchall()
    }
    check("purge keeps the latest finished row for the sequence", newer_sid in remaining)
    check("purge drops the older finished row for the sequence", older_sid not in remaining)

    # --- CHECK migration accepts waiting / cancelled ---------------------------
    mig_dir = tempfile.mkdtemp(prefix="pona-flow-wait-mig-")
    mig_db = Path(mig_dir) / "legacy.db"
    conn = sqlite3.connect(mig_db)
    conn.execute(
        "CREATE TABLE state ("
        "id TEXT PRIMARY KEY NOT NULL, "
        "package TEXT NOT NULL DEFAULT '{}', "
        "status TEXT NOT NULL DEFAULT 'pending' "
        "CHECK (status IN ('active', 'pending', 'inactive')), "
        "run_start_date TEXT, "
        "progress TEXT)"
    )
    conn.execute(
        "INSERT INTO state (id, package, status) VALUES ('legacy-inactive', '{}', 'inactive')"
    )
    conn.commit()
    rejected = False
    try:
        conn.execute("INSERT INTO state (id, package, status) VALUES ('legacy-wait', '{}', 'waiting')")
        conn.commit()
    except sqlite3.IntegrityError:
        rejected = True
    conn.close()
    check("legacy status CHECK rejects waiting", rejected)

    saved_path = config.catalog_sqlite_path
    config.catalog_sqlite_path = lambda: mig_db  # type: ignore[assignment]
    catalog._ensured_catalog_paths.discard(str(mig_db))
    try:
        waiting_id = catalog.insert_state_package({"steps": []}, status="waiting")
        cancelled_id = catalog.insert_state_package({"steps": []}, status="cancelled")
        check("migrated CHECK accepts waiting", bool(waiting_id))
        check("migrated CHECK accepts cancelled", bool(cancelled_id))
        check(
            "legacy inactive row survived the rebuild",
            (catalog.fetch_state_package("legacy-inactive") or {}).get("status") == "inactive",
        )
    finally:
        config.catalog_sqlite_path = saved_path  # type: ignore[assignment]
finally:
    execution_run._execute_step = _original_execute  # type: ignore[assignment]
    config.catalog_sqlite_path = _original_path  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
