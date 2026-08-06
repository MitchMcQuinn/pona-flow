"""
Diagnostic test for the owner/Admin-role guards added to Engine/server/rbac.py.

Covers:
  - the sole active owner cannot be removed or demoted (a space must keep >=1 owner);
  - a second owner makes removal/demotion of the first owner allowed again;
  - the built-in Admin role cannot be edited or deleted;
  - a member assigned the Admin role resolves to full access even if its stored
    permissions were tampered with (Admin is a native primitive).

Runs against a throwaway SQLite catalog DB (no Neo4j needed).

Run (from repo root, with the project venv so FastAPI is importable):
    .venv/bin/python tests/rbac-owner-admin-guards.py
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config, rbac  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def raises_value_error(fn) -> bool:
    try:
        fn()
        return False
    except ValueError:
        return True


tmpdir = tempfile.mkdtemp(prefix="pona-flow-guards-test-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

try:
    conn = config.connect_sqlite(tmp_db)
    conn.executescript(
        (config.ROOT / "Engine" / "schema" / "users-table.sql").read_text(encoding="utf-8")
    )
    conn.execute("CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO spaces (id, name) VALUES ('demo', 'demo')")
    conn.commit()
    rbac.ensure_rbac_schema(conn)
    for uid in ("u_owner", "u_owner2", "u_member"):
        conn.execute(
            "INSERT INTO users (id, clerk_user_id, email) VALUES (?, ?, ?)",
            (uid, f"clerk_{uid}", f"{uid}@example.com"),
        )
    conn.commit()
    conn.close()

    roles = {r["name"]: r["id"] for r in rbac.list_roles("demo")}
    rbac.add_member("demo", "u_owner", is_owner=True, role_id=roles["Admin"])
    rbac.add_member("demo", "u_member", role_id=roles["Member"])

    def member_id(principal_id: str) -> str:
        return next(m["id"] for m in rbac.list_members("demo") if m["principal_id"] == principal_id)

    # --- sole owner protection ----------------------------------------------
    owner_mid = member_id("u_owner")
    check(
        "cannot remove the only owner",
        raises_value_error(lambda: rbac.remove_member("demo", owner_mid)),
    )
    check(
        "cannot demote the only owner",
        raises_value_error(lambda: rbac.update_member("demo", owner_mid, is_owner=False)),
    )

    # Promote a second owner; now the first owner can be removed/demoted.
    rbac.add_member("demo", "u_owner2", is_owner=True)
    check(
        "owner count is now 2",
        sum(1 for m in rbac.list_members("demo") if m["is_owner"]) == 2,
    )
    rbac.update_member("demo", owner_mid, is_owner=False)
    check(
        "first owner demoted once a second owner exists",
        not next(m for m in rbac.list_members("demo") if m["id"] == owner_mid)["is_owner"],
    )

    # --- Admin role is a native primitive -----------------------------------
    check(
        "Admin role cannot be deleted",
        raises_value_error(lambda: rbac.delete_role("demo", roles["Admin"])),
    )
    check(
        "Admin role cannot be edited",
        raises_value_error(
            lambda: rbac.upsert_role("demo", "Admin", rbac.empty_permissions(), role_id=roles["Admin"])
        ),
    )
    check(
        "a new role cannot be named Admin",
        raises_value_error(lambda: rbac.upsert_role("demo", "admin", rbac.empty_permissions())),
    )

    # Tamper the stored Admin permissions, then confirm resolution still grants full access.
    conn = config.connect_sqlite(tmp_db)
    conn.execute(
        "UPDATE space_roles SET permissions = ? WHERE id = ?",
        (json.dumps(rbac.empty_permissions()), roles["Admin"]),
    )
    conn.commit()
    conn.close()
    rbac.update_member("demo", member_id("u_member"), role_id=roles["Admin"])
    admin_member_perms = rbac.resolve_effective_permissions("u_member", "demo")
    check(
        "Admin-role member resolves to full access despite tampering",
        len(admin_member_perms["flows"]) == len(rbac.ALL_FLOWS)
        and admin_member_perms.get("manage_space") is True,
    )

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All owner/Admin guard checks passed.")
finally:
    pass
