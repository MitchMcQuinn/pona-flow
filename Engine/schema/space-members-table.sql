-- Catalog table: space membership + RBAC assignment (data.db).
-- Hybrid RBAC (see Engine/server/rbac.py): each membership references a space_roles
-- template (role_id) and may carry a per-principal permissions_override JSON that wins
-- over the role per top-level key. Owners (is_owner = 1) and the server superadmin have
-- full access regardless of role.
--
-- Invite flow: a membership may be created as 'pending' with only invited_email set
-- (principal_id NULL). When that email signs in, the row is claimed (principal_id set,
-- status -> 'active'). Unique indexes allow many NULLs, so multiple pending invites and
-- multiple agent rows coexist.
--
-- NOTE: this table is created/migrated by Engine/server/rbac.py (it rebuilds the legacy
-- (space_id, user_id) shape), not by the migrations DDL loop.

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
