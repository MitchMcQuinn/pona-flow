-- Catalog migration: hide empty sequence groups in the nav (data.db spaces table).
-- Applied automatically by Engine/server/spaces.py on dev server start and catalog connect.
-- Manual apply: sqlite3 data.db < Engine/schema/spaces-hide-empty-groups-column.sql

ALTER TABLE spaces ADD COLUMN hide_empty_sequence_groups INTEGER NOT NULL DEFAULT 0;
