"""
Diagnostic test for how a vector-search query step is classified for the results panel.

A CALL db.index.vector.queryNodes YIELD node AS PROJECT, score RETURN PROJECT, score
row is a live Node when the driver hydrates it (``_graph`` is filled). Some CALL
shapes only leave the flattened property map in ``records``. The sequence runner
used to emit ``kind: table`` in that case, and the UI dropped table finals — so a
successful search showed the design graph instead of hits.

Covers:
  - live ``_graph`` nodes stay ``kind: graph``
  - flattened node maps in ``records`` are synthesized into a graph
  - an empty hit list is ``kind: table`` (the UI shows "No rows returned")
  - score-only rows stay a table (no fake nodes)

Run: ``.venv/bin/python tests/execution-classify-vector-result.py`` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import execution_run as run  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


STEP = {"id": "s1", "query_id": "q-vector"}

live = run._classify_final_response(
    STEP,
    {
        "records": [
            {
                "PROJECT": {"id": "n1", "attributive_label": "PROJECT", "name": "Alpha"},
                "score": 0.91,
            }
        ],
        "_graph": {
            "nodes": [
                {
                    "element_id": "4:abc:1",
                    "labels": ["INSTANCE"],
                    "properties": {"id": "n1", "attributive_label": "PROJECT"},
                }
            ],
            "relationships": [],
        },
    },
)
check("live graph stays kind=graph", live.get("kind") == "graph")
check("live graph keeps the driver element_id", live["graph"]["nodes"][0]["element_id"] == "4:abc:1")
check("live graph keeps the score row", live["rows"][0]["score"] == 0.91)

flat = run._classify_final_response(
    STEP,
    {
        "records": [
            {
                "PROJECT": {"id": "n2", "attributive_label": "TASK", "name": "Beta"},
                "score": 0.7,
            }
        ],
        "_graph": {"nodes": [], "relationships": []},
    },
)
check("flattened node map is synthesized as graph", flat.get("kind") == "graph")
check("synthesized node uses the graph id", flat["graph"]["nodes"][0]["element_id"] == "n2")
check("synthesized node is labeled INSTANCE", flat["graph"]["nodes"][0]["labels"] == ["INSTANCE"])

empty = run._classify_final_response(STEP, {"records": [], "_graph": {"nodes": [], "relationships": []}})
check("empty hit list is kind=table (not response)", empty.get("kind") == "table")
check("empty hit list has no rows", empty.get("rows") == [])

score_only = run._classify_final_response(
    STEP,
    {"records": [{"score": 0.5}], "_graph": {"nodes": [], "relationships": []}},
)
check("score-only row stays a table", score_only.get("kind") == "table")
check("score-only row does not invent a node", score_only.get("graph") is None)

print()
if failures:
    print(f"{len(failures)} check(s) FAILED:")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("execution-classify-vector-result: ok")
