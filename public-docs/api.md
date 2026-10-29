# Integrating with the pona flow API

This guide is the HTTP contract for a pona flow instance. It covers how to authenticate, how to run a saved sequence, how to connect the runtime MCP gateway, and the endpoints the **authoring MCP** (`pona-flow-authoring`) calls when it creates schemas, steps, and sequences.

The base URL is the origin of your instance. A local engine listens at `http://127.0.0.1:8765`. Every path below is relative to that origin.

```bash
export BASE=http://127.0.0.1:8765
```

## 1. The model

A **space** is one environment: its own graph and its own records. Space ids are the normalized space name (uppercase, such as `MARKETING`).

Three node kinds share one relationship type, `POINTS_TO`, and each kind only links to itself:

| Kind | What it is |
| --- | --- |
| `SCHEMA` | A property contract: which keys exist, their types, and which are required or unique. |
| `INSTANCE` | One record that satisfies a SCHEMA. |
| `STEP` | An executable unit: a saved query, an HTTP call, a wait, a join, or an operation. |

An **operation** is a saved catalog package (`kind: "operation"`). Saving one wraps it in a STEP node. A **sequence** is a saved entry point (`kind: "sequence"`) that names the STEP a run starts at and, when the chain continues, walks outgoing `POINTS_TO` edges. One-step sequences are still sequences.

`attributive_label` is the stable name of a node or of a SCHEMA relationship type. Within a space it is unique across STEP nodes, SCHEMA nodes, and SCHEMA relationship types. STEP-to-STEP edges are the exception: they may all use the reusable label `next`.

The authoring MCP normalizes labels and schema property keys before it composes a package: lowercase, spaces become underscores, other characters are dropped. `Email Address` is stored as `email_address`. Direct HTTP callers send those strings already composed into `cypher` and `sqlite`.

## 2. Conventions

Requests and responses are JSON. Send `Content-Type: application/json` on every body.

A failed call returns:

```json
{ "error": "space_id is required" }
```

| Status | Meaning |
| --- | --- |
| `400` | The body or query string is invalid. `error` is the reason. |
| `401` | Missing or rejected credentials. |
| `403` | Authenticated, and the role does not allow this action in this space. |
| `404` | The id or ingest token does not exist. |
| `409` | First-run setup was requested after an account already exists. |
| `429` | Local sign-in is throttled. `Retry-After` is set. |
| `500` | The engine or the graph failed while handling a valid request. |
| `503` | A vector-search read could not embed its query text. |

Entity ids are `ID_` plus 32 hex characters. Mint one with:

```http
GET /api/generate-id
```

```json
{ "id": "ID_bc13b4c5893a4aa3927b1d59eb4123c2" }
```

`GET /healthz` is unauthenticated. It returns `{"status":"ok","auth_mode":"local","checks":{"catalog":{"ok":true}}}` when the catalog database answers. `GET /healthz?deep=1` also checks Neo4j and returns `503` with `"status": "degraded"` when a check fails.

## 3. Authentication

Two credentials exist. They are accepted on different routes.

### 3.1 Human session

Authoring routes (catalog writes, graph reads used while authoring, package execution, schema and step deletion) authenticate a human session.

**Local accounts** (`PONA_FLOW_AUTH_MODE=local`, the default). Sign in and keep the cookie:

```bash
curl -sS -c "$HOME/.pona-flow-cookies" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"…"}' \
  "$BASE/api/auth/login"
```

The response body is the account (`principal_id`, `email`, `display_name`, `is_superadmin`, …). The session token is the `pona_session` cookie, and its value starts with `pfs_`. Later calls can send the cookie jar, or the same value as a bearer token:

```http
Authorization: Bearer pfs_…
```

Cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` from a browser must be same-origin. A client that sends no `Origin` and no `Sec-Fetch-Site` header (curl, a server) is accepted.

`GET /api/auth/status` needs no credentials. It reports `mode` (`local` or `clerk`), whether first-run `setup_required` is still true, and `open_signup`. On a fresh instance, `POST /api/auth/setup` with `email`, `password`, and optional `display_name` creates the instance admin and sets the same cookie. That route answers `409` once an account exists.

**Clerk mode.** Send the Clerk session JWT:

```http
Authorization: Bearer <clerk-session-jwt>
```

`POST /api/auth/login` answers `404` in Clerk mode.

### 3.2 Agent API key

Sequence discovery, sequence runs, and the runtime MCP gateway accept an agent key. Present it as either header:

```http
X-Pona-Flow-Key: stg_…
```

```http
Authorization: Bearer stg_…
```

A token that starts with `stg_` is an agent key. A token that starts with `pfs_` is a local session. Any other bearer value is treated as a Clerk JWT on routes that accept a human session.

Minting and listing keys require a human session for someone who can manage the space (the seeded Admin role). The plaintext token is returned once; only its SHA-256 hash is stored.

```bash
curl -sS -b "$HOME/.pona-flow-cookies" \
  -H "Content-Type: application/json" \
  -d '{"name":"orders-bot"}' \
  "$BASE/api/spaces/$SPACE_ID/agent-keys"
```

```json
{
  "id": "ID_…",
  "space_id": "MARKETING",
  "principal_id": "ID_…",
  "name": "orders-bot",
  "token": "stg_…",
  "role_id": "ID_…"
}
```

Omit `role_id` and the key receives the space's **Member** role: read STEP, SCHEMA, and INSTANCE, and run every sequence. Pass `role_id` to use a role whose `sequences` list names only the sequences that key may run. The seeded **Admin** role includes every flow and can manage the space.

```bash
curl -sS -b "$HOME/.pona-flow-cookies" \
  "$BASE/api/spaces/$SPACE_ID/agent-keys"

curl -sS -b "$HOME/.pona-flow-cookies" \
  -X DELETE "$BASE/api/spaces/$SPACE_ID/agent-keys/$KEY_ID"
```

The create response includes `role_id`. A later list returns `id`, `space_id`, `principal_id`, `name`, `last_used_date`, `revoked`, and `creation_date`, and never the token. Revoke is idempotent.

### 3.3 Which credential reaches which route

| Surface | Credential |
| --- | --- |
| Authoring routes in [section 7](#7-authoring-http-api) | Human session (`pona_session` / `Bearer pfs_…`, or a Clerk JWT) |
| `GET /api/spaces/{space_id}/sequences` and `POST …/run` | Agent key or human session |
| `POST /api/spaces/{space_id}/mcp` | Agent key or human session |
| `GET` and `POST` and `DELETE` `…/agent-keys` | Human session, and manage-space permission |
| `POST /api/hooks/{ingest_token}` | The unguessable token in the path. No session and no agent key |

The authoring MCP is a local stdio process (`App/mcp`). It sends `X-Pona-Flow-Key` from `PONA_FLOW_KEY` on every HTTP call. Authoring routes read a human session and do not accept that header. A client that sends only an agent key receives `401` and `{"error":"Not signed in."}` on those routes.

For local development the engine can skip authentication when `PONA_FLOW_DISABLE_AUTH=1` (or `true` / `yes` / `on`) **and** the process is bound to loopback. The process refuses to start if that switch is set and the bind address is not loopback. With the switch on, authoring routes run as a local administrator and the agent-key header is unnecessary.

### 3.4 Permissions

After authentication, each space checks a flow of the form `<operation>:<element>`:

`create`, `read`, `update`, or `delete`, combined with `STEP`, `SCHEMA`, or `INSTANCE`.

Examples: `create:STEP`, `read:SCHEMA`, `delete:INSTANCE`. A sequence run is a separate allowlist (`sequences.all`, or an explicit list of sequence ids). Manage-space covers members, roles, and agent keys.

A `403` body names the missing permission, for example `You are not permitted to create STEP in this space.`

## 4. Run a sequence

These two routes are the integration used by external systems and by the runtime MCP gateway. Both accept an agent key or a human session. The response lists only sequences the caller may run.

### 4.1 Discover

```bash
curl -sS "$BASE/api/spaces/$SPACE_ID/sequences" \
  -H "X-Pona-Flow-Key: $STG_KEY"
```

```json
{
  "space_id": "MARKETING",
  "sequences": [
    {
      "id": "ID_seq_onboard",
      "name": "Onboard customer",
      "group_title": "Customer ops",
      "description": "Create the customer and send the welcome note.",
      "parameters": [
        { "name": "customer_email", "is_required": true, "value_type": "string" }
      ]
    }
  ]
}
```

A sequence appears when it is a sequence, runtime-enabled, triggerable, and not suspended. `parameters` is the set of inputs the caller still has to supply. Names already filled by an earlier step, generated ids, and values baked into the sequence at authoring time are omitted. Each object includes `name`, `is_required`, and `value_type` (`string`, `number`, `integer`, `boolean`, `array`, `UID`, `radio`, `checkbox`). String parameters may include `format`. Choice parameters may include `options`, `min_choices`, and `max_choices`. `default_value` is an author-supplied fallback.

A sequence whose graph cannot be composed is still listed, with `"parameters": []`.

### 4.2 Run

```bash
curl -sS -X POST "$BASE/api/spaces/$SPACE_ID/sequences/$SEQUENCE_ID/run" \
  -H "X-Pona-Flow-Key: $STG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"params":{"customer_email":"ada@example.com"}}'
```

| Field | Type | Meaning |
| --- | --- | --- |
| `params` | object | Parameter name to value. Empty and `null` values are ignored. |
| `state_id` | string | Present only when resuming a paused run. |

The first call, with no `state_id`, composes the sequence and starts it. The body is one of these shapes.

**Paused for input** (`pending`). The run is waiting on the caller. Supply every required name in `parameters` and call the same URL again with `state_id`. Values already in `resolved` stay on the run.

```json
{
  "status": "pending",
  "state_id": "ID_state_…",
  "step_id": "ID_step_…",
  "parameters": [
    { "name": "approval_note", "is_required": true, "value_type": "string" }
  ],
  "resolved": { "customer_email": "ada@example.com" }
}
```

**Parked in the background** (`waiting`). A timer, an until-datetime, a catalog event, a loop delay, or an HTTP retry backoff is holding the run. It resumes without new parameters. `reason` is the wait kind. `wake_at` is set for a datetime wait. `event_id` is set when the run is waiting on an event.

```json
{
  "status": "waiting",
  "state_id": "ID_state_…",
  "reason": "duration",
  "wake_at": "2026-10-28T18:00:00Z"
}
```

Poll `GET /api/sequence/status?state_id=ID_state_…` (human session, and membership in the run's space) or call `run` again with the same `state_id` after the wait.

**Finished** (`inactive`):

```json
{
  "status": "inactive",
  "state_id": "ID_state_…",
  "resolved": { "customer_email": "ada@example.com", "order_id": "ID_…" },
  "executed": [{ "step_id": "ID_…", "query_id": "ID_…", "endpoint": "" }],
  "final_result": {}
}
```

**Failed:**

```json
{ "status": "error", "message": "state not found" }
```

`status: "error"` is an executor result with HTTP 200. Transport failures still use the `{"error": …}` envelope and a 4xx or 5xx status.

### 4.3 Resume

```bash
curl -sS -X POST "$BASE/api/spaces/$SPACE_ID/sequences/$SEQUENCE_ID/run" \
  -H "X-Pona-Flow-Key: $STG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state_id":"ID_state_…","params":{"approval_note":"Approved by ops"}}'
```

Repeat until `status` is `inactive` or `error`. The `state_id` must belong to this sequence.

### 4.4 Inspect and stop

These routes take a human session and space membership. When a sequence id is known, the caller must also be allowed to run that sequence.

| Method and path | Body or query | Result |
| --- | --- | --- |
| `GET /api/sequence/status?state_id=` | `state_id` required | The stored result when the run is `inactive` or `cancelled`. A `pending` or `waiting` payload otherwise. `404` when the state does not exist. |
| `GET /api/sequence/in-flight?space_id=` | `space_id` required | `{"space_id","runs":[…]}` for runs that have not finished. |
| `POST /api/sequence/stop` | `space_id`, and `state_id` or `sequence_id` | Cancels the matching run. |

## 5. Runtime MCP gateway

Each space is an MCP server at:

```text
POST /api/spaces/{space_id}/mcp
```

Transport is Streamable HTTP, stateless. Authenticate with the same agent key or human session as the sequence routes. A key is a member of one space; another space's URL returns `403`.

```json
{
  "mcpServers": {
    "pona-flow-marketing": {
      "url": "https://your-instance.example/api/spaces/MARKETING/mcp",
      "headers": { "X-Pona-Flow-Key": "stg_…" }
    }
  }
}
```

Tools are the sequences from [section 4.1](#41-discover). The tool `name` is the sequence id. The tool `title` is the sequence name. The sequence description is the tool description. The space description is the server `instructions`. Each tool's `inputSchema` lists the caller-facing parameters (all optional at the schema level, because a run can pause and ask again) plus `state_id` for resume. Names baked into the sequence are omitted.

Clients that speak JSON-RPC directly send `Accept: application/json, text/event-stream`.

```bash
curl -sS -X POST "$BASE/api/spaces/$SPACE_ID/mcp" \
  -H "X-Pona-Flow-Key: $STG_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

```bash
curl -sS -X POST "$BASE/api/spaces/$SPACE_ID/mcp" \
  -H "X-Pona-Flow-Key: $STG_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/call",
    "params":{
      "name":"ID_seq_onboard",
      "arguments":{"customer_email":"ada@example.com"}
    }
  }'
```

The tool result is a text block containing the same JSON as `POST …/run`: `pending`, `waiting`, `inactive`, or `error`. Resume by calling the same tool with `state_id` and the newly requested parameters. A `waiting` result is a background park; call again with the same `state_id` after the wait, and do not invent parameter values for it.

The gateway is mounted when the Python `mcp` package is installed. Without it, this path is absent and the rest of the API is unchanged.

This gateway **runs** sequences. The authoring MCP in [section 7](#7-authoring-http-api) **creates** them. They can be connected at the same time. They are different processes and different URLs.

## 6. Inbound event hooks

An external system that cannot hold a session or an agent key can POST to an event's ingest URL. The path token is the secret. An optional HMAC over the raw body uses the header `X-Pona-Signature`.

```http
POST /api/hooks/{ingest_token}
```

A matching, enabled event returns `200` and `{"status":"accepted", …}`. A payload that fails the event's filters returns `200` and `{"status":"ignored"}` so the sender keeps the hook. Unknown tokens are `404`. A bad signature is `401`. A disabled event is `403`.

```http
POST /api/hooks/{ingest_token}/test
```

uses the same token and signature check, stores the body for the event builder, and does not run sequences. Bodies larger than 256 KiB are rejected.

## 7. Authoring HTTP API

These routes are what the visual builder and the authoring MCP use to configure a space. They authenticate a **human session** ([section 3.1](#31-human-session)). Send `space_id` on every write so the flow check runs against that space.

The MCP does not ask a model to emit Cypher. It turns flat arguments into a package, then calls the routes below. A direct HTTP client sends the package the same way: arrays of Cypher strings, arrays of SQLite strings, parameter declarations, and a `builder_config` object. `builder_config` is the declarative snapshot the builder reopens. A row saved without it can still run; it cannot be edited back into the visual builder.

There is no single transaction across the catalog, the space's SQLite mirror, and the graph. The call order below is the order that leaves a runnable artifact when every call succeeds.

### 7.1 Build order

1. **Create each operation.** `POST /api/queries/upsert` saves the catalog package. `POST /api/execute-create` materializes the STEP (and, for a SCHEMA or INSTANCE package with execute semantics, the graph nodes). A catalog operation is wrapped in a STEP. A single new STEP is also published as a one-step sequence. A chain of STEPs is materialized only; the sequence is a later call.
2. **Link STEPs.** `POST /api/execute-create` writes each `POINTS_TO` edge. The STEP nodes must already exist. Edges are addressed by graph id; the MCP resolves `attributive_label` to that id with `GET /api/graph/nodes-by-label` first.
3. **Save the sequence.** `POST /api/queries/upsert` with `kind: "sequence"` stores the entry STEP and the walk. Optional `parameters` on the MCP's `create_sequence` tool become baked-in values on that sequence only. Bound names are omitted from [discovery](#41-discover) and do not pause the run. A caller can still override them in `params`.

A sequence saved before its STEP nodes exist matches nothing at run time. A transition cannot attach to a STEP that has not been created.

Saving a create-SCHEMA or create-INSTANCE package describes the nodes. They exist in the graph after `POST /api/execute-create`. A create-STEP package always materializes the designed STEP on that call.

### 7.2 Authoring MCP tools and the routes they call

`confirm_token` on `delete_step`, `delete_schema`, and `delete_operation` is issued by the MCP process. It is not an HTTP field. The HTTP delete executes only when the body contains `"confirm": true`. The MCP's first call hits the preview route and returns a token; the second call hits the execute route.

| MCP tool | HTTP calls |
| --- | --- |
| `list_spaces` | `GET /api/spaces` |
| `describe_space` | `GET /api/space/connections`, `GET /api/space/labels`, `GET /api/space/groups` |
| `list_operations` | `GET /api/queries` (the tool filters `kind` locally) |
| `get_operation` | `GET /api/queries/{id}` |
| `describe_sequence` | `GET /api/queries/{id}`, `POST /api/sequence/preview-parameters` |
| `list_step_nodes` | `GET /api/graph/nodes-by-label?node_label=STEP`, then `GET /api/graph/step-outgoing` per node |
| `list_schemas` | `GET /api/graph/nodes-by-label?node_label=SCHEMA` |
| `describe_schema` | `GET /api/schema/definition`, `GET /api/schema/outgoing` |
| `create_operation` | `GET /api/generate-id`; preflight checks in [section 7.6](#76-preflight-checks); `POST /api/queries/upsert`; `POST /api/execute-create` |
| `update_operation` | `GET /api/queries/{id}`; preflight; `POST /api/queries/upsert`; `POST /api/execute-create` when the wrap STEP must be rewritten |
| `create_step_transition` | preflight; `GET /api/graph/nodes-by-label`; `GET /api/generate-id`; `POST /api/execute-create` |
| `create_sequence` | `POST /api/sequence/preview-parameters`; `GET /api/generate-id`; `POST /api/queries/upsert` |
| `update_sequence` | `GET /api/queries/{id}`; `POST /api/sequence/preview-parameters`; `POST /api/queries/upsert` |
| `delete_step` | `POST /api/step/delete/preview`, then `POST /api/step/delete` |
| `delete_schema` | `POST /api/schema/delete/preview`, then `POST /api/schema/delete` |
| `delete_operation` | `GET /api/queries`. A sequence then uses `POST /api/sequence/delete`. An operation uses `POST /api/operation/delete/preview`, then `POST /api/operation/delete` |
| `repair_step_wraps` | `GET /api/queries`, `GET /api/graph/nodes-by-label?node_label=STEP`, `GET /api/graph/step-wrap-entity-id`. `apply=true` calls `POST /api/execute-create` to rewrite the wrap |

### 7.3 Spaces

`GET /api/spaces` returns the spaces the caller may see. Instance admins see every space. Everyone else sees spaces they belong to.

```json
{
  "catalog_sqlite_env_key": "CATALOG_SQLITE_PATH",
  "spaces": [
    {
      "id": "MARKETING",
      "name": "Marketing",
      "sort_date": "2026-10-28 16:00:00",
      "sqlite_database_path_key": "MARKETING_SQLITE_PATH"
    }
  ]
}
```

| Method and path | Query or body | Permission | Response |
| --- | --- | --- | --- |
| `GET /api/space/connections?space_id=` | `space_id` | space membership | `space_id`, `name`, `endpoint`, catalog env key, resolved SQLite `path`, Neo4j `uri` and `user`. The password is withheld; `neo4j.password_configured` is a boolean. |
| `GET /api/space/labels?space_id=` | `space_id` | space membership | `{"space_id","labels":["customer", …]}`. This is the registered label catalog, including reusable edge labels such as `next`. |
| `GET /api/space/groups?space_id=` | `space_id` | space membership | `groups` (sequences), `event_groups`, and `console_groups`, each a string array. |

`describe_space` is those three calls. Read the label list before choosing a new `attributive_label`.

### 7.4 Catalog packages

The catalog is instance-wide. `GET /api/queries` returns every saved package to any signed-in caller; it is not filtered by space. Filter on `kind` yourself the way `list_operations` does.

```json
{
  "catalog_sqlite_env_key": "CATALOG_SQLITE_PATH",
  "queries": [
    {
      "id": "ID_…",
      "name": "Create customer",
      "kind": "operation",
      "operation": "create",
      "runtime_enabled": 1,
      "author_selectable": 1,
      "group_title": "Fulfilment",
      "cypher": ["MATCH …"],
      "sort_order": 1,
      "description": "",
      "suspended": 0,
      "single_step": false
    }
  ]
}
```

`kind` is `operation`, `sequence`, `system`, or `user`. `operation` is `create`, `read`, `update`, or `delete`. `runtime_enabled`, `author_selectable`, and `suspended` are `0` or `1`. `single_step` is true when a sequence's Cypher matches one STEP and does not walk downstream.

`GET /api/queries/{query_id}` returns one package, or `404` with `{"error":"query not found"}`:

```json
{
  "id": "ID_…",
  "name": "Create customer",
  "cypher": ["CREATE …"],
  "sqlite": ["INSERT …"],
  "parameters": [{ "name": "customer_email", "data_type": "string", "value": "" }],
  "builder_config": {},
  "description": "",
  "loop_config": {},
  "group_title": "Fulfilment"
}
```

`builder_config` is `{}` when nothing was stored. `loop_config` is `{}` for a sequence that walks the graph once. A loop object is read by the executor and is separate from `builder_config`.

#### `POST /api/queries/upsert`

Permission, when `space_id` is present: `create:STEP`. Always send `space_id` on an authoring write. The catalog name of a sequence must be unique among sequences that share the space's graph.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Package id. Mint with `GET /api/generate-id`. |
| `name` | yes | Workspace title. For a new operation this also becomes the wrapping STEP label when that label is free. |
| `space_id` | for a permission check | Space the flow check and the nav group apply to. |
| `kind` | yes | `operation` or `sequence` (also `system` or `user`). |
| `operation` | yes | `create`, `read`, `update`, or `delete`. |
| `runtime_enabled` | yes | Boolean. A sequence must be runtime-enabled to appear in discovery. |
| `author_selectable` | yes | Boolean. Whether the package shows up as a building block. |
| `triggerable` | no | Boolean, default true. Discovery hides sequences with this off. |
| `group_title` | no | Nav group. Case-only variants collapse onto the existing title in that space. |
| `description` | no | Prose. Used as the runtime MCP tool description for a sequence. |
| `cypher` | yes | Array of Cypher strings. |
| `sqlite` | yes | Array of SQLite strings for the space's entity mirror. |
| `parameters` | yes | Array of parameter declarations (`name`, `data_type`, `value`). |
| `builder_config` | no | Declarative snapshot. Stored as JSON. Absent becomes `{}`. |
| `loop_config` | no | Sequence loop policy. Absent becomes `{}`. |

```json
{
  "id": "ID_…",
  "rowcount": 1
}
```

Re-saving an operation or a sequence can clear a suspension and returns that change as `suspension` when any flag flipped: `{"suspended":[{"id","name"}],"unsuspended":[{"id","name"}]}`.

On update, the catalog `name` always saves and stays aligned with the paired one-step sequence title. The wrap STEP's `attributive_label` changes only when the new name is free and no multi-step sequence matches the current wrap.

#### `POST /api/queries/{query_id}/description`

Body: `space_id`, `description`. Permission: space membership. Updates prose only, so a description edit cannot overwrite `cypher` or `builder_config`. Returns `{"id","description"}`.

#### `POST /api/sequence/preview-parameters`

Permission: `read:STEP`. When `sequence_id` is set, the caller must also be allowed to run that sequence.

```json
{
  "space_id": "MARKETING",
  "sequence_id": "ID_…",
  "entry_step": "",
  "traversal": "downstream"
}
```

`sequence_id` or `entry_step` is required. `traversal` is `downstream` (default) or `single`. `entry_step` is an `attributive_label` for a chain that is not saved yet.

```json
{
  "parameters": [
    { "name": "customer_email", "is_required": true, "value_type": "string" }
  ],
  "parameter_values": { "plan": "pro" },
  "parameter_steps": [[{ "name": "customer_email", "is_required": true, "value_type": "string" }]],
  "response_parameter_names": ["order_id"]
}
```

`parameters` are the STEP inputs a sequence may bake in (not auto-generated, not produced by an earlier response). `parameter_values` are values already stored on the sequence. `parameter_steps` is the same inputs grouped by step, which is how a run pauses one step at a time. `response_parameter_names` are names an earlier step writes, so a later step can read them.

`describe_sequence` returns the package from `GET /api/queries/{id}` plus this preview. `create_sequence` reads the preview so baked-in names match real STEP inputs.

#### `POST /api/sequence/delete`

Body: `space_id`, `id` (the sequence id). Permission: space membership. Removes the sequence's catalog row and its composed state packages. STEP nodes and their edges stay, so other sequences that share those STEPs keep working. This is what `delete_operation` does when the catalog row's `kind` is `sequence`.

### 7.5 Execute a package

#### `POST /api/execute-create`

Permission: `create:<element>`. The element is `node_label` when it is `STEP`, `SCHEMA`, or `INSTANCE`. Otherwise the engine reads the first `:STEP`, `:SCHEMA`, or `:INSTANCE` in `cypher`. If neither is present, the check is `create:STEP`. Send `node_label` explicitly.

| Field | Required | Meaning |
| --- | --- | --- |
| `space_id` | yes | Space whose graph and SQLite mirror are written. |
| `node_label` | recommended | `STEP`, `SCHEMA`, or `INSTANCE`. Selects the flow check. |
| `cypher` | yes | Array of Cypher strings. |
| `sqlite` | yes | Array of SQLite strings. |
| `cypher_params` | no | Object of parameter values for the Cypher. |
| `attributive_labels` | no | Labels this package claims. A label already held by another entity is rejected. |
| `attributive_label_owner_ids` | no | Entity ids this package writes. A label held only by these ids is a re-save, not a collision. |
| `catalog_labels` | no | Labels to register for pickers without a uniqueness claim. Reused STEP-to-STEP labels (`next`) go here. |
| `queries_catalog` | no | Optional catalog upsert performed as part of the same call: `id`, `name`, `kind`, `operation`, `runtime_enabled`, `author_selectable`, `cypher`, `sqlite`, `parameters`. |

```json
{
  "space_id": "MARKETING",
  "result": {
    "cypher": [{ "records": [], "summary": {} }],
    "sqlite": [{ "rowcount": 1 }],
    "queries_catalog": { "id": "ID_…", "rowcount": 1 },
    "space_labels": ["customer"]
  }
}
```

`queries_catalog` and `space_labels` are present only when that part of the call ran. A uniqueness failure is `400` and the body `error` explains which label collided.

`create_operation` uses this route to materialize SCHEMA nodes, INSTANCE nodes, STEP nodes, and the STEP that wraps a catalog query. `create_step_transition` uses it to write one `POINTS_TO` edge. `repair_step_wraps` with `apply=true` uses it to rewrite a wrap whose graph node and entity row disagree.

#### `POST /api/execute-query`

The authoring MCP's create and update tools do not call this route. It is the matching endpoint for a composed **read**, **update**, or **delete** package (the builder uses it to run a package immediately).

Permission: `<operation>:<element>` using the same `node_label` inference as execute-create, for `operation` of `read`, `update`, or `delete`.

Body: `space_id`, `operation`, `cypher`, `sqlite`, optional `cypher_params`, optional `parameters` (the catalog declarations, including `vector_role` when a read is a vector search), optional `node_label`.

```json
{
  "space_id": "MARKETING",
  "result": {
    "operation": "read",
    "cypher": [{ "records": [{ "id": "ID_…", "attributive_label": "ada" }] }],
    "sqlite": []
  }
}
```

A vector-search read returns `503` when the embedder is unavailable. The query text has to be embedded with the same model that built the index, so there is no partial answer.

### 7.6 Preflight checks

Before `create_operation`, `update_operation`, and `create_step_transition`, the authoring MCP calls `assertPreflightClear`, which GETs the checks below and refuses to write when one of them reports a collision. Call the same checks before a direct write.

All take `space_id` and return JSON. An empty probe returns `exists: false` and a `skipped` string instead of an error.

| Method and path | Query | Permission | Response |
| --- | --- | --- | --- |
| `GET /api/graph/attributive-label-exists` | `space_id`, `attributive_label`, optional `node_label`, optional `exclude_id` | space membership | `exists`. `exclude_id` ignores the entity the caller is re-saving. |
| `GET /api/graph/id-exists` | `space_id`, `id` | space membership | `exists` for that entity id. |
| `GET /api/graph/instance-property-exists` | `space_id`, `attributive_label`, `property_key`, `value`, optional `exclude_id` | `read:INSTANCE` | `exists` when an INSTANCE of that schema already holds that property value. Use this before writing a unique key such as an email. |

### 7.7 Graph reads

`node_label` for `nodes-by-label` is `STEP`, `SCHEMA`, or `INSTANCE`. Any other label returns an empty `nodes` array. `STEP`, `SCHEMA`, and `INSTANCE` also require the matching `read:<element>` flow.

| Method and path | Query | Permission | Response |
| --- | --- | --- | --- |
| `GET /api/graph/nodes-by-label` | `space_id`, `node_label`, optional `attributive_label` | `read` on that element | `nodes`: `{id, attributive_label}` plus, for STEP nodes, `sequencial_properties` and sometimes `parameters`. |
| `GET /api/graph/step-outgoing` | `space_id`, `attributive_label` | `read:STEP` | `edges` from that STEP. |
| `GET /api/graph/step-wrap-entity-id` | `space_id`, `operation_id` | space membership | `entity_id` of the STEP whose payload points at that operation, or `""`. |
| `GET /api/graph/step-relationships` | `space_id` | `read:STEP` | `relationships` between STEP nodes. |
| `GET /api/graph/schema-relationships` | `space_id` | `read:SCHEMA` | One representative edge per SCHEMA relationship type. |
| `GET /api/graph/relationships-by-label` | `space_id` | space membership | `POINTS_TO` relationships in the space. |
| `GET /api/graph/step-flow` | `space_id`, optional `query_id` | `read:STEP` | `step_graph`, plus `affected_query_ids` and `affected_step_labels` for packages drifted from their SCHEMA. |

A STEP node from `nodes-by-label` looks like this when it wraps a catalog query:

```json
{
  "id": "ID_step_…",
  "attributive_label": "create_customer",
  "sequencial_properties": { "query_id": "ID_op_…" }
}
```

An HTTP STEP returns `endpoint`, `method`, `headers`, `body`, `response_parameters`, and the call policy (`timeout_seconds`, `max_attempts`, `backoff_seconds`) inside `sequencial_properties`, plus a `parameters` array of the step's inputs. A wait STEP sets `step_type` to `wait` and `wait_mode` to `duration`, `until`, or `event`, with `wait_duration_seconds`, `wait_until`, or `wait_event_id`. A join STEP sets `step_type` to `join`. An operation STEP sets `step_type` to `operation` and includes `operation_evaluation` and `operation_assignments`.

An outgoing edge:

```json
{
  "rel_id": "ID_rel_…",
  "rel_attributive_label": "next",
  "target_id": "ID_step_…",
  "target_attributive_label": "notify_customer",
  "condition": "$approved",
  "condition_type": "parameter",
  "condition_expected": true
}
```

`condition` and `condition_type` are empty strings when the edge always follows. `condition_expected` is present for parameter conditions and is the boolean the condition must equal.

`list_step_nodes` is `nodes-by-label` for `STEP`, then `step-outgoing` for each `attributive_label`.

### 7.8 SCHEMA reads

| Method and path | Query | Permission | Response |
| --- | --- | --- | --- |
| `GET /api/schema/definition` | `space_id`, `attributive_label` | `read:SCHEMA` | `schema_id`, `attributive_label`, `schemata`, and `is_vectorized` when vector search is on for the type. |
| `GET /api/schema/outgoing` | `space_id`, `attributive_label`, optional `include_incoming=true` | `read:SCHEMA` | `edges` to other SCHEMA nodes. |
| `GET /api/schema/affected-operations` | `space_id`, `attributive_label` | `read:SCHEMA` | `operations`: create-INSTANCE packages in the catalog that target this SCHEMA. |

`describe_schema` calls definition and outgoing.

A property in `schemata`:

| Field | Meaning |
| --- | --- |
| `key` | Lowercase snake name. |
| `value_type` | `string`, `number`, `integer`, `boolean`, `array`, `UID`, `radio`, `checkbox`, or `attributive label`. |
| `is_required` | The property must be present. |
| `is_key` | Unique for this SCHEMA. |
| `is_label` | Display label for the record. |
| `is_indexed` | Indexed. |
| `is_embedded` | Included in the vector-search text when the SCHEMA is vectorized. |
| `format` | For strings: `any`, `email`, `phone`, `point`, `URL`, `ZIP`, `color`. |
| `default_value` | Applied when the property is required and the caller omits it. |
| `options`, `min_choices`, `max_choices` | Choice constraints for `radio` and `checkbox`. |

An outgoing SCHEMA edge includes `rel_id`, `rel_attributive_label`, `target_id`, `target_attributive_label`, `rel_schemata`, `target_schemata`, and `direction` (`outgoing`, or `incoming` when `include_incoming` is set). On an incoming edge, `target_*` names the node at the other end.

A missing SCHEMA label is `400` with an `error` that names the label.

### 7.9 Deletion

Deletes are two HTTP calls. Preview writes nothing. Execute requires `"confirm": true` and otherwise returns `400` with `confirm must be true…`.

| Preview | Execute | Permission | What is removed |
| --- | --- | --- | --- |
| `POST /api/step/delete/preview` | `POST /api/step/delete` | `delete:STEP` | The STEP, its edges, the operation it wraps, and sequences that run through it. |
| `POST /api/schema/delete/preview` | `POST /api/schema/delete` | `delete:SCHEMA` | The SCHEMA, its instances, and operations bound to it. |
| `POST /api/operation/delete/preview` | `POST /api/operation/delete` | `delete:STEP` | The operation, its wrap STEP, and one-step sequences. Multi-step sequences that match the wrap are suspended, not deleted. |

STEP and SCHEMA bodies:

```json
{ "space_id": "MARKETING", "attributive_label": "create_customer", "confirm": true }
```

Omit `confirm` on the preview. Operation bodies use `operation_id` or `sequence_id` (one of them is required) instead of `attributive_label`, plus `confirm` on execute.

A STEP or SCHEMA preview includes `warnings` (`[{code, message}]`), `summary` counts, `affected` records, and `requires_confirmation`. Read `warnings` before confirming: a schema delete can drop instances.

An operation preview:

```json
{
  "space_id": "MARKETING",
  "operation_id": "ID_…",
  "operation_name": "Create customer",
  "attributive_label": "create_customer",
  "requires_confirmation": true,
  "one_step_sequences": [{ "id": "ID_…", "name": "Create customer" }],
  "multi_step_sequences": [{ "id": "ID_…", "name": "Onboard customer" }],
  "summary": {
    "one_step_sequences": 1,
    "multi_step_sequences": 1,
    "execution_packages": 2
  }
}
```

An operation execute result lists `one_step_deleted` and `multi_step_suspended` as id arrays, plus `entities_deleted`, `catalog` (`queries_deleted`, `state_deleted`), and `graph` (`nodes_deleted`).

A STEP or SCHEMA execute result includes `purged`, `unlinked_labels`, `warnings`, and the same `entities_deleted`, `catalog`, and `graph` counts.

`delete_operation` on a **sequence** does not call the operation-delete routes. It calls `POST /api/sequence/delete`, which unlinks the sequence and leaves STEP nodes in place. The MCP still previews that effect locally before the second call.

### 7.10 Worked authoring calls

Sign in, pick a space, mint ids, then save. The `cypher` and `sqlite` arrays below are placeholders. Produce them with the same composer the authoring MCP uses, or start from a package returned by `GET /api/queries/{id}` and edit the snapshot in `builder_config` before re-saving.

```bash
curl -sS -c "$HOME/.pona-flow-cookies" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"…"}' \
  "$BASE/api/auth/login"

curl -sS -b "$HOME/.pona-flow-cookies" "$BASE/api/spaces"

OP_ID=$(curl -sS -b "$HOME/.pona-flow-cookies" "$BASE/api/generate-id" | jq -r .id)
STEP_ID=$(curl -sS -b "$HOME/.pona-flow-cookies" "$BASE/api/generate-id" | jq -r .id)
```

Save the catalog package, then materialize its STEP. Both calls are required. The upsert makes the package editable and listed; the execute makes the STEP exist so a sequence can match it.

```bash
curl -sS -b "$HOME/.pona-flow-cookies" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/api/queries/upsert" <<EOF
{
  "id": "$OP_ID",
  "name": "Create customer",
  "space_id": "$SPACE_ID",
  "kind": "operation",
  "operation": "create",
  "runtime_enabled": true,
  "author_selectable": true,
  "group_title": "Fulfilment",
  "description": "Mint a customer record.",
  "cypher": ["/* composed Cypher */"],
  "sqlite": ["/* composed SQLite */"],
  "parameters": [],
  "builder_config": { "query": { "id": "$OP_ID", "name": "Create customer" } }
}
EOF

curl -sS -b "$HOME/.pona-flow-cookies" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/api/execute-create" <<EOF
{
  "space_id": "$SPACE_ID",
  "node_label": "STEP",
  "cypher": ["/* Cypher that MERGEs the STEP and its entity */"],
  "sqlite": ["/* entity-mirror statements */"],
  "cypher_params": {},
  "attributive_labels": ["create_customer"],
  "attributive_label_owner_ids": ["$STEP_ID"]
}
EOF
```

Confirm the STEP is visible, then save a one-step sequence that starts there. A sequence id is another minted id.

```bash
curl -sS -b "$HOME/.pona-flow-cookies" \
  "$BASE/api/graph/nodes-by-label?space_id=$SPACE_ID&node_label=STEP"

SEQ_ID=$(curl -sS -b "$HOME/.pona-flow-cookies" "$BASE/api/generate-id" | jq -r .id)

curl -sS -b "$HOME/.pona-flow-cookies" \
  -H "Content-Type: application/json" \
  -d @- "$BASE/api/queries/upsert" <<EOF
{
  "id": "$SEQ_ID",
  "name": "Create customer",
  "space_id": "$SPACE_ID",
  "kind": "sequence",
  "operation": "read",
  "runtime_enabled": true,
  "author_selectable": false,
  "triggerable": true,
  "group_title": "Fulfilment",
  "description": "Create a customer record.",
  "cypher": ["/* MATCH the STEP create_customer */"],
  "sqlite": [],
  "parameters": [],
  "builder_config": {}
}
EOF
```

Run it with an agent key from [section 3.2](#32-agent-api-key):

```bash
curl -sS -X POST "$BASE/api/spaces/$SPACE_ID/sequences/$SEQ_ID/run" \
  -H "X-Pona-Flow-Key: $STG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"params":{}}'
```

To do the same work in conversation instead of composing packages, run the authoring MCP against this instance and let it call these routes. It still needs a human session on the authoring routes, or a loopback engine with authentication disabled, as described in [section 3.3](#33-which-credential-reaches-which-route).
