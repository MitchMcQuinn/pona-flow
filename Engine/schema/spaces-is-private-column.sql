-- Catalog migration: public vs private spaces (data.db spaces table).
-- Applied automatically by Engine/server/spaces.py on dev server start and catalog connect.
-- Manual apply: sqlite3 data.db < Engine/schema/spaces-is-private-column.sql

ALTER TABLE spaces ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
