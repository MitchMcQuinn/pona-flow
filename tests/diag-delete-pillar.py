"""Diagnostic: why DELETE_PILLAR doesn't delete despite passing a pillarID.

Lists every PILLAR INSTANCE node with its stored `id` (and other props), then runs the
exact delete-op MATCH (read-only, no DELETE) for a candidate id to see whether it binds.

Run:  .venv/bin/python tests/diag-delete-pillar.py LIFEOS [candidatePillarID]
"""

from __future__ import annotations

import os
import sys

try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv()
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "Engine"))

from server import graph  # noqa: E402


def main() -> None:
    space_id = sys.argv[1] if len(sys.argv) > 1 else "LIFEOS"
    candidate = sys.argv[2] if len(sys.argv) > 2 else None

    print(f"space_id = {space_id}\n")

    out = graph.run_cypher_for_space(
        space_id,
        "MATCH (n:INSTANCE {attributive_label: 'PILLAR'}) "
        "RETURN n.id AS id, keys(n) AS keys, properties(n) AS props",
        {},
    )
    records = out.get("records") or []
    print(f"PILLAR INSTANCE nodes: {len(records)}")
    for r in records:
        print(f"  id={r.get('id')!r}")
        print(f"     keys={r.get('keys')}")
        print(f"     props={r.get('props')}")

    if candidate is None and records:
        candidate = records[0].get("id")

    if candidate is not None:
        print(f"\nTesting delete MATCH with pillarID={candidate!r} (read-only):")
        test = graph.run_cypher_for_space(
            space_id,
            "MATCH (n8:INSTANCE { attributive_label: 'PILLAR' }) "
            "WHERE (n8.id = $pillarID) RETURN n8.id AS matched",
            {"pillarID": candidate},
        )
        matched = test.get("records") or []
        print(f"  matched rows = {len(matched)} -> {[m.get('matched') for m in matched]}")


if __name__ == "__main__":
    main()
