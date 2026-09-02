-- Catalog table: audit log of sequence runs (data.db).
-- A row is written whenever a sequence is run, whether manually (via the UI /
-- /api/sequence/run), by an event trigger / recovery on the scheduler, or by an
-- agent through the webhook routes or the MCP gateway.
--
--   sequence_ids -> ["ID_...", ...]  sequence query ids included in this run
--   event_id     -> the firing event's id, or NULL for a manual run
--   trigger      -> 'manual' | 'event' | 'recovery' | 'webhook' | 'mcp' | 'code' | 'external'
--   principal_id -> the principal that executed the run (user or agent), or NULL
--                   for event/recovery runs fired by the scheduler (no principal)
--   detail       -> optional JSON context (never parameters, outputs, or secrets).
--                   Historical rows may still use trigger 'code' from archived
--                   code-execution STEPs (see Docs/code-execution/).
--
-- NOTE: existing databases created with the old CHECK lists are rebuilt at
-- startup by Engine/server/migrations.py (_ensure_audit_log_trigger_check);
-- the detail column is added there too (_ensure_audit_log_detail_column).

CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    run_at TEXT NOT NULL DEFAULT (datetime('now')),
    space_id TEXT,
    sequence_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sequence_ids)),
    event_id TEXT,
    trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'event', 'recovery', 'webhook', 'mcp', 'code', 'external')),
    principal_id TEXT,
    detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_run_at ON audit_log (run_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_space ON audit_log (space_id);
