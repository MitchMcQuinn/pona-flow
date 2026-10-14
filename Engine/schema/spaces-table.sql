-- Catalog table: the spaces registry (data.db). Applied first at startup.
--
-- A space is a tenant-like working environment. Connection details are stored
-- INDIRECTLY: the *_key columns hold the NAMES of environment variables whose values are
-- the real Neo4j URI / user / password and per-space SQLite path (e.g. MARKETING_NEO4J_URI).
-- When a space-specific variable is unset the runtime falls back to the shared
-- NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD / SQLITE_DATABASE_PATH, so a brand-new instance
-- needs only those four set. Later columns (groups, is_private, dev_mode, ...) are added
-- by server.spaces.ensure_catalog_space_schema for catalogs that predate them.

CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    endpoint TEXT,
    labels TEXT NOT NULL DEFAULT '[]',
    keys TEXT NOT NULL DEFAULT '{}',
    neo4j_uri_key TEXT NOT NULL,
    neo4j_user_key TEXT NOT NULL,
    neo4j_password_key TEXT NOT NULL,
    sqlite_database_path_key TEXT NOT NULL,
    creation_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
