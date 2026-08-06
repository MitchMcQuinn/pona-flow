"""
Diagnostic test for the cross-space RBAC hardening in Engine/server/rbac.py,
agent_keys.py, and auth.py.

Covers:
  - a role id from another space is rejected by invite_member / add_member /
    update_member (and by agent_keys.mint_key, without leaving orphan rows);
  - a foreign role_id tampered directly into space_members resolves to NO
    permissions (role lookup is scoped to the space);
  - sanitize_override drops manage_space (overrides cannot grant space management),
    and legacy stored overrides containing it are ignored on resolve;
  - auth.require_space_owner: owners and superadmin pass, a non-owner manager 403s.

Runs against a throwaway SQLite catalog DB (no Neo4j needed).

Run (from repo root, with the project venv so FastAPI is importable):
    .venv/bin/python tests/rbac-role-scope.py
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

from Engine.server import agent_keys, auth, config, rbac  # noqa: E402

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


def raises_403(fn) -> bool:
    try:
        fn()
        return False
    except HTTPException as e:
        return e.status_code == 403


def principal(user_id: str, *, is_super=False) -> auth.Principal:
    return auth.Principal(
        user_id=user_id,
        clerk_user_id=f"clerk_{user_id}",
        email=f"{user_id}@example.com",
        is_instance_admin=is_super,
        is_superadmin=is_super,
    )


tmpdir = tempfile.mkdtemp(prefix="pona-flow-role-scope-test-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

try:
    conn = config.connect_sqlite(tmp_db)
    conn.executescript(
        (config.ROOT / "Engine" / "schema" / "users-table.sql").read_text(encoding="utf-8")
    )
    conn.executescript(
        (config.ROOT / "Engine" / "schema" / "agent-keys-table.sql").read_text(encoding="utf-8")
    )
    conn.execute("CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO spaces (id, name) VALUES ('demo', 'demo')")
    conn.execute("INSERT INTO spaces (id, name) VALUES ('other', 'other')")
    conn.commit()
    rbac.ensure_rbac_schema(conn)
    for uid in ("u_owner", "u_manager", "u_member"):
        conn.execute(
            "INSERT INTO users (id, clerk_user_id, email) VALUES (?, ?, ?)",
            (uid, f"clerk_{uid}", f"{uid}@example.com"),
        )
    conn.commit()
    conn.close()

    demo_roles = {r["name"]: r["id"] for r in rbac.list_roles("demo")}
    other_roles = {r["name"]: r["id"] for r in rbac.list_roles("other")}
    check(
        "both spaces have seeded Admin roles",
        bool(demo_roles.get("Admin")) and bool(other_roles.get("Admin")),
    )

    rbac.add_member("demo", "u_owner", is_owner=True, role_id=demo_roles["Admin"])
    rbac.add_member("demo", "u_member", role_id=demo_roles["Member"])

    def member_id(principal_id: str) -> str:
        return next(
            m["id"] for m in rbac.list_members("demo") if m["principal_id"] == principal_id
        )

    # --- foreign role ids are rejected ----------------------------------------
    check(
        "invite_member rejects another space's role id",
        raises_value_error(
            lambda: rbac.invite_member("demo", "x@example.com", role_id=other_roles["Admin"])
        ),
    )
    check(
        "add_member rejects another space's role id",
        raises_value_error(
            lambda: rbac.add_member("demo", "u_manager", role_id=other_roles["Admin"])
        ),
    )
    check(
        "update_member rejects another space's role id",
        raises_value_error(
            lambda: rbac.update_member(
                "demo", member_id("u_member"), role_id=other_roles["Admin"]
            )
        ),
    )
    check(
        "update_member accepts a same-space role id",
        rbac.update_member("demo", member_id("u_member"), role_id=demo_roles["Member"])[
            "updated"
        ],
    )

    # --- tampered foreign role_id grants nothing on resolve -------------------
    conn = config.connect_sqlite(tmp_db)
    conn.execute(
        "UPDATE space_members SET role_id = ? WHERE id = ?",
        (other_roles["Admin"], member_id("u_member")),
    )
    conn.commit()
    conn.close()
    tampered = rbac.resolve_effective_permissions("u_member", "demo")
    check(
        "foreign Admin role_id resolves to no flows / no manage",
        tampered["flows"] == [] and not rbac.perms_allow_manage(tampered),
    )
    rbac.update_member("demo", member_id("u_member"), role_id=demo_roles["Member"])

    # --- overrides cannot grant manage_space -----------------------------------
    sanitized = rbac.sanitize_override({"flows": ["read:STEP"], "manage_space": True})
    check("sanitize_override drops manage_space", "manage_space" not in sanitized)

    # A legacy stored override containing manage_space is ignored on resolve.
    conn = config.connect_sqlite(tmp_db)
    conn.execute(
        "UPDATE space_members SET permissions_override = ? WHERE id = ?",
        (json.dumps({"manage_space": True}), member_id("u_member")),
    )
    conn.commit()
    conn.close()
    legacy = rbac.resolve_effective_permissions("u_member", "demo")
    check("legacy override manage_space is ignored", not rbac.perms_allow_manage(legacy))
    rbac.update_member("demo", member_id("u_member"), clear_override=True)

    # --- agent_keys.mint_key validates the role and leaves no orphans ---------
    check(
        "mint_key rejects another space's role id",
        raises_value_error(
            lambda: agent_keys.mint_key("demo", "bad-agent", role_id=other_roles["Member"])
        ),
    )
    conn = config.connect_sqlite(tmp_db)
    orphans = conn.execute(
        "SELECT COUNT(*) FROM agent_keys WHERE space_id = 'demo'"
    ).fetchone()[0]
    agent_users = conn.execute(
        "SELECT COUNT(*) FROM users WHERE principal_type = 'agent'"
    ).fetchone()[0]
    conn.close()
    check("rejected mint left no agent_keys row", orphans == 0)
    check("rejected mint left no agent users row", agent_users == 0)

    minted = agent_keys.mint_key("demo", "good-agent", role_id=demo_roles["Member"])
    check("mint_key works with a same-space role", minted["token"].startswith("stg_"))

    # --- require_space_owner ----------------------------------------------------
    # u_manager: a non-owner member whose role grants manage_space.
    rbac.add_member("demo", "u_manager")
    rbac.update_member(
        "demo",
        member_id("u_manager"),
        role_id=rbac.upsert_role(
            "demo",
            "Manager",
            {"flows": [], "sequences": {"all": False, "ids": []}, "manage_space": True},
        )["id"],
    )
    manager_perms = rbac.resolve_effective_permissions("u_manager", "demo")
    check("manager role grants manage_space", rbac.perms_allow_manage(manager_perms))

    check("is_space_owner true for owner", rbac.is_space_owner("u_owner", "demo"))
    check("is_space_owner false for manager", not rbac.is_space_owner("u_manager", "demo"))

    check(
        "require_space_owner permits the owner",
        not raises_403(lambda: auth.require_space_owner(principal("u_owner"), "demo")),
    )
    check(
        "require_space_owner denies a non-owner manager",
        raises_403(lambda: auth.require_space_owner(principal("u_manager"), "demo")),
    )
    check(
        "require_space_owner permits superadmin",
        not raises_403(
            lambda: auth.require_space_owner(principal("u_ghost", is_super=True), "demo")
        ),
    )

finally:
    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All role-scope checks passed.")
