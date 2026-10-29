-- Catalog table: consoles (dashboards) for a space (data.db).
-- A console is a Mantine dashboard. Its trigger is either a listen URL or a
-- non-simulated event. The document holds views: live modules keep HTTP URLs,
-- form views name the sequences that load and submit the form.
--
--   trigger_kind     -> '' | 'url' | 'event'
--   listen_url       -> SSE URL used when trigger_kind is 'url'
--   trigger_event_id -> time or external event id used when trigger_kind is 'event'
--   document         -> { views: [...], activeViewId }

CREATE TABLE IF NOT EXISTS consoles (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    name TEXT NOT NULL,
    trigger_kind TEXT NOT NULL DEFAULT '' CHECK (trigger_kind IN ('', 'url', 'event')),
    listen_url TEXT NOT NULL DEFAULT '',
    trigger_event_id TEXT NOT NULL DEFAULT '',
    document TEXT NOT NULL DEFAULT '{"views":[],"activeViewId":""}' CHECK (json_valid(document)),
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now')),
    group_title TEXT,
    sort_order INTEGER
);

CREATE INDEX IF NOT EXISTS idx_consoles_space ON consoles (space_id);
CREATE INDEX IF NOT EXISTS idx_consoles_trigger_event ON consoles (trigger_event_id);
