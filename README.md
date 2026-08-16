# pona flow

pona flow is a hybrid SQLite/graph-based design system and runtime application for agentic context engineering.

## Development setup

**First-time local instance (clone → env → Neo4j → run):** follow
[Docs/FIRST-TIME-SETUP.md](Docs/FIRST-TIME-SETUP.md) end to end. The short version below is
the same path in compressed form.

macOS Homebrew Python does not allow `pip install` globally (PEP 668). Use a project virtual environment:

```bash
cd pona-flow
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and set Neo4j / SQLite values **and Clerk auth values**
(`CLERK_ISSUER` for the server; `VITE_CLERK_PUBLISHABLE_KEY` in `App/ui/.env` for the UI).
The server now requires a verified Clerk session token on every `/api/*` route, so a
Clerk app (the free development instance is fine) is needed even for local development.
See [Docs/DECISIONS.md](Docs/DECISIONS.md) and [Docs/DEPLOYMENT.md](Docs/DEPLOYMENT.md).
New users (non-technical onboarding): [Docs/GETTING-STARTED.md](Docs/GETTING-STARTED.md).

Then run the development server (FastAPI/ASGI via uvicorn):

```bash
source .venv/bin/activate
python Engine/dev_server.py
# React dashboard (rebuild after UI edits: cd App/ui && npm run build):
#   http://127.0.0.1:8765/App/ui/dist/index.html
# React live dev (API still on 8765): cd App/ui && npm run dev → http://127.0.0.1:5173
# SQLite catalog editor (instance-admin only): http://127.0.0.1:8765/App/data-db-editor.html
```

Activate the venv in each new terminal before running Python tools (`dev_server.py`, etc.).

## Query composer (`App/composer/`)

The QUERY package composer builds Neo4j Cypher and SQLite statements from declarative query objects. It lives in [`App/composer/`](App/composer/) as a standalone ES module package (`@pona-flow/composer`), imported by the React UI via Vite.

```bash
cd App/ui
npm run test:composer    # run composer characterization + golden tests
npm run typecheck:composer
```

Composer tests live in [`tests/`](tests/) and import via [`tests/helpers/composer.mjs`](tests/helpers/composer.mjs).

## Regex validator (`App/regex-validator/`)

Validates SCHEMA property default values against patterns from the catalog `regex` table. Package: `@pona-flow/regex-validator`.

```bash
cd App/ui
npm run test:validator
npm run typecheck:validator
```

## API connector (`App/connector/`)

HTTP client for the dev-server JSON API (spaces, graph checks, package execution). Package: `@pona-flow/connector`.

```bash
cd App/ui
npm run test:connector
npm run typecheck:connector
```

## Development server (`Engine/dev_server.py`)

The dev server is a local HTTP process for browser-based tools under `App/`. It is **not** a production deployment stack. It serves static HTML/JS and JSON APIs that read and write the **catalog** SQLite file (typically `data.db`) and, for a selected **space**, that space’s Neo4j graph and per-space SQLite database.

| Module | Role |
|--------|------|
| [`Engine/dev_server.py`](Engine/dev_server.py) | Entry point: load `.env`, bind `FORM_BRIDGE_HOST` / `FORM_BRIDGE_PORT` (default `127.0.0.1:8765`), start uvicorn serving the FastAPI app. |
| [`Engine/server/config.py`](Engine/server/config.py) | Project paths (`ROOT`, `App/`), `.env` loading, catalog DB path resolution, SQLite connections. |
| [`Engine/server/id_generator.py`](Engine/server/id_generator.py) | `ID_<uuid>` entity id generation (`GET /api/generate-id`). CLI: `python Engine/server/id_generator.py`. |
| [`Engine/server/spaces.py`](Engine/server/spaces.py) | `spaces` table: list environments, resolve each row’s `*_key` columns to real Neo4j/SQLite settings in `.env`. |
| [`Engine/server/graph.py`](Engine/server/graph.py) | Neo4j: run Cypher, check global `id` / `attributive_label` uniqueness, list nodes for form pickers. Requires `pip install neo4j`. |
| [`Engine/server/catalog.py`](Engine/server/catalog.py) | Catalog DB: table metadata and row CRUD (`/api/db/*`), `queries` upsert, `regex` auto-migration, saved query list. |
| [`Engine/server/packages.py`](Engine/server/packages.py) | `POST /api/execute-create`: run composed Cypher + per-space SQLite + optional catalog `queries` upsert. |
| [`Engine/server/auth.py`](Engine/server/auth.py) | Clerk JWT verification and space-membership authorization (FastAPI dependencies). |
| [`Engine/server/migrations.py`](Engine/server/migrations.py) | Deterministic, ordered catalog schema application at startup. |
| [`Engine/server/sequence_service.py`](Engine/server/sequence_service.py) | Transport-agnostic run primitive (`run_sequence_once`, `list_runnable_sequences`) shared by the webhook and MCP gateway. |
| [`Engine/server/agent_keys.py`](Engine/server/agent_keys.py) | Agent API keys: mint/verify/revoke (`stg_` tokens, stored as SHA-256 hashes) for non-Clerk principals. |
| [`Engine/server/mcp_gateway.py`](Engine/server/mcp_gateway.py) | Per-space Model Context Protocol server (Streamable HTTP); exposes sequences as agent-callable tools. |
| [`Engine/server/execution_run.py`](Engine/server/execution_run.py) | Sequence executor: walk STEPs, pause for required parameters, run a query / HTTP call / sandboxed script, bind response parameters. |
| [`Engine/server/embeddings.py`](Engine/server/embeddings.py) | Local vector search: Ollama embeddings, Neo4j vector indexes, reindex, and `resolve_search_params` before a vector-search Cypher statement runs. |
| [`Engine/server/app.py`](Engine/server/app.py) | FastAPI routing, authenticated JSON API, static files under `/App/`. |

Code-execution STEPs are **not** run inside this process. The engine POSTs `{language, code, timeout_seconds, space_id}` to a separate sandbox runner (`Engine/runner/`, default `127.0.0.1:8766`). See [Engine/runner/README.md](Engine/runner/README.md).

Each module file includes a longer module docstring describing logic and how it fits the project.

## Agents: sequence webhooks & MCP gateway

Sequences can be run by **agents** (AI tools, external systems) as well as people. Two
agent-facing surfaces share one underlying run primitive (`Engine/server/sequence_service.py`):

- **Webhook** — `POST /api/spaces/{space_id}/sequences/{sequence_id}/run` composes and runs a
  sequence in one call, returning either the final result or a `pending` payload listing the
  parameters it still needs (human-in-the-loop), with a `state_id` to resume. Discovery:
  `GET /api/spaces/{space_id}/sequences`. See [Docs/SEQUENCE-WEBHOOKS.md](Docs/SEQUENCE-WEBHOOKS.md).
- **MCP gateway** — each space is served as a Model Context Protocol server at
  `/api/spaces/{space_id}/mcp` (Streamable HTTP, stateless), exposing the space's runnable
  sequences as MCP tools. Connect any MCP client (Claude, IDE assistants, agents) with an
  agent key. See [Docs/MCP-GATEWAY.md](Docs/MCP-GATEWAY.md).

Both authenticate with either a Clerk session (humans) or a per-space **agent API key**
(`X-Pona-Flow-Key: stg_...`, or a Bearer token). Agent keys are managed in the **Agents**
tab of a space's settings (which also shows the MCP URL and webhook base), or via
`/api/spaces/{space_id}/agent-keys`. A key maps to an `agent` principal whose space role
governs which sequences it may run, reusing the existing RBAC allowlist. The MCP gateway
requires the optional `mcp` dependency (in `requirements.txt`); without it the gateway is
inert and the rest of the API is unaffected. Architecture: [Docs/DECISIONS.md](Docs/DECISIONS.md)
(D8, D9).

## Design Philosophy

Graph databases are the ideal substrate for context engineering due to their capacity to represent diverse patterns of information. In the pona flow system we identify and group these patterns into three main categories: 

- **Sequencial**: Conditional, branching, and looping operations
- **Schematic**: Hierarchical taxonomies or heterarchical ontologies
- **Spatial**: Actual data implementations of schematic patterns

While graph databases provide several key advantages over traditional approaches, a relevant limitation is their capacity for querying nested datasets and arrays. To overcome this constraint, the pona flow system uses a blended approach, where entities exhibit both graph and SQLite-based components.

By constraining the method of performing CRUD operations on these dual graph entities, the pona flow system facilitates a shared environment for maintaing state, memory, tools, protocols, and the broader context of an agent's working environment. This approach makes controlling and reasoning upon an agent's output scalable as the quantity and complexity of factors grow. 

Possible applications include but are not limited to:

- Content management systems (CMS)
- Customer relationship management (CRM)
- Agency/Project management systems (AMS)
- Personal/Institutional knowledge management (PKM)
- Decision support systems (DSS)

## Data Structure

### The Graph Ontology

At the highest level of abstraction pona flow implements a minimalist ontology consisting of only three types of nodes and only one type of relationship. Nodes are only connected to others of the same type and correspond with the three categories of graph patterns (sequencial, schematic, and instantial).

- (STEP)-[POINTS_TO]->(STEP)
- (SCHEMA)-[POINTS_TO]->(SCHEMA)
- (INSTANCE)-[POINTS_TO]->(INSTANCE)

| Label | What it is |
| --- | --- |
| **SCHEMA** | A property contract: which keys exist, their types, which are required or unique. An INSTANCE of that type must satisfy it. |
| **INSTANCE** | One record that satisfies a SCHEMA. This is the data a sequence reads, writes, and (optionally) vector-searches. |
| **STEP** | An executable unit. A sequence is a chain of STEPs linked by `POINTS_TO`. |

A **sequence** is a saved, runnable entry point that names the STEP the run starts at. At run time the executor walks outgoing `POINTS_TO` edges. An edge may be unconditional, or gated on a parameter (optionally compared to an expected boolean, which is how two sibling edges branch).

Saving a catalog operation auto-wraps it in a STEP node. A STEP that does not wrap an operation is a custom step: an outbound HTTP call, or a sandboxed script. Build order matters — operations (and their wrapping STEPs) first, then transitions, then the sequence. A sequence created before its STEPs exist matches nothing and runs as a no-op.

### STEPs

Every STEP is one of three kinds. The executor (`Engine/server/execution_run.py`) picks the runner from the step payload: a `query_id` runs a saved operation; `kind: "code"` runs a script; an `endpoint` URL runs an HTTP request.

| Kind | How it is authored | What runs |
| --- | --- | --- |
| **Saved operation** | QUERY builder (create / read / update / delete on STEP, SCHEMA, or INSTANCE). Save wraps a STEP that stores the catalog `query_id`. | The stored Cypher (and any SQLite) against the space's Neo4j / per-space SQLite. Parameters declared on the catalog row are supplied by the sequence; required ones pause the run as `pending` until a human or an upstream step fills them. |
| **HTTP (custom endpoint)** | STEP create with an endpoint URL, method, headers, and JSON body. Body fields may contain `$parameter` tokens; headers and body may contain `$secret.NAME` tokens resolved from the space credential store at request time. | An outbound HTTP request. Loopback, link-local, and other non-public addresses are blocked (D7) — HTTP STEPs cannot call Ollama, the runner, or the engine itself. |
| **Code (sandboxed)** | STEP create with `step_type: "code"`, a language (`python` or `javascript`), and a script stored as a catalog resource. `$parameter` tokens in the script are substituted before the run. | The engine never executes the script. It POSTs the payload to the sandbox runner, which starts a disposable Docker container (`--network none`, non-root, memory/CPU/PID caps, 30s wall clock). JSON output can be mapped into downstream parameters via `response_parameters`. Setup: [Engine/runner/README.md](Engine/runner/README.md). |

`response_parameters` on an HTTP or code STEP map a JSON path in the result onto a parameter name so a later STEP (or a condition on a `POINTS_TO` edge) can use it. That is how an HTTP or code step can populate `$searchTerm` for a downstream vector-search read.

Sequences are run from the dashboard, from `POST /api/spaces/{space_id}/sequences/{sequence_id}/run`, or as MCP tools. All three share `Engine/server/sequence_service.py`.

### Vector search

Local nearest-neighbour search over opted-in INSTANCE records. There is no sidecar vector database: Ollama embeds the text, Neo4j stores the vector on the node (and on INSTANCE-to-INSTANCE `POINTS_TO` edges), and a hit *is* the record.

A SCHEMA opts in with `is_vectorized`; individual properties opt in with `is_embedded` (the display-label property is the default). Reindex writes the vectors. Walkthrough: [Docs/VECTORIZATION-SETUP.md](Docs/VECTORIZATION-SETUP.md). Design notes: [Docs/VECTORIZATION-VISION.md](Docs/VECTORIZATION-VISION.md).

In the QUERY builder, a **read INSTANCE** can flip `vector_search` on. That replaces the MATCH with `CALL db.index.vector.queryNodes(...)`, filters on the selected `attributive_label` (unless **Search all types** is on), and returns the node plus a `score`. Two author-facing inputs:

| Field | Literal | Parameter |
| --- | --- | --- |
| **Search text** | Embedded at run time; declared on the catalog row as `vector_query_text` so a sequence can override it. | Exactly `$searchTerm` (the whole field) declares a parameter of that name. The catalog row is tagged `vector_role: "text"` so the engine knows which value to embed. |
| **k** (top results, 1–100) | Declared as `vector_k`. Composed Cypher is `LIMIT $vector_k`. | Exactly `$topK` declares that parameter (`vector_role: "k"`). Composed Cypher is `LIMIT $topK`. Range-checked at run time, not while authoring. |

Author-named parameters are what let two vector searches coexist in one sequence — under the reserved names they would both read the same `vector_query_text`. Once either field is parameterized the builder **Run** button hides (there is no value until a sequence supplies one); save the operation and drive it from a sequence.

The engine fills `$vector_query` (the embedding), `$vector_index`, and `$vector_overfetch` immediately before Cypher runs. Those names are reserved; they are never sent by the client. Ollama is reached only from `Engine/server/embeddings.py` — HTTP STEPs cannot call it.

### The SQLite Database Structure

#### Entities

The entities table within the SQLite database (located at `data.db`) stores a mapping of node/relationship IDs for entities to their properties stored as a JSON payload (for sequencial and schematic entities) and also includes datestamps for the creation data and last modified date. Apply the DDL with `sqlite3 data.db < Engine/schema/entities-table.sql` on new databases; existing `data.db` files are migrated automatically (rename `label` → `node_label`, add `common_label`) when the dev server opens a space or the catalog DB.

On **create**, `common_label` is set as follows: for `node_label` `STEP` or `SCHEMA`, it equals `attributive_label`; for `INSTANCE`, it equals the value of whichever property has `is_label` true in the schema.

| id          | node_label | common_label | payload                                                                                                              | creation_date               | modified_date               |
| ----------- | ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------- |
| UID         | string     | string       | JSON                                                                                                                 | ISO 8601                    | ISO 8601                    |
| `e3kg5mg34` | `INSTANCE` | `Acme Corp`  | `{ "properties": { "name": "Acme Corp", "tax_id": "12-345" } }`                                                    | `2026-04-30T11:53:24-04:00` | `2026-04-30T11:53:24-04:00` |


#### Spaces

A "space" refers to a working environment within the pona flow system. It may optionally be associated with a primary webhook endpoint, an array of specific entities identified by their label property, an array of keys used for authentication, and the names of environment-variable keys (in `.env`) used to connect to that space's Neo4j database. Each space has a unique name and ID, however spaces may share webhook endpoints or entities.

The spaces table within the SQLite database (located at `data.db`) stores all space data mapped to thier IDs. The `neo4j_uri_key`, `neo4j_user_key`, `neo4j_password_key`, and `sqlite_database_path_key` columns store the **names** of keys in the `.env` file (not the secret values themselves); the runtime resolves those names to load the Neo4j and SQLite connections for the space. New spaces get prefixed key names derived from their name (e.g. a space named `New Space` uses `NEW_SPACE_NEO4J_URI`). When a space's prefixed key is not present in the `.env` file, the runtime falls back to the shared default key (`NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `SQLITE_DATABASE_PATH`), so you only need to define a space-specific key when you want to override the default. Below is a table that demonstrates the column labels with the expected types and examples:


| id          | name       | endpoint                                               | labels                                              | keys                                                    | neo4j_uri_key | neo4j_user_key | neo4j_password_key | sqlite_database_path_key | creation_date               |
| ----------- | ---------- | ------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------- | ------------- | -------------- | ------------------ | ------------------------ | --------------------------- |
| UID         | string     | URL or null                                            | JSON                                                | JSON                                                    | string        | string         | string             | string                   | ISO 8601                    |
| `primary`   | `primary`  | null                                                   | `{"labels":["create","read","update","delete"]}`    | `{"keys":["SUPER_ADMIN", "ADMIN", "CLIENT"]}`           | `NEO4J_URI`   | `NEO4J_USER`   | `NEO4J_PASSWORD`   | `SQLITE_DATABASE_PATH`   | `2026-05-18T00:53:54Z`      |
| `e3kg5mg34` | `Personal` | `https://hooks.example.com/webhook/instances/a1b2c3d4` | `{"labels":["person", "place", "event"]}`           | `{"keys":["n8k4m2p9qx", "w7v3y1z6rt", …]}`              | `NEO4J_URI`   | `NEO4J_USER`   | `NEO4J_PASSWORD`   | `SQLITE_DATABASE_PATH`   | `2026-04-30T11:53:24-04:00` |

#### Queries

The `queries` table stores persisted CRUD / QUERY executor packages: Cypher statements, SQLite statements, and parameter definitions as JSON **arrays** in `TEXT` columns (same shapes as `cypher`, `sqlite`, and `parameters` on CRUD package v2 in `Engine/QUERY-package.schema.json`). Policy columns control STEP authoring/runtime access: `kind` (`system`/`user`), `operation` (`create`/`read`/`update`/`delete`), `runtime_enabled` (`0`/`1`), and `author_selectable` (`0`/`1`). Apply the DDL with `sqlite3 data.db < Engine/schema/queries-table.sql` on new databases; existing `data.db` files are migrated automatically when the dev server reads or upserts catalog queries. To seed starter system primitives, run `sqlite3 data.db < Engine/schema/queries-seed-system.sql` (includes concrete STEP, SCHEMA, and INSTANCE starter implementations, plus validator-friendly INSTANCE parameter contracts using schema attributive labels and serialized properties payloads).

| id          | name               | kind              | operation            | runtime_enabled | author_selectable | cypher                       | sqlite                       | parameters                    |
| ----------- | ------------------ | ----------------- | -------------------- | --------------- | ----------------- | ---------------------------- | ---------------------------- | ----------------------------- |
| UID         | string             | `system` or `user`| `create/read/update/delete` | 0 or 1          | 0 or 1            | JSON array of Cypher strings | JSON array of SQLite strings | JSON array of parameter objects |
| `a1b2c3d4`  | `create_step_node` | `system`          | `create`             | `1`             | `1`               | `["CREATE (n:STEP {id: $id}) RETURN n"]` | `["INSERT INTO entities (id, node_label, common_label, payload, ...) VALUES (...)"]` | `[{ "name": "id", "type": "string", "location": "id" }]` |

#### State

The `state` table stores persisted EXECUTION packages (JSON matching `Docs/EXECUTION-package.schema.json`), a lifecycle status, and an optional run start timestamp. Apply the DDL with `sqlite3 data.db < Engine/schema/state-table.sql` on new databases; the dev server also creates this table automatically on first catalog access if it is missing.

| id  | package                         | status                                      | run_start_date              |
| --- | ------------------------------- | ------------------------------------------- | --------------------------- |
| UID | JSON EXECUTION package object   | `active`, `pending`, or `inactive`          | ISO 8601 (null until run)   |

#### Regex

The `regex` table stores named validation patterns for SCHEMA property `format` when `data_type` is `string`. The React QUERY builder loads rows into the format dropdown (by `name`) and uses [`App/regex-validator/`](App/regex-validator/) to test default values against the `regex` column. The special row `any` uses an empty pattern and skips format validation. Apply the DDL and seed data with `sqlite3 data.db < Engine/schema/regex-table.sql` on new databases; the dev server also creates and seeds this table automatically on first catalog access if it is missing.

| name   | regex                                      |
| ------ | ------------------------------------------ |
| string | JavaScript `RegExp` source (may be empty)  |
| `any`  | (empty — no format validation)             |
| `email`| `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$` |
| `phone`| `^\+?[\d\s().-]{7,20}$`                    |
| `point`| `^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$`      |
| `URL`  | `^https?://[^\s/$.?#][^\s]*$`              |
| `ZIP`  | `^\d{5}(-\d{4})?$`                         |
| `color`| `^(#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6}|[a-zA-Z]+)$` |

Users can add patterns from the form via **+ ADD PATTERN** (inserts a new row through `/api/db/rows`) or edit rows in the SQLite CRUD editor.

#### Schedules
The schedule table holds data pertaining to custom trigger events for workflow execution. Each row’s `payload` matches the object accepted under `temporal_properties` in the CRUD package schema (`Engine/CRUD-package.schema.json`, `$defs/temporalProperties`). Below is a table that demonstrates the column labels with the expected types and examples:


| space_id    | id          | label              | payload                                                                                                              | creation_date               | modified_date               |
| ----------- | ----------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------- |
| UID         | UID         | string             | JSON                                                                                                                 | ISO 8601                    | ISO 8601                    |
| `s8hm2nq74` | `e3kg5mg34` | `daily_digest_9am` | `{ "date": [], "time": ["T09:00:00Z"], "datetime": [], "weekday": ["1", "2", "3", "4", "5"], "day": [], "month": [], "year": [] }` | `2026-04-30T11:53:24-04:00` | `2026-05-01T08:12:03-04:00` |
