-- Catalog table: server-issued browser sessions for built-in auth (data.db).
-- A session token is 32 random bytes (prefixed pfs_) handed to the browser in an HttpOnly
-- cookie; only its SHA-256 hex is persisted, mirroring agent_keys. Rows past expires_at
-- are ignored on lookup and pruned opportunistically.

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
