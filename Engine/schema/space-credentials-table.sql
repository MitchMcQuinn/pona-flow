-- Catalog table: per-space credential registry (data.db).
-- Stores credential METADATA only -- never the secret value. The value lives in the
-- selected credential store backend (locally: a .env key named by env_key; hosted: a
-- provider secret), mirroring the spaces table's "store key names, not secrets" model
-- (Docs/DECISIONS.md D6). A workflow references a credential at runtime as $secret.<name>;
-- the executor resolves it from the store and never persists or logs the value.

CREATE TABLE IF NOT EXISTS space_credentials (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    name TEXT NOT NULL,
    env_key TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    backend TEXT NOT NULL DEFAULT 'local',
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_space_credentials_space ON space_credentials (space_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_credentials_space_name
    ON space_credentials (space_id, name);
