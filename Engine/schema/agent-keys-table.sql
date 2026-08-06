-- Catalog table: agent API keys (data.db).
-- Authenticates non-Clerk "agent" principals for the inbound sequence webhook (and the
-- future per-space MCP server). Each key belongs to one space and maps to one agent
-- principal (users.principal_type = 'agent') whose space_members role decides which
-- sequences it may run -- the human-in-the-loop run path is reused unchanged.
--
-- Secrets are never stored in plaintext: only key_hash (SHA-256 hex of the token) is
-- persisted. The plaintext token is shown once at mint time and cannot be recovered.

CREATE TABLE IF NOT EXISTS agent_keys (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    last_used_date TEXT,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
    creation_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_keys_space ON agent_keys (space_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_keys_hash ON agent_keys (key_hash);
