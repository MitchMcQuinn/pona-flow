-- Catalog table: event (trigger) definitions (data.db).
-- An event fires one or more sequences when its rule package becomes active.
-- Time-bound events (type = 'time') are evaluated by the in-process scheduler;
-- external events (type = 'external') are fired by an inbound HTTP POST to the
-- per-event ingest URL (see Engine/server/external_triggers.py).
--
-- JSON columns:
--   event_package      -> { combinator, groups: [...], parameters: {...}, timezone? }
--                         (the conditional rule tree + fixed run-time parameters; the
--                          optional IANA `timezone` localizes rule evaluation, default UTC)
--   external_package   -> { ingest_token, secret?, combinator, filters: [...],
--                          param_mappings: [...], parameters: {...} }
--                         (external-trigger config: the inbound ingest token, an optional
--                          HMAC shared secret, payload match filters, payload->param
--                          mappings, and fixed fallback parameters)
--   sequences          -> ["ID_...", ...]  sequence query ids to run on activation
--   timers             -> { next_fire_at, last_fired_at }  scheduler countdown state
--   recovery_sequences -> ["ID_...", ...]  sequences to run if a fire was missed

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'time' CHECK (type IN ('time', 'external')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    event_package TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(event_package)),
    external_package TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(external_package)),
    sequences TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sequences)),
    timers TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(timers)),
    recovery_sequences TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recovery_sequences)),
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_space ON events (space_id);
