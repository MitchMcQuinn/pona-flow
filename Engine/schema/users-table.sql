-- Catalog table: local principal records (data.db).
-- Identity/passwords for human users are delegated to Clerk (see Docs/DECISIONS.md D3);
-- this table maps a Clerk user (clerk_user_id = JWT `sub`) to a local id used for space
-- membership. It is also the future home of agent principals (principal_type = 'agent'),
-- which authenticate via API keys rather than Clerk, hence clerk_user_id is nullable.
--
-- The single server superadmin is determined by environment (SUPERADMIN_CLERK_ID /
-- SUPERADMIN_EMAIL), not by this table; is_instance_admin is retained for compatibility.
-- can_create_spaces is a delegable, superadmin-granted capability.
--
-- timezone is the principal's preferred IANA zone (e.g. 'America/New_York'), set from
-- user settings and used by the UI to display event times locally. NULL = display UTC.

-- display_name is a cached human label resolved from Clerk's Backend API (full name or
-- username). NULL until enriched; the UI falls back to email, then the principal id.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    clerk_user_id TEXT UNIQUE,
    email TEXT,
    display_name TEXT,
    principal_type TEXT NOT NULL DEFAULT 'user' CHECK (principal_type IN ('user', 'agent')),
    can_create_spaces INTEGER NOT NULL DEFAULT 0 CHECK (can_create_spaces IN (0, 1)),
    is_instance_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_instance_admin IN (0, 1)),
    timezone TEXT,
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_clerk_user_id ON users (clerk_user_id);
