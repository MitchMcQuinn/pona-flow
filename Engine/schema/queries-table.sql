-- Catalog table: persisted QUERY / CRUD executor packages (data.db).
-- JSON columns store JSON arrays (see README and Engine/QUERY-package.schema.json crudPackageV2).

CREATE TABLE IF NOT EXISTS queries (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('system', 'user', 'operation', 'sequence')),
    operation TEXT NOT NULL DEFAULT 'read' CHECK (operation IN ('create', 'read', 'update', 'delete')),
    runtime_enabled INTEGER NOT NULL DEFAULT 1 CHECK (runtime_enabled IN (0, 1)),
    author_selectable INTEGER NOT NULL DEFAULT 1 CHECK (author_selectable IN (0, 1)),
    triggerable INTEGER NOT NULL DEFAULT 1 CHECK (triggerable IN (0, 1)),
    -- A sequence is suspended when a SCHEMA change invalidated one of its INSTANCE steps.
    -- Suspended sequences cannot be composed/run (by users or agents) until the offending
    -- INSTANCE step is re-saved to match the new SCHEMA pattern. Only ever set on kind=sequence.
    suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
    group_title TEXT,
    -- Human/agent-facing prose. For a sequence this becomes its MCP tool description, so
    -- an LLM agent can tell what the sequence does before calling it.
    description TEXT NOT NULL DEFAULT '',
    cypher TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cypher)),
    sqlite TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sqlite)),
    parameters TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parameters)),
    -- Declarative builder snapshot (QueryObject + runtime/positions) so a saved operation can be
    -- round-tripped back into the builder for editing; the composer is forward-only (no decompiler).
    builder_config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(builder_config)),
    -- Loop policy for a sequence: which termination rule applies to the one cycle in its STEP
    -- graph. Read directly by the executor's composer (not via builder_config, which is an
    -- authoring snapshot the engine deliberately does not depend on). Only ever set on
    -- kind=sequence; '{}' or type='dag' means the historical single-pass walk.
    loop_config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(loop_config)),
    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
);
