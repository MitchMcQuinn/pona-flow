-- Catalog table: tracks template import runs so an interrupted import can resume
-- idempotently (data.db).
--
-- A row is keyed by the template's own id. The `plan` column stores the fully
-- resolved, ordered list of cypher/sqlite statements (with freshly regenerated ids
-- and any user name remaps already baked in); `progress` records how far execution
-- got. Because the plan's ids are fixed once persisted and every statement is an
-- idempotent MERGE/upsert, re-running the same template_id skips applied statements
-- and never creates duplicates.

CREATE TABLE IF NOT EXISTS template_imports (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'validated', 'applying', 'complete', 'failed')),
    plan TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(plan)),
    progress TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress)),
    error TEXT,
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_template_imports_space ON template_imports (space_id);
