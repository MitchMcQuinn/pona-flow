-- Catalog table: string format names and validation regex patterns (data.db).
-- Used by the React QUERY builder format dropdown and @pona-flow/regex-validator.

CREATE TABLE IF NOT EXISTS regex (
    name TEXT PRIMARY KEY NOT NULL,
    regex TEXT NOT NULL
);

INSERT OR IGNORE INTO regex (name, regex) VALUES
    ('any', ''),
    ('email', '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'),
    ('phone', '^\+?[\d\s().-]{7,20}$'),
    ('point', '^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$'),
    ('URL', '^https?://[^\s/$.?#][^\s]*$'),
    ('ZIP', '^\d{5}(-\d{4})?$'),
    ('color', '^(#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6}|[a-zA-Z]+)$');
