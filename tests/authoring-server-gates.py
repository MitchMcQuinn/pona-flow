"""
Diagnostic test for the server-side authoring gates (D11).

Until the MCP authoring gateway existed, the rules that keep the graph coherent — attributive
labels are globally unique across STEP and SCHEMA, only a principal with `create STEP` may
author operations — were enforced by the React builder alone. Those checks run in the browser,
so any other client writing straight to the API bypassed them. Two gates now live in Python:

- ``packages._assert_attributive_labels_available`` rejects a create whose new labels are
  already held by somebody else's entity, while still allowing the idempotent re-save that
  every STEP auto-wrap performs.
- ``/api/queries/upsert`` requires ``create STEP`` flow permission, mirroring the execution
  routes, so a member-role agent key cannot author operations.

Neo4j is replaced with a stub owner map, so this runs with no database.

Run: `python tests/authoring-server-gates.py` from the repo root.
"""

import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import graph, packages  # noqa: E402
from Engine.server.routes import queries as queries_route  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")
    if not condition:
        failures.append(name)


# --- Stub the graph: STEP_A is owned by ent-a, SHARED by two entities --------------------
OWNERS = {
    "STEP_A": {"ent-a"},
    "SHARED": {"ent-a", "ent-b"},
}
graph.attributive_label_owner_ids = lambda space_id, label: set(  # type: ignore
    OWNERS.get((label or "").strip(), set())
)

assert_available = packages._assert_attributive_labels_available


def rejects(labels, owner_ids) -> bool:
    try:
        assert_available("SPACE", labels, owner_ids)
    except ValueError:
        return True
    return False


# --- Uniqueness gate ---------------------------------------------------------------------
check("an unused label is available", not rejects(["BRAND_NEW"], None))
check("a label held by another entity is rejected", rejects(["STEP_A"], None))
check(
    "a label held by another entity is rejected even with unrelated owner ids",
    rejects(["STEP_A"], ["ent-zzz"]),
)
check(
    "re-saving your own label is allowed (this is what every STEP auto-wrap does)",
    not rejects(["STEP_A"], ["ent-a"]),
)
check(
    "a label shared with someone else is still a collision",
    rejects(["SHARED"], ["ent-a"]),
)
check(
    "owning every holder makes it a re-save, not a collision",
    not rejects(["SHARED"], ["ent-a", "ent-b"]),
)
check("blank and duplicate labels are skipped", not rejects(["", "  ", "NEW", "NEW"], None))
check("no labels at all is a no-op", not rejects(None, None))

# The gate must run before anything is written, or a rejected create still leaves rows behind.
create_src = inspect.getsource(packages.execute_create_package)
body = create_src.split('"""', 2)[-1]
check(
    "the uniqueness gate runs before any write in execute_create_package",
    body.index("_assert_attributive_labels_available") < body.index("upsert_queries_catalog_row"),
)

# --- RBAC gate on the authoring route ----------------------------------------------------
upsert_src = inspect.getsource(queries_route.queries_upsert)
check(
    "/api/queries/upsert requires create STEP flow permission",
    'require_flow(principal, space_id, "create", "STEP")' in upsert_src.replace("'", '"'),
)
check(
    "the flow gate subsumes the space-membership gate it replaced",
    "require_space_access" in inspect.getsource(queries_route.auth.require_flow),
)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All authoring gate checks passed.")
