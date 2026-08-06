"""
Role-based access control (RBAC) for principals — schema, roles, membership, and the
permission resolution used by the auth guards.

Purpose in the project
----------------------
The original model (see Docs/DECISIONS.md D5) was binary: a principal was either a space
member (full access) or not, plus a single instance admin. This module implements a
hybrid RBAC layer on top of the catalog ``data.db``:

- **Principal**: a row in ``users`` (``principal_type`` 'user' now, 'agent' later for the
  MCP integration). ``can_create_spaces`` is a delegable, superadmin-granted capability.
- **Server superadmin**: determined by environment (``config.superadmin_*``), can do
  everything. Not stored as a role.
- **Per-space roles** (``space_roles``): named permission *templates*.
- **Membership** (``space_members``): assigns a principal (or a pending email invite) to a
  space with a role and an optional per-principal ``permissions_override`` that wins over
  the role per top-level key. Owners get full access.

Permission shape (JSON on roles and on overrides)::

    {
        "flows": ["read:STEP", "create:INSTANCE", ...],   # <operation>:<element>
        "sequences": {"all": false, "ids": ["ID_..."]},   # which sequences may be run
        "manage_space": false                               # space-admin capability
    }

This module deliberately knows nothing about FastAPI or Clerk; ``auth.py`` wraps the
resolution functions here in HTTP guards.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from . import config, id_generator, sqlite_util

# ---------------------------------------------------------------------------
# Canonical permission vocabulary
# ---------------------------------------------------------------------------

OPERATIONS = ("create", "read", "update", "delete")
ELEMENTS = ("STEP", "SCHEMA", "INSTANCE")
ALL_FLOWS: tuple[str, ...] = tuple(f"{op}:{el}" for op in OPERATIONS for el in ELEMENTS)
READ_FLOWS: tuple[str, ...] = tuple(f"read:{el}" for el in ELEMENTS)

# Role templates seeded on every space.
ADMIN_ROLE_NAME = "Admin"
MEMBER_ROLE_NAME = "Member"


def admin_permissions() -> dict[str, Any]:
    """Full access: every flow, run any sequence, and manage the space."""
    return {
        "flows": list(ALL_FLOWS),
        "sequences": {"all": True, "ids": []},
        "manage_space": True,
    }


def member_permissions() -> dict[str, Any]:
    """Default non-admin template: full read, run any sequence, no writes/management.

    Chosen so an invited member can browse and run the space without breaking the
    builder's read pickers; write flows are opt-in via role edits or overrides.
    """
    return {
        "flows": list(READ_FLOWS),
        "sequences": {"all": True, "ids": []},
        "manage_space": False,
    }


def empty_permissions() -> dict[str, Any]:
    """No access (used for principals with no membership in a space)."""
    return {"flows": [], "sequences": {"all": False, "ids": []}, "manage_space": False}


def normalize_permissions(raw: Any) -> dict[str, Any]:
    """Coerce arbitrary input into a valid permission object, dropping unknown flows."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            raw = None
    if not isinstance(raw, dict):
        return empty_permissions()

    flows_in = raw.get("flows")
    flows = [f for f in flows_in if isinstance(f, str) and f in ALL_FLOWS] if isinstance(flows_in, list) else []

    seq_in = raw.get("sequences")
    if isinstance(seq_in, dict):
        ids_in = seq_in.get("ids")
        ids = [str(i) for i in ids_in if str(i).strip()] if isinstance(ids_in, list) else []
        sequences = {"all": bool(seq_in.get("all")), "ids": ids}
    else:
        sequences = {"all": False, "ids": []}

    return {
        "flows": sorted(set(flows)),
        "sequences": sequences,
        "manage_space": bool(raw.get("manage_space")),
    }


def sanitize_override(raw: Any) -> dict[str, Any]:
    """Validate an override, keeping ONLY the top-level keys actually provided.

    A sparse override lets callers replace just ``flows`` (say) while inheriting the
    role's ``sequences``. ``manage_space`` is deliberately NOT overridable: space
    management is granted only by role (Admin) or ownership, so a space manager cannot
    escalate another member (or themselves) to manager via a per-member override.
    """
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    if "flows" in raw:
        out["flows"] = normalize_permissions({"flows": raw.get("flows")})["flows"]
    if "sequences" in raw:
        out["sequences"] = normalize_permissions({"sequences": raw.get("sequences")})["sequences"]
    return out


def merge_permissions(base: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    """Overlay ``override`` on ``base`` per top-level key (override wins when present).

    ``manage_space`` is never taken from the override (see :func:`sanitize_override`);
    legacy stored overrides that contain it are ignored here.
    """
    result = normalize_permissions(base)
    if not override:
        return result
    ov = override if isinstance(override, dict) else {}
    if "flows" in ov:
        result["flows"] = normalize_permissions({"flows": ov.get("flows")})["flows"]
    if "sequences" in ov:
        result["sequences"] = normalize_permissions({"sequences": ov.get("sequences")})["sequences"]
    return result


# Permission predicates ------------------------------------------------------


def perms_allow_flow(perms: dict[str, Any], operation: str, element: str) -> bool:
    key = f"{(operation or '').strip().lower()}:{(element or '').strip().upper()}"
    return key in (perms.get("flows") or [])


def perms_allow_sequence(perms: dict[str, Any], sequence_id: str) -> bool:
    seqs = perms.get("sequences") or {}
    if seqs.get("all"):
        return True
    return (sequence_id or "").strip() in (seqs.get("ids") or [])


def perms_allow_manage(perms: dict[str, Any]) -> bool:
    return bool(perms.get("manage_space"))


# ---------------------------------------------------------------------------
# Connection helper
# ---------------------------------------------------------------------------


def _conn() -> sqlite3.Connection:
    return config.connect_sqlite(config.catalog_sqlite_path())


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    """Context-managed catalog connection; closing discards uncommitted writes."""
    conn = _conn()
    try:
        yield conn
    finally:
        conn.close()  # sole explicit close; call sites use this manager


_columns = sqlite_util.column_names


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    return row is not None


# ---------------------------------------------------------------------------
# Schema migration
# ---------------------------------------------------------------------------

_SPACE_MEMBERS_DDL = """
CREATE TABLE IF NOT EXISTS space_members (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    principal_id TEXT,
    invited_email TEXT,
    role_id TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
    permissions_override TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active')),
    creation_date TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_members_space_principal ON space_members (space_id, principal_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_members_space_email ON space_members (space_id, invited_email);
CREATE INDEX IF NOT EXISTS idx_space_members_principal ON space_members (principal_id);
CREATE INDEX IF NOT EXISTS idx_space_members_space ON space_members (space_id);
"""


def _ensure_users_columns(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "users"):
        return
    cols = _columns(conn, "users")
    if "principal_type" not in cols:
        conn.execute(
            "ALTER TABLE users ADD COLUMN principal_type TEXT NOT NULL DEFAULT 'user'"
        )
    if "can_create_spaces" not in cols:
        conn.execute(
            "ALTER TABLE users ADD COLUMN can_create_spaces INTEGER NOT NULL DEFAULT 0"
        )
    if "timezone" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN timezone TEXT")
    if "display_name" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN display_name TEXT")


def _ensure_space_members_table(conn: sqlite3.Connection) -> None:
    """Create the RBAC ``space_members`` shape, rebuilding the legacy table if needed."""
    if not _table_exists(conn, "space_members"):
        conn.executescript(_SPACE_MEMBERS_DDL)
        return
    cols = _columns(conn, "space_members")
    if "id" in cols and "principal_id" in cols:
        # Already migrated; make sure indexes exist.
        conn.executescript(_SPACE_MEMBERS_DDL)
        return
    # Legacy shape: (space_id, user_id, is_owner, creation_date). Rebuild and copy rows.
    legacy = conn.execute(
        "SELECT space_id, user_id, is_owner, creation_date FROM space_members"
    ).fetchall()
    conn.execute("ALTER TABLE space_members RENAME TO space_members_legacy")
    conn.executescript(_SPACE_MEMBERS_DDL)
    for row in legacy:
        conn.execute(
            "INSERT INTO space_members "
            "(id, space_id, principal_id, invited_email, role_id, is_owner, "
            " permissions_override, status, creation_date) "
            "VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'active', ?)",
            (
                id_generator.generate_id(),
                row["space_id"],
                row["user_id"],
                int(row["is_owner"] or 0),
                row["creation_date"],
            ),
        )
    conn.execute("DROP TABLE space_members_legacy")


def ensure_rbac_schema(conn: sqlite3.Connection) -> None:
    """Bring the catalog DB up to the RBAC schema and seed defaults. Idempotent."""
    _ensure_users_columns(conn)
    if not _table_exists(conn, "space_roles"):
        path = config.ROOT / "Engine" / "schema" / "space-roles-table.sql"
        if path.is_file():
            conn.executescript(path.read_text(encoding="utf-8"))
    _ensure_space_members_table(conn)
    conn.commit()
    _seed_existing_spaces(conn)
    conn.commit()


def _seed_existing_spaces(conn: sqlite3.Connection) -> None:
    """Seed Admin/Member roles for any space lacking them and assign owners the Admin role."""
    if not _table_exists(conn, "spaces"):
        return
    space_ids = [r[0] for r in conn.execute("SELECT id FROM spaces").fetchall()]
    for sid in space_ids:
        roles = _seed_default_roles(conn, sid)
        admin_id = roles.get(ADMIN_ROLE_NAME)
        if admin_id:
            conn.execute(
                "UPDATE space_members SET role_id = ? "
                "WHERE space_id = ? AND is_owner = 1 AND (role_id IS NULL OR role_id = '')",
                (admin_id, sid),
            )


def _seed_default_roles(conn: sqlite3.Connection, space_id: str) -> dict[str, str]:
    """Ensure the Admin/Member roles exist for a space; return {name: role_id}."""
    sid = (space_id or "").strip()
    out: dict[str, str] = {}
    existing = conn.execute(
        "SELECT id, name FROM space_roles WHERE space_id = ?", (sid,)
    ).fetchall()
    for r in existing:
        out[r["name"]] = r["id"]
    seeds = (
        (ADMIN_ROLE_NAME, admin_permissions(), 0),
        (MEMBER_ROLE_NAME, member_permissions(), 1),
    )
    for name, perms, is_default in seeds:
        if name in out:
            continue
        role_id = id_generator.generate_id()
        conn.execute(
            "INSERT INTO space_roles (id, space_id, name, permissions, is_default) "
            "VALUES (?, ?, ?, ?, ?)",
            (role_id, sid, name, json.dumps(perms), is_default),
        )
        out[name] = role_id
    return out


def seed_default_roles(space_id: str) -> dict[str, str]:
    """Public wrapper: seed Admin/Member roles for a (freshly created) space."""
    with _connection() as conn:
        out = _seed_default_roles(conn, space_id)
        conn.commit()
        return out


# ---------------------------------------------------------------------------
# Roles CRUD
# ---------------------------------------------------------------------------


def list_roles(space_id: str) -> list[dict[str, Any]]:
    with _connection() as conn:
        rows = conn.execute(
            "SELECT id, space_id, name, permissions, is_default, creation_date "
            "FROM space_roles WHERE space_id = ? ORDER BY is_default DESC, name",
            ((space_id or "").strip(),),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "space_id": r["space_id"],
                "name": r["name"],
                "permissions": normalize_permissions(r["permissions"]),
                "is_default": bool(r["is_default"]),
                "creation_date": r["creation_date"],
            }
            for r in rows
        ]


def upsert_role(
    space_id: str, name: str, permissions: dict[str, Any], role_id: str | None = None
) -> dict[str, Any]:
    sid = (space_id or "").strip()
    nm = (name or "").strip()
    if not sid or not nm:
        raise ValueError("space_id and name are required")
    if nm.strip().lower() == ADMIN_ROLE_NAME.lower():
        raise ValueError("The Admin role is built in and cannot be created or edited.")
    perms = normalize_permissions(permissions)
    with _connection() as conn:
        rid = (role_id or "").strip()
        if rid:
            existing = conn.execute(
                "SELECT name FROM space_roles WHERE id = ? AND space_id = ?", (rid, sid)
            ).fetchone()
            if existing is not None and str(existing["name"]).lower() == ADMIN_ROLE_NAME.lower():
                raise ValueError("The Admin role is built in and cannot be edited.")
            conn.execute(
                "UPDATE space_roles SET name = ?, permissions = ?, "
                "modified_date = datetime('now') WHERE id = ? AND space_id = ?",
                (nm, json.dumps(perms), rid, sid),
            )
        else:
            rid = id_generator.generate_id()
            conn.execute(
                "INSERT INTO space_roles (id, space_id, name, permissions, is_default) "
                "VALUES (?, ?, ?, ?, 0)",
                (rid, sid, nm, json.dumps(perms)),
            )
        conn.commit()
        return {"id": rid, "space_id": sid, "name": nm, "permissions": perms}


def delete_role(space_id: str, role_id: str) -> dict[str, Any]:
    sid = (space_id or "").strip()
    rid = (role_id or "").strip()
    if not sid or not rid:
        raise ValueError("space_id and role_id are required")
    with _connection() as conn:
        existing = conn.execute(
            "SELECT name FROM space_roles WHERE id = ? AND space_id = ?", (rid, sid)
        ).fetchone()
        if existing is not None and str(existing["name"]).lower() == ADMIN_ROLE_NAME.lower():
            raise ValueError("The Admin role is built in and cannot be deleted.")
        # Detach the role from any memberships using it before removing it.
        conn.execute(
            "UPDATE space_members SET role_id = NULL WHERE space_id = ? AND role_id = ?",
            (sid, rid),
        )
        conn.execute(
            "DELETE FROM space_roles WHERE id = ? AND space_id = ? AND is_default = 0",
            (rid, sid),
        )
        conn.commit()
        return {"id": rid, "deleted": True}


# ---------------------------------------------------------------------------
# Membership CRUD + invite linking
# ---------------------------------------------------------------------------


def _require_role_in_space(
    conn: sqlite3.Connection, role_id: str | None, space_id: str
) -> str | None:
    """Return the trimmed role id if it belongs to ``space_id``; raise otherwise.

    Prevents privilege escalation by attaching another space's role (e.g. a foreign
    Admin role id) to a membership in this space.
    """
    rid = (role_id or "").strip()
    if not rid:
        return None
    row = conn.execute(
        "SELECT id FROM space_roles WHERE id = ? AND space_id = ?", (rid, space_id)
    ).fetchone()
    if row is None:
        raise ValueError(f"Unknown role for this space: {rid!r}")
    return rid


def is_space_owner(principal_id: str, space_id: str) -> bool:
    """Whether the principal is an active owner of the space."""
    pid = (principal_id or "").strip()
    sid = (space_id or "").strip()
    if not pid or not sid:
        return False
    with _connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM space_members "
            "WHERE space_id = ? AND principal_id = ? AND is_owner = 1 AND status = 'active'",
            (sid, pid),
        ).fetchone()
        return row is not None


def is_space_member(user_id: str, space_id: str) -> bool:
    """Whether the principal has an active membership in the space."""
    sid = (space_id or "").strip()
    uid = (user_id or "").strip()
    if not sid or not uid:
        return False
    with _connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM space_members "
            "WHERE principal_id = ? AND space_id = ? AND status = 'active'",
            (uid, sid),
        ).fetchone()
        return row is not None


def member_space_ids(user_id: str) -> set[str]:
    """All space ids the principal is an active member of."""
    uid = (user_id or "").strip()
    if not uid:
        return set()
    with _connection() as conn:
        rows = conn.execute(
            "SELECT space_id FROM space_members WHERE principal_id = ? AND status = 'active'",
            (uid,),
        ).fetchall()
        return {r["space_id"] for r in rows}


def add_member(
    space_id: str,
    principal_id: str,
    is_owner: bool = False,
    role_id: str | None = None,
) -> None:
    """Add (or upgrade) an active membership for a known principal. Idempotent."""
    sid = (space_id or "").strip()
    pid = (principal_id or "").strip()
    if not sid or not pid:
        return
    with _connection() as conn:
        rid = _require_role_in_space(conn, role_id, sid)
        existing = conn.execute(
            "SELECT id FROM space_members WHERE space_id = ? AND principal_id = ?",
            (sid, pid),
        ).fetchone()
        if existing is not None:
            conn.execute(
                "UPDATE space_members SET is_owner = MAX(is_owner, ?), "
                "role_id = COALESCE(?, role_id), status = 'active' WHERE id = ?",
                (1 if is_owner else 0, rid, existing["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO space_members "
                "(id, space_id, principal_id, role_id, is_owner, status) "
                "VALUES (?, ?, ?, ?, ?, 'active')",
                (id_generator.generate_id(), sid, pid, rid, 1 if is_owner else 0),
            )
        conn.commit()


def invite_member(space_id: str, email: str, role_id: str | None = None) -> dict[str, Any]:
    """Create a pending invite by email, or link immediately if the user already exists."""
    sid = (space_id or "").strip()
    em = (email or "").strip()
    if not sid or not em:
        raise ValueError("space_id and email are required")
    with _connection() as conn:
        rid = _require_role_in_space(conn, role_id, sid)
        # If the invitee already has an account, attach them directly as active.
        user = conn.execute(
            "SELECT id FROM users WHERE lower(email) = lower(?)", (em,)
        ).fetchone()
        existing = conn.execute(
            "SELECT id FROM space_members "
            "WHERE space_id = ? AND (lower(invited_email) = lower(?) "
            "   OR (principal_id IS NOT NULL AND principal_id = ?))",
            (sid, em, user["id"] if user else "\u0000"),
        ).fetchone()
        if existing is not None:
            raise ValueError("That principal is already a member or has a pending invite.")
        member_id = id_generator.generate_id()
        if user is not None:
            conn.execute(
                "INSERT INTO space_members "
                "(id, space_id, principal_id, invited_email, role_id, status) "
                "VALUES (?, ?, ?, ?, ?, 'active')",
                (member_id, sid, user["id"], em, rid),
            )
            status = "active"
        else:
            conn.execute(
                "INSERT INTO space_members "
                "(id, space_id, principal_id, invited_email, role_id, status) "
                "VALUES (?, ?, NULL, ?, ?, 'pending')",
                (member_id, sid, em, rid),
            )
            status = "pending"
        conn.commit()
        return {"id": member_id, "space_id": sid, "email": em, "status": status}


def claim_pending_invites(principal_id: str, email: str) -> int:
    """Attach any pending email invites to a principal on sign-in. Returns count claimed."""
    pid = (principal_id or "").strip()
    em = (email or "").strip()
    if not pid or not em:
        return 0
    with _connection() as conn:
        cur = conn.execute(
            "UPDATE space_members SET principal_id = ?, status = 'active' "
            "WHERE status = 'pending' AND principal_id IS NULL "
            "  AND lower(invited_email) = lower(?) "
            "  AND space_id NOT IN ("
            "      SELECT space_id FROM space_members WHERE principal_id = ?"
            "  )",
            (pid, em, pid),
        )
        conn.commit()
        return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


def update_member(
    space_id: str,
    member_id: str,
    role_id: str | None = None,
    permissions_override: dict[str, Any] | None = None,
    is_owner: bool | None = None,
    clear_override: bool = False,
) -> dict[str, Any]:
    sid = (space_id or "").strip()
    mid = (member_id or "").strip()
    if not sid or not mid:
        raise ValueError("space_id and member_id are required")
    with _connection() as conn:
        sets: list[str] = []
        args: list[Any] = []
        if role_id is not None:
            sets.append("role_id = ?")
            args.append(_require_role_in_space(conn, role_id, sid))
        if clear_override:
            sets.append("permissions_override = NULL")
        elif permissions_override is not None:
            sets.append("permissions_override = ?")
            args.append(json.dumps(sanitize_override(permissions_override)))
        if is_owner is not None:
            sets.append("is_owner = ?")
            args.append(1 if is_owner else 0)
        if not sets:
            return {"id": mid, "updated": False}
        if is_owner is False:
            current = conn.execute(
                "SELECT is_owner FROM space_members WHERE id = ? AND space_id = ?",
                (mid, sid),
            ).fetchone()
            if current is not None and current["is_owner"] and _active_owner_count(conn, sid) <= 1:
                raise ValueError("Cannot demote the only owner; assign another owner first.")
        args.extend([mid, sid])
        conn.execute(
            f"UPDATE space_members SET {', '.join(sets)} WHERE id = ? AND space_id = ?",
            args,
        )
        conn.commit()
        return {"id": mid, "updated": True}


def _active_owner_count(conn: sqlite3.Connection, space_id: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM space_members "
        "WHERE space_id = ? AND is_owner = 1 AND status = 'active'",
        (space_id,),
    ).fetchone()
    return int(row["c"]) if row else 0


def remove_member(space_id: str, member_id: str) -> dict[str, Any]:
    sid = (space_id or "").strip()
    mid = (member_id or "").strip()
    if not sid or not mid:
        raise ValueError("space_id and member_id are required")
    with _connection() as conn:
        member = conn.execute(
            "SELECT is_owner, status FROM space_members WHERE id = ? AND space_id = ?",
            (mid, sid),
        ).fetchone()
        if member is not None and member["is_owner"] and _active_owner_count(conn, sid) <= 1:
            raise ValueError("Cannot remove the only owner; assign another owner first.")
        conn.execute(
            "DELETE FROM space_members WHERE id = ? AND space_id = ?", (mid, sid)
        )
        conn.commit()
        return {"id": mid, "deleted": True}


def list_members(space_id: str) -> list[dict[str, Any]]:
    """List a space's memberships joined to user + role names for the management UI."""
    sid = (space_id or "").strip()
    with _connection() as conn:
        rows = conn.execute(
            "SELECT m.id, m.space_id, m.principal_id, m.invited_email, m.role_id, "
            "       m.is_owner, m.permissions_override, m.status, "
            "       u.email AS user_email, u.display_name AS user_name, "
            "       u.principal_type, r.name AS role_name "
            "FROM space_members m "
            "LEFT JOIN users u ON u.id = m.principal_id "
            "LEFT JOIN space_roles r ON r.id = m.role_id "
            "WHERE m.space_id = ? ORDER BY m.is_owner DESC, m.status, "
            "       COALESCE(u.display_name, u.email, m.invited_email)",
            (sid,),
        ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            override = None
            if r["permissions_override"]:
                override = normalize_permissions(r["permissions_override"])
            out.append(
                {
                    "id": r["id"],
                    "space_id": r["space_id"],
                    "principal_id": r["principal_id"],
                    "email": r["user_email"] or r["invited_email"],
                    "name": r["user_name"],
                    "principal_type": r["principal_type"] or ("user" if r["principal_id"] else None),
                    "role_id": r["role_id"],
                    "role_name": r["role_name"],
                    "is_owner": bool(r["is_owner"]),
                    "permissions_override": override,
                    "status": r["status"],
                }
            )
        return out


# ---------------------------------------------------------------------------
# Permission resolution
# ---------------------------------------------------------------------------


def resolve_effective_permissions(
    principal_id: str, space_id: str, is_superadmin: bool = False
) -> dict[str, Any]:
    """Compute a principal's effective permissions in a space.

    superadmin -> all; space owner -> all; otherwise the role template merged with the
    membership's per-principal override. Non-members get :func:`empty_permissions`.
    """
    if is_superadmin:
        return admin_permissions()
    pid = (principal_id or "").strip()
    sid = (space_id or "").strip()
    if not pid or not sid:
        return empty_permissions()
    with _connection() as conn:
        member = conn.execute(
            "SELECT is_owner, role_id, permissions_override FROM space_members "
            "WHERE space_id = ? AND principal_id = ? AND status = 'active'",
            (sid, pid),
        ).fetchone()
        if member is None:
            return empty_permissions()
        if member["is_owner"]:
            return admin_permissions()
        base = empty_permissions()
        if member["role_id"]:
            # Scope the role lookup to this space so a foreign role id attached to a
            # membership (e.g. another space's Admin) can never grant permissions here.
            role = conn.execute(
                "SELECT name, permissions FROM space_roles WHERE id = ? AND space_id = ?",
                (member["role_id"], sid),
            ).fetchone()
            if role is not None:
                # The Admin role is a built-in primitive: always full access.
                if str(role["name"]).lower() == ADMIN_ROLE_NAME.lower():
                    return admin_permissions()
                base = normalize_permissions(role["permissions"])
        override = None
        if member["permissions_override"]:
            try:
                override = json.loads(member["permissions_override"])
            except (ValueError, TypeError):
                override = None
        return merge_permissions(base, override)


# ---------------------------------------------------------------------------
# Principal (server-level) helpers
# ---------------------------------------------------------------------------


def list_principals() -> list[dict[str, Any]]:
    with _connection() as conn:
        rows = conn.execute(
            "SELECT id, clerk_user_id, email, display_name, principal_type, "
            "       can_create_spaces, is_instance_admin, creation_date "
            "FROM users ORDER BY creation_date"
        ).fetchall()
        return [
            {
                "id": r["id"],
                "email": r["email"],
                "name": r["display_name"],
                "principal_type": r["principal_type"],
                "can_create_spaces": bool(r["can_create_spaces"]),
                "is_instance_admin": bool(r["is_instance_admin"]),
                "creation_date": r["creation_date"],
            }
            for r in rows
        ]


def set_can_create_spaces(principal_id: str, can_create: bool) -> dict[str, Any]:
    pid = (principal_id or "").strip()
    if not pid:
        raise ValueError("principal_id is required")
    with _connection() as conn:
        conn.execute(
            "UPDATE users SET can_create_spaces = ?, modified_date = datetime('now') "
            "WHERE id = ?",
            (1 if can_create else 0, pid),
        )
        conn.commit()
        return {"id": pid, "can_create_spaces": bool(can_create)}


def set_user_timezone(principal_id: str, timezone: str | None) -> dict[str, Any]:
    """Persist a principal's preferred IANA timezone (or clear it with NULL)."""
    pid = (principal_id or "").strip()
    if not pid:
        raise ValueError("principal_id is required")
    tz = (timezone or "").strip() or None
    with _connection() as conn:
        conn.execute(
            "UPDATE users SET timezone = ?, modified_date = datetime('now') WHERE id = ?",
            (tz, pid),
        )
        conn.commit()
        return {"id": pid, "timezone": tz}
