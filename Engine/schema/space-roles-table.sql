-- Catalog table: per-space RBAC roles (data.db).
-- A role is a named permission template within one space (hybrid RBAC: roles are
-- templates, space_members may override per principal). permissions is a JSON object
-- of the shape:
--   { "flows": ["read:STEP", ...], "sequences": {"all": false, "ids": [...]},
--     "manage_space": false }
-- See Engine/server/rbac.py for the canonical permission shape and defaults.

CREATE TABLE IF NOT EXISTS space_roles (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    name TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(permissions)),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_space_roles_space_name ON space_roles (space_id, name);
CREATE INDEX IF NOT EXISTS idx_space_roles_space ON space_roles (space_id);
