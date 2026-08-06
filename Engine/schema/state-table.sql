-- Catalog table: persisted EXECUTION packages (data.db).
-- package column stores JSON matching Docs/EXECUTION-package.schema.json.

CREATE TABLE IF NOT EXISTS state (
    id TEXT PRIMARY KEY NOT NULL,
    package TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(package)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'pending', 'inactive')),
    run_start_date TEXT,
    -- Executor resume state: remaining step queue + resolved values + visited steps.
    progress TEXT
);
