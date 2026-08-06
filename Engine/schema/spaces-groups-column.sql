-- Catalog migration: nav group titles per space (data.db spaces table).
-- Applied automatically by Engine/server/spaces.py on dev server start and catalog connect.
-- Manual apply: sqlite3 data.db < Engine/schema/spaces-groups-column.sql

ALTER TABLE spaces ADD COLUMN groups TEXT NOT NULL DEFAULT '{"groups":[]}';
