"""
Diagnostic test for the RBAC permission model (Engine/server/rbac.py + auth.py guards).

Covers:
  - permission resolution: superadmin/owner shortcuts, role template, role+override merge;
  - invite-then-link: a pending email invite is claimed when the user signs in;
  - the op x element flow gate (require_flow) denies/permits correctly;
  - the can_create_spaces gate on space creation.

Runs against a throwaway SQLite catalog DB (no Neo4j needed).

Run (from repo root, with the project venv so FastAPI is importable):
    .venv/bin/python tests/rbac-permissions.py
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

from Engine.server import auth, config, rbac  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def raises_403(fn) -> bool:
    try:
        fn()
        return False
    except HTTPException as e:
        return e.status_code == 403


def principal(user_id: str, *, is_super=False, can_create=False) -> auth.Principal:
    return auth.Principal(
        user_id=user_id,
        clerk_user_id=f"clerk_{user_id}",
        email=f"{user_id}@example.com",
        is_instance_admin=is_super,
        is_superadmin=is_super,
        can_create_spaces=can_create or is_super,
    )


tmpdir = tempfile.mkdtemp(prefix="pona-flow-rbac-test-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

try:
    conn = config.connect_sqlite(tmp_db)
    # Minimal catalog tables the RBAC layer depends on.
    conn.executescript(
        (config.ROOT / "Engine" / "schema" / "users-table.sql").read_text(encoding="utf-8")
    )
    conn.execute("CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO spaces (id, name) VALUES ('demo', 'demo')")
    conn.commit()
    rbac.ensure_rbac_schema(conn)
    conn.close()

    roles = {r["name"]: r["id"] for r in rbac.list_roles("demo")}
    check("seed created Admin and Member roles", "Admin" in roles and "Member" in roles)

    # --- principals + memberships --------------------------------------------
    conn = config.connect_sqlite(tmp_db)
    conn.execute(
        "INSERT INTO users (id, clerk_user_id, email) VALUES ('u_owner', 'clerk_u_owner', 'u_owner@example.com')"
    )
    conn.execute(
        "INSERT INTO users (id, clerk_user_id, email) VALUES ('u_member', 'clerk_u_member', 'u_member@example.com')"
    )
    conn.commit()
    conn.close()

    rbac.add_member("demo", "u_owner", is_owner=True, role_id=roles["Admin"])
    rbac.add_member("demo", "u_member", role_id=roles["Member"])

    # --- resolution: superadmin / owner shortcuts ----------------------------
    super_perms = rbac.resolve_effective_permissions("anyone", "demo", is_superadmin=True)
    check("superadmin gets all flows", len(super_perms["flows"]) == len(rbac.ALL_FLOWS))

    owner_perms = rbac.resolve_effective_permissions("u_owner", "demo")
    check("owner gets manage + all flows", owner_perms["manage_space"] and
          rbac.perms_allow_flow(owner_perms, "delete", "SCHEMA"))

    # --- resolution: role template -------------------------------------------
    member_perms = rbac.resolve_effective_permissions("u_member", "demo")
    check("member can read STEP", rbac.perms_allow_flow(member_perms, "read", "STEP"))
    check("member cannot delete SCHEMA", not rbac.perms_allow_flow(member_perms, "delete", "SCHEMA"))
    check("member cannot manage space", not rbac.perms_allow_manage(member_perms))
    check("member can run all sequences (default)", rbac.perms_allow_sequence(member_perms, "ID_x"))

    # --- resolution: role + override merge -----------------------------------
    member_id = next(m["id"] for m in rbac.list_members("demo") if m["principal_id"] == "u_member")
    rbac.update_member(
        "demo",
        member_id,
        permissions_override={"flows": ["delete:SCHEMA"], "manage_space": True},
    )
    merged = rbac.resolve_effective_permissions("u_member", "demo")
    check("override adds delete:SCHEMA", rbac.perms_allow_flow(merged, "delete", "SCHEMA"))
    check("override cannot grant manage_space", not rbac.perms_allow_manage(merged))
    check("override without sequences keeps role's run-all",
          rbac.perms_allow_sequence(merged, "ID_y"))
    check("override replaces flows (read:STEP now gone)",
          not rbac.perms_allow_flow(merged, "read", "STEP"))

    # --- invite-then-link by email -------------------------------------------
    invite = rbac.invite_member("demo", "newcomer@example.com", role_id=roles["Member"])
    check("invite to unknown email is pending", invite["status"] == "pending")
    pending_perms = rbac.resolve_effective_permissions("u_newcomer", "demo")
    check("unlinked invitee has no access", pending_perms == rbac.empty_permissions())

    conn = config.connect_sqlite(tmp_db)
    conn.execute(
        "INSERT INTO users (id, clerk_user_id, email) VALUES "
        "('u_newcomer', 'clerk_u_newcomer', 'newcomer@example.com')"
    )
    conn.commit()
    conn.close()
    claimed = rbac.claim_pending_invites("u_newcomer", "newcomer@example.com")
    check("sign-in claims one pending invite", claimed == 1)
    linked_perms = rbac.resolve_effective_permissions("u_newcomer", "demo")
    check("linked invitee inherits Member role", rbac.perms_allow_flow(linked_perms, "read", "STEP"))

    # --- auth guards: flow gate + space creation -----------------------------
    member = principal("u_member")
    # u_member now has the delete:SCHEMA override applied above.
    check("require_flow permits delete:SCHEMA (override)",
          not raises_403(lambda: auth.require_flow(member, "demo", "delete", "SCHEMA")))
    check("require_flow denies create:INSTANCE",
          raises_403(lambda: auth.require_flow(member, "demo", "create", "INSTANCE")))

    owner = principal("u_owner")
    check("owner passes every flow",
          not raises_403(lambda: auth.require_flow(owner, "demo", "create", "INSTANCE")))

    check("require_can_create_spaces denies plain member",
          raises_403(lambda: auth.require_can_create_spaces(principal("u_member"))))
    check("require_can_create_spaces permits granted principal",
          not raises_403(lambda: auth.require_can_create_spaces(principal("u_g", can_create=True))))
    check("require_can_create_spaces permits superadmin",
          not raises_403(lambda: auth.require_can_create_spaces(principal("u_s", is_super=True))))

    # superadmin bypasses the flow gate without any membership.
    sa = principal("u_ghost", is_super=True)
    check("superadmin bypasses flow gate with no membership",
          not raises_403(lambda: auth.require_flow(sa, "demo", "delete", "STEP")))

finally:
    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {failures}")
        sys.exit(1)
    print("All RBAC checks passed.")
