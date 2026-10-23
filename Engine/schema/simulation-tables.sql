-- Catalog tables: on-demand simulation sessions and the emissions they record (data.db).
-- A simulated event (events.type = 'simulated') owns many sessions. Each session is a
-- tic timeline; advancing a tic appends one emissions row per due probability.
-- These are not the auth `sessions` table (browser login cookies).

CREATE TABLE IF NOT EXISTS simulation_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'error')),
    current_tic INTEGER NOT NULL DEFAULT 0,
    world_start_at TEXT NOT NULL,
    current_world_time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    error_message TEXT,
    name TEXT
);

CREATE INDEX IF NOT EXISTS idx_simulation_sessions_event ON simulation_sessions (event_id);
CREATE INDEX IF NOT EXISTS idx_simulation_sessions_space ON simulation_sessions (space_id);

CREATE TABLE IF NOT EXISTS simulation_emissions (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    probability_id TEXT NOT NULL,
    probability_name TEXT NOT NULL,
    tic INTEGER NOT NULL,
    world_time TEXT NOT NULL,
    outcome_json TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
    sequence_id TEXT,
    run_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_simulation_emissions_session ON simulation_emissions (session_id);
CREATE INDEX IF NOT EXISTS idx_simulation_emissions_event ON simulation_emissions (event_id);
