-- Catalog table: named local LLM configs (data.db).
-- Each row is a saved Ollama setup (model + system prompt + options + response format)
-- scoped to one space. Sequence STEPs of kind ``local_llm`` reference these by id;
-- at run time the engine calls Ollama /api/generate with the stored settings and the
-- sequence's ``prompt`` parameter.

CREATE TABLE IF NOT EXISTS local_llm_configs (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '{}',
    response_format TEXT NOT NULL DEFAULT '{"type":"text"}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_local_llm_configs_space ON local_llm_configs (space_id);
