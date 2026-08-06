-- Catalog migration: dev mode flag per space (data.db spaces table).
-- Applied automatically by Engine/server/spaces.py on dev server start and catalog connect.
-- Manual apply: sqlite3 data.db < Engine/schema/spaces-dev-mode-column.sql

ALTER TABLE spaces ADD COLUMN dev_mode INTEGER NOT NULL DEFAULT 0;
