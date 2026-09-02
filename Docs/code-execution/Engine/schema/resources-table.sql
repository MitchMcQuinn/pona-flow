-- Catalog table: per-space code resource registry (data.db).
-- Maps a code-execution STEP's resource UID to the on-disk code file plus its
-- name/description metadata. The code itself lives OUTSIDE the database in a
-- gitignored folder (default: <repo>/resources, override with
-- PONA_FLOW_RESOURCES_DIR); ``path`` is relative to that folder, e.g.
-- ``code/<SPACE_ID>/<resource_id>.py``. A workflow STEP references a resource
-- by id ({"kind": "code", "resource_id": ...} in its entities payload); the
-- executor loads the file and ships it to the sandbox runner -- the main app
-- never executes resource code in-process.

CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'python' CHECK (language IN ('python', 'javascript')),
    path TEXT NOT NULL,
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_resources_space ON resources (space_id);
