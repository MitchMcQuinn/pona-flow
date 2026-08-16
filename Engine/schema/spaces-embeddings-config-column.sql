-- Catalog migration: per-space vector-search settings (data.db spaces table).
-- JSON: {enabled, ollama_url, embed_model, dimensions}. See Engine/server/embeddings.py.
-- Applied automatically by Engine/server/spaces.py on dev server start and catalog connect.
-- Manual apply: sqlite3 data.db < Engine/schema/spaces-embeddings-config-column.sql

ALTER TABLE spaces ADD COLUMN embeddings_config TEXT NOT NULL DEFAULT '{}';
