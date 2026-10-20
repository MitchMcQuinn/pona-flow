-- Latest sample payload captured by an external event's test endpoint.
-- POST /api/hooks/{ingest_token}/test stores one row per event (replaced on each
-- request) so the event builder can show what arrived without running sequences.
-- payload is the parsed JSON body, or {"raw": "..."} when the body was not JSON.

CREATE TABLE IF NOT EXISTS event_test_captures (
    event_id TEXT PRIMARY KEY NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    content_type TEXT,
    payload TEXT NOT NULL
);
