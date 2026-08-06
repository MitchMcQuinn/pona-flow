-- Per-space / catalog entities table (typically data.db).
-- node_label: graph label (STEP, SCHEMA, INSTANCE).
-- common_label: STEP/SCHEMA → attributive_label; INSTANCE → value of the is_label property.

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY NOT NULL,
    node_label TEXT NOT NULL,
    common_label TEXT,
    parameters TEXT,
    payload TEXT,
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
);
