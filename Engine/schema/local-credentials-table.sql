-- Catalog table: built-in (email + password) credentials for human principals (data.db).
-- Used when PONA_FLOW_AUTH_MODE=local (the default for self-hosted instances). Each row
-- belongs to exactly one users row. Passwords are stored as a salted scrypt hash in the
-- self-describing form  scrypt$<n>$<r>$<p>$<salt_b64>$<hash_b64>  -- never in plaintext.
-- Clerk-mode instances never populate this table.

CREATE TABLE IF NOT EXISTS local_credentials (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_local_credentials_email ON local_credentials (email);
