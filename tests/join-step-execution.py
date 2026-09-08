"""
Diagnostic test for join STEPs: opt-in barriers on the serial walk.

Covers:
  - compose emits kind join and publishes ok;
  - even diamond: both arms before the join;
  - uneven diamond: the long arm finishes before the join;
  - an untaken conditional arm does not deadlock the join;
  - HITL on one arm: join waits, then continues after resume;
  - a diamond without a join STEP still runs first-arrival;
  - join inside a loop body / nested joins / no inbound edge are rejected.

Steps that are not join STEPs are stubbed via ``execution_run._execute_step``.
No Neo4j; catalog is a throwaway SQLite DB.

Run: ``python tests/join-step-execution.py`` from the repo root.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import (  # noqa: E402
    catalog,
    config,
    execution,
    execution_join,
    execution_run,
)

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def join_step(step_id: str, targets=None) -> dict[str, Any]:
    return {
        "id": step_id,
        "query_id": "",
        "kind": "join",
        "endpoint": "",
        "parameters": [],
        "next": [
            {"id": t, "condition_parameter": ""} if isinstance(t, str) else t
            for t in (targets or [])
        ],
    }


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
        "sequence_query_id": extra.pop("sequence_query_id", "SEQ_JOIN"),
        "space_id": extra.pop("space_id", "SP_TEST"),
    }
    package.update(extra)
    return package


def steps_by_id(*rows: dict) -> dict[str, dict]:
    return {row["id"]: row for row in rows}


tmpdir = tempfile.mkdtemp(prefix="pona-flow-join-test-")
tmp_db = Path(tmpdir) / "data.db"
_original_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

_original_execute = execution_run._execute_step
observed: list[str] = []


def fake_execute_step(space_id: str, step_row: dict, resolved: dict) -> dict:
    step_id = str(step_row.get("id") or "")
    observed.append(step_id)
    kind = str(step_row.get("kind") or "").strip()
    if kind == "join":
        return _original_execute(space_id, step_row, resolved)
    return {}


execution_run._execute_step = fake_execute_step  # type: ignore[assignment]


def run(package: dict, params=None, trigger: str = "webhook") -> tuple[dict, str]:
    state_id = catalog.insert_state_package(package, status="inactive", run_start_date=None)
    result = execution.run_execution("SP_TEST", state_id, params=params, trigger=trigger)
    return result, state_id


def trace(result: dict) -> list[str]:
    return [entry["step_id"] for entry in result.get("executed") or []]


try:
    composed = execution._build_step(
        "J",
        {"payload": {"kind": "join"}, "parameters": []},
        {},
    )
    check("compose emits join kind", composed.get("kind") == "join")
    from Engine.server import execution_compose

    names = execution_compose._step_return_aliases({"kind": "join"}, lambda qid: None)
    check("compose publishes ok for a join", names == ["ok"])

    # --- even diamond ------------------------------------------------------
    # A -> B, A -> C; B -> J, C -> J; J -> D
    observed.clear()
    result, _ = run(
        pkg(
            [
                query_step("A", ["B", "C"]),
                query_step("B", ["J"]),
                query_step("C", ["J"]),
                join_step("J", ["D"]),
                query_step("D"),
            ]
        )
    )
    order = trace(result)
    check("even diamond completes", result.get("status") == "inactive")
    check("even diamond runs the join", "J" in order)
    check(
        "even diamond: both arms before the join",
        order.index("B") < order.index("J") and order.index("C") < order.index("J"),
    )
    check("even diamond: join before continuation", order.index("J") < order.index("D"))
    check("even diamond publishes ok", result["resolved"].get("ok") is True)

    # --- uneven diamond ----------------------------------------------------
    # A -> B, A -> C1; B -> J; C1 -> C2 -> J; J -> D
    observed.clear()
    result, _ = run(
        pkg(
            [
                query_step("A", ["B", "C1"]),
                query_step("B", ["J"]),
                query_step("C1", ["C2"]),
                query_step("C2", ["J"]),
                join_step("J", ["D"]),
                query_step("D"),
            ]
        )
    )
    order = trace(result)
    check(
        "uneven diamond: C2 before join",
        order.index("C2") < order.index("J"),
    )
    check(
        "uneven diamond: both arms before join",
        order.index("B") < order.index("J") and order.index("C1") < order.index("J"),
    )
    check("uneven diamond: join before D", order.index("J") < order.index("D"))

    # --- default fan-in is still first-arrival -----------------------------
    # Uneven: A -> B, A -> C1 -> C2, both into D (not a join). D can run after B
    # while C2 is still queued.
    observed.clear()
    result, _ = run(
        pkg(
            [
                query_step("A", ["B", "C1"]),
                query_step("B", ["D"]),
                query_step("C1", ["C2"]),
                query_step("C2", ["D"]),
                query_step("D"),
            ]
        )
    )
    order = trace(result)
    check(
        "no-join uneven diamond: D can run before C2",
        order.index("D") < order.index("C2"),
    )

    # --- only one ok arm taken --------------------------------------------
    observed.clear()
    result, _ = run(
        pkg(
            [
                query_step(
                    "A",
                    [
                        {
                            "id": "B",
                            "condition_parameter": "ok",
                            "condition_expected": True,
                        },
                        {
                            "id": "C",
                            "condition_parameter": "ok",
                            "condition_expected": False,
                        },
                    ],
                ),
                query_step("B", ["J"]),
                query_step("C", ["J"]),
                join_step("J", ["D"]),
                query_step("D"),
            ]
        )
    )
    order = trace(result)
    check("conditional: the taken arm ran", "B" in order and "C" not in order)
    check("conditional: join still runs (no deadlock)", "J" in order and "D" in order)

    # --- HITL on one arm ---------------------------------------------------
    observed.clear()
    paused, state_id = run(
        pkg(
            [
                query_step("A", ["B", "C"]),
                query_step("B", ["J"]),
                query_step(
                    "C",
                    ["J"],
                    parameters=[{"name": "note", "is_required": True, "value_type": "string"}],
                ),
                join_step("J", ["D"]),
                query_step("D"),
            ]
        ),
        trigger="manual",
    )
    check("HITL pauses on one arm", paused.get("status") == "pending")
    check("HITL pauses at C after the other arm finished", paused.get("step_id") == "C")
    progress = catalog.fetch_state_package(state_id).get("progress") or {}
    check("HITL does not enqueue the join yet", "J" not in (progress.get("queue") or []))
    check(
        "HITL persists join arrivals from the finished arm",
        "B" in ((progress.get("joins") or {}).get("J") or []),
    )
    resumed = execution.run_execution(
        "SP_TEST", state_id, params={"note": "answered"}, trigger="manual"
    )
    order = trace(resumed)
    check(
        "HITL resume: remaining arm before join",
        "C" in order and order.index("C") < order.index("J"),
    )
    check("HITL resume: join then D", order.index("J") < order.index("D"))

    # --- compose rejects ---------------------------------------------------
    diamond = steps_by_id(
        query_step("A", ["B", "C"]),
        query_step("B", ["J"]),
        query_step("C", ["J"]),
        join_step("J", ["D"]),
        query_step("D"),
    )
    try:
        execution_join.reject_join_policy(diamond)
        check("a well-formed join is accepted", True)
    except ValueError:
        check("a well-formed join is accepted", False)

    try:
        execution_join.reject_join_policy(diamond, {"body": ["B", "C", "J"]})
        check("join inside a loop body is rejected", False)
    except ValueError as exc:
        check("join inside a loop body is rejected", "inside a loop body" in str(exc))

    nested = steps_by_id(
        query_step("A", ["J1"]),
        join_step("J1", ["J2"]),
        join_step("J2", ["D"]),
        query_step("D"),
    )
    try:
        execution_join.reject_join_policy(nested)
        check("nested joins are rejected", False)
    except ValueError as exc:
        check("nested joins are rejected", "another join" in str(exc))

    lonely = steps_by_id(join_step("J", ["D"]), query_step("D"))
    try:
        execution_join.reject_join_policy(lonely)
        check("a join with no inbound edge is rejected", False)
    except ValueError as exc:
        check("a join with no inbound edge is rejected", "no incoming" in str(exc))
finally:
    config.catalog_sqlite_path = _original_path  # type: ignore[assignment]
    execution_run._execute_step = _original_execute  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
