"""Diagnostic: drive the DELETE_PILLAR sequence end-to-end through the execution module
(exactly like /api/sequence/compose + /api/sequence/run) against a throwaway PILLAR node,
to see whether passing pillarID actually deletes it.

Creates a temp PILLAR, composes + runs the sequence, reports each phase, then verifies
deletion and cleans up if needed.

Run:  .venv/bin/python tests/diag-delete-pillar-run.py LIFEOS
"""

from __future__ import annotations

import os
import sys
import uuid

try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv()
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "Engine"))

from server import execution, graph  # noqa: E402

SPACE = sys.argv[1] if len(sys.argv) > 1 else "LIFEOS"
SEQ_ID = "ID_b6f5f90d8d0741f3aa0f39edff474513"  # DELETE_PILLAR sequence
TEST_ID = f"TEST_DELETE_{uuid.uuid4().hex}"


def count(pid: str) -> int:
    out = graph.run_cypher_for_space(
        SPACE,
        "MATCH (n:INSTANCE {attributive_label:'PILLAR'}) WHERE n.id = $pid RETURN count(n) AS c",
        {"pid": pid},
    )
    recs = out.get("records") or []
    return int(recs[0].get("c")) if recs else -1


def main() -> None:
    print(f"space={SPACE} seq={SEQ_ID}\n")

    print(f"1) creating temp PILLAR id={TEST_ID}")
    graph.run_cypher_for_space(
        SPACE,
        "CREATE (n:INSTANCE {attributive_label:'PILLAR', id:$pid, NAME:'DIAG TEMP', "
        "IS_ACTIVE:'true', TYPE:'Personal'})",
        {"pid": TEST_ID},
    )
    print(f"   exists after create? count={count(TEST_ID)}")

    print("\n2) compose_and_store(...)")
    composed = execution.compose_and_store(SPACE, SEQ_ID, owner_id="diag-user")
    state_id = composed["state_id"]
    print(f"   state_id={state_id}")
    for s in composed["package"].get("steps", []):
        print(f"   step id={s.get('id')} query_id={s.get('query_id')} "
              f"params={[p.get('name') for p in s.get('parameters', [])]}")

    print("\n3) run_execution(params={}) -> expect pending asking for pillarID")
    r1 = execution.run_execution(SPACE, state_id, {}, trigger="manual", principal_id="diag-user")
    print(f"   status={r1.get('status')} step={r1.get('step_id')} "
          f"parameters={[p.get('name') for p in r1.get('parameters', [])]}")

    print(f"\n4) run_execution(params={{'pillarID': {TEST_ID!r}}}) -> expect delete")
    r2 = execution.run_execution(
        SPACE, state_id, {"pillarID": TEST_ID}, trigger="manual", principal_id="diag-user"
    )
    print(f"   status={r2.get('status')} resolved={r2.get('resolved')}")
    print(f"   executed={r2.get('executed')}")
    print(f"   final_result={r2.get('final_result')}")

    remaining = count(TEST_ID)
    print(f"\n5) temp PILLAR still present? count={remaining}  -> "
          f"{'FAIL (not deleted)' if remaining else 'OK (deleted)'}")

    if remaining:
        print("   cleaning up temp node")
        graph.run_cypher_for_space(
            SPACE,
            "MATCH (n:INSTANCE {attributive_label:'PILLAR'}) WHERE n.id=$pid DETACH DELETE n",
            {"pid": TEST_ID},
        )

    print("\n6) 0-match case: run again with a bogus id -> expect nodes_deleted=0 in response")
    composed2 = execution.compose_and_store(SPACE, SEQ_ID, owner_id="diag-user")
    r3 = execution.run_execution(
        SPACE,
        composed2["state_id"],
        {"pillarID": "ID_does_not_exist"},
        trigger="manual",
        principal_id="diag-user",
    )
    print(f"   status={r3.get('status')}")
    print(f"   final_result={r3.get('final_result')}")


if __name__ == "__main__":
    main()
