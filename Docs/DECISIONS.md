# Architecture & Product Decisions

A lightweight decision log (ADR-style) capturing the choices that shape pona flow's
move from a local dev tool toward a production, public-facing product. Newest decisions
go at the bottom of each section. Keep entries short; link to code where relevant.

---

## D1. Product & commercial model

**Decision:** pona flow is an **open-core** product. The core (this repository) is
open source. Revenue comes primarily from a **dedicated single-tenant instance
management service** (we provision, host, upgrade, and support an instance the client
owns the data for) plus consulting.

**Commercial-license (paid, closed) features** — explicitly *out of scope* for the
open-core production launch:

- SSO (SAML/enterprise IdP federation beyond the standard hosted login)
- Audit logging *product* (retention, export, search UI). Minimal operational request
  logging is fine in core.
- Enterprise / custom RBAC (role matrices, fine-grained per-sequence grants, custom roles)
- MCP gateway (exposing a space's sequences as agent-callable tools)

**Why:** Recurring revenue comes from managed hosting + support, not from license sales.
Single-tenant keeps the client's data theirs and sidesteps shared-tenant data-isolation
complexity. The paid features above are the classic, defensible open-core paywall.

---

## D2. Tenancy model

**Decision:** **Single-tenant-per-client.** Each client gets their own instance with its
own Neo4j and SQLite databases and its own secrets. There is no shared multi-tenant
database.

**Consequences:**

- We do **not** need cross-tenant data encryption or shared-DB secret isolation.
- Per-instance provisioning/upgrade automation matters (many instances to operate).
- Within one instance there can still be multiple **users** and multiple **spaces**;
  spaces remain the in-instance isolation boundary (see D5).

---

## D3. Authentication & edge (Clerk + Cloudflare)

**Decision:**

- **Identity / passwords are delegated to [Clerk](https://clerk.com).** We do not store
  passwords. The backend verifies Clerk-issued session JWTs (JWKS signature check) and
  maps the Clerk user (`sub`) to a local `users` row.
- **Cloudflare** sits in front of every instance and handles **TLS termination, CORS,
  and edge rate-limiting / WAF.** The application server is not exposed directly.

**Why:** Outsourcing credential storage removes a large security liability and gives us
enterprise-ready login primitives for free. Cloudflare gives TLS + DDoS/rate-limiting
without app-level work.

**Implications for the app:**

- The server trusts a verified Clerk JWT as the authentication signal; it does **not**
  implement its own password/session store.
- TLS/CORS are **not** implemented in the app (Cloudflare owns them). The app binds
  locally / on the private network behind the proxy.

---

## D4. Backend framework

**Decision:** Migrate the backend from the stdlib `http.server` (`BaseHTTPRequestHandler`)
to **FastAPI on ASGI (uvicorn)**.

**Why:** The original `handler.py` had no middleware, validation, or auth hook — every
route was an open `_serve_*` method. FastAPI gives dependency injection (clean place to
enforce auth + space membership), request validation, and a path to async/scaling. The
existing domain modules (`spaces`, `graph`, `catalog`, `packages`, `execution`) are
unchanged; FastAPI routers call them directly so API contracts stay stable.

---

## D5. Open-core permission model

**Decision:** For the open-core production launch the permission model is
**authentication + space ownership/membership only**:

- A user is either a **member of a space or not**. Members get **full access** to that
  space (read catalog, run sequences, mutate graph, edit). Non-members get nothing.
- The user who **creates** a space becomes its **owner** (a member with `is_owner = 1`).
- A separate **instance-admin** flag (`users.is_instance_admin`) gates instance-wide
  operations and the raw catalog DB editor (`/api/db/*`). The **first** authenticated
  user on a fresh instance is bootstrapped as instance admin.

**Out of scope (commercial, D1):** role matrices, viewer/runner/author tiers, per-sequence
grants, custom roles. The `users` + `space_members` tables are intentionally the
foundation those features will extend later.

---

## D6. Secrets & configuration

**Decision:** Keep the existing **env-key indirection** — `spaces` rows store the *names*
of `.env` keys (`neo4j_uri_key`, etc.), never the secret values. In production those
values are injected by the hosting platform's secret store / environment, not a committed
`.env` file. `.env` remains for local development only.

Required production environment variables are documented in `.env.example` and
`Docs/DEPLOYMENT.md`.

**Extension — user-managed credentials:** Space managers can store API keys / auth secrets
per space (Credentials tab). This reuses the env-key indirection: the catalog
`space_credentials` table stores only *metadata* (name, `env_key`, description), never the
value. A pluggable `CredentialStore` (`Engine/server/credentials.py`) holds the values, with
the backend chosen by `PONA_FLOW_CREDENTIAL_BACKEND`:

- `passthrough` (default) — read-only `os.environ`; the API can register a credential slot
  but values must be injected by the platform. Identical to prior behavior.
- `local` — read/write the project `.env` file (local development).
- `hosted` — reserved for a provider adapter behind the same protocol (currently read-only).

Workflows reference a credential as `$secret.<NAME>`; the executor resolves it from the
store only at request time and never persists or logs the value (see D7).

---

## D7. Sequence-execution safety (SSRF)

**Decision:** Sequence "endpoint" steps make outbound HTTP calls. In production these are
restricted to block private/loopback/link-local address ranges by default and (optionally)
constrained to an allowlist via `PONA_FLOW_OUTBOUND_ALLOWLIST`. This is a security control,
not a commercial feature.

---

## D8. Agent-callable sequence webhooks + dual authentication

**Decision:** Expose each sequence as an inbound webhook and let agents authenticate with
a per-space API key (alongside Clerk for humans), as the groundwork for the MCP gateway.

- **Webhook:** `POST /api/spaces/{space_id}/sequences/{sequence_id}/run` composes and runs
  a sequence in one call (or resumes a paused run when given a `state_id`), returning the
  executor's existing pending/inactive shape verbatim. `GET /api/spaces/{space_id}/sequences`
  is the discovery endpoint (runnable sequences + aggregated parameter schema). The
  human-in-the-loop `pending` response (a step's required `parameters`) is unchanged.
- **Shared primitive:** both the webhook and the future MCP server call
  `server.sequence_service` (`run_sequence_once`, `list_runnable_sequences`), which wraps
  `execution.compose_and_store` + `execution.run_execution`. The executor stays the single
  source of truth for the resumable state machine.
- **Dual auth:** `auth.current_principal_or_agent` accepts either a Clerk JWT or an `stg_`
  agent key (header `X-Pona-Flow-Key`, or a Bearer token). Agent keys live in the catalog
  `agent_keys` table, stored only as SHA-256 hashes; each maps to an agent principal
  (`users.principal_type = 'agent'`) with a `space_members` row, so authorization reuses
  the existing per-sequence RBAC allowlist (`auth.require_sequence_run`). Keys are managed
  by space managers via `/api/spaces/{space_id}/agent-keys`. The unused `spaces.keys` JSON
  column is left as-is (superseded by `agent_keys`).

**Why:** The compose/run + pending-parameters contract already matches an MCP tool call,
so the MCP gateway becomes a thin transport wrapper over `sequence_service` rather than new
domain logic.

---

## D9. MCP gateway (per-space Model Context Protocol server)

**Decision:** Serve each space's runnable sequences as MCP tools, mounted per space at
`/api/spaces/{space_id}/mcp`. Implemented in `server.mcp_gateway` as a thin transport
wrapper over the D8 primitives — it adds no new domain logic.

- **Transport:** the official `mcp` Python SDK over **Streamable HTTP** in **stateless**
  mode with JSON responses (each request independent — fits behind Cloudflare and multiple
  instances). The SDK's `StreamableHTTPSessionManager` is mounted into the existing FastAPI
  ASGI app and run via the app lifespan. The SDK is an optional dependency: if `mcp` is not
  installed, `mcp_gateway.MCP_AVAILABLE` is `False` and the mount/lifespan hooks are no-ops.
- **Tool mapping:** `tools/list` -> `sequence_service.list_runnable_sequences` filtered by
  the principal's RBAC sequence allowlist; each tool's `name` is the sequence id and its
  `inputSchema` is built from the aggregated parameters (all optional — see HITL below).
  `tools/call` -> `sequence_service.run_sequence_once` with `trigger="mcp"`.
- **Human-in-the-loop:** the executor's `pending` payload (required parameters + `state_id`)
  is returned as the tool result; the caller invokes the tool again with `state_id` (an
  always-present optional tool argument) to resume. This works with every MCP client without
  relying on elicitation.
- **Auth:** an ASGI wrapper authenticates before delegating to the protocol layer, reusing
  `auth.authenticate_request` (an `stg_` agent key or a Clerk JWT) and the
  space-membership gate. An agent key is scoped to one space, so a mismatched path space is
  rejected.
- **Transport security:** the SDK's DNS-rebinding/Host validation is disabled by default
  (Cloudflare validates Host; agent keys are the real gate). Set
  `PONA_FLOW_MCP_ALLOWED_HOSTS` (comma-separated) to enable strict Host validation.

Developer guide: `Docs/MCP-GATEWAY.md`.

**Commercial note (D1):** the MCP gateway is positioned as a paid/closed feature; it ships
in this repository but instances can leave the `mcp` dependency uninstalled to disable it.

---

## D10. External event triggers (generic inbound webhook receiver)

**Decision:** Extend the `events` model so an event of `type = 'external'` fires from an
**inbound HTTP POST** instead of the time scheduler. Each external event exposes a single
per-event ingest URL `POST /api/hooks/{ingest_token}` that any external system (Slack,
Zapier, an email->webhook gateway, ...) can call.

- **Generic receiver, not native connectors.** We ship one provider-agnostic receiver
  rather than first-class Slack/Gmail OAuth integrations. The token in the URL is the
  secret (high-entropy, minted server-side on first save); an optional per-event HMAC
  shared secret (`X-Pona-Signature`, SHA-256 of the raw body) adds payload integrity.
  Native connectors can layer on later by writing into the same dispatch path.
- **Reuses the execution seam (D8).** Matching/mapping live in `server.external_triggers`
  (the payload-side analogue of `server.triggers`); dispatch calls
  `sequence_service.run_sequence_once` with `trigger="external"`, so the run engine and the
  human-in-the-loop contract are unchanged. The audit-log trigger enum gains `external`.
- **Config shape.** Stored in a new additive `events.external_package` JSON column:
  `{ ingest_token, secret?, combinator, filters[], param_mappings[], parameters }`. Filters
  (`equals`/`contains`/`exists`/`regex` over dot/bracket JSON paths, AND/OR) decide whether
  a payload fires; `param_mappings` extract payload fields into named sequence parameters,
  layered over fixed `parameters`.
- **Unauthenticated by Clerk/agent key.** External callers cannot hold those credentials,
  so the route is open and defended by the URL token + optional HMAC. It is deliberately
  defensive (never 500 on a bad payload; returns `accepted`/`ignored` with 200) so a
  misbehaving provider does not get its hook auto-disabled.
- **Separate from the scheduler.** The scheduler still only evaluates `type = 'time'`
  events, so external events never participate in the timer loop or missed-fire recovery.

Developer guide: `Docs/EXTERNAL-EVENTS.md`.

---

## D11. MCP authoring gateway (agent-driven configuration)

**Decision:** Expose pona flow's *authoring* surface — SCHEMAs, INSTANCEs, STEP nodes,
transitions, sequences — as a second MCP server, implemented in Node at `App/mcp` and
launched over **stdio**. D9 serves a space's sequences as runnable tools; this serves the
surface that creates them.

- **Why not extend D9.** Authoring cannot be modelled as a sequence. Sequence steps execute
  Cypher only (`_execute_query_step` never reads a `sqlite` array, and
  `EXECUTION-package.schema.json` has no such field), while STEP/SCHEMA definitions live in
  the per-space SQLite `entities.payload`. A run also cannot write a catalog `queries` row by
  design (`catalog._is_queries_catalog_upsert_sql` strips those upserts). And composition is
  TypeScript-only. A Node process calling `POST /api/execute-create` clears all three.
- **Shared authoring package.** The builder's validation and save choreography moved out of
  the React app into `@pona-flow/authoring` (`App/authoring`), consumed by both the UI and
  the MCP server. `BuilderState` is replaced at that boundary by a narrow `AuthoringContext`
  (`spaceId`, `query`, `runtimeEnabled`, `matchPositions`), so the choreography runs headless
  in Node. `initialBuilderState` stays in the UI — it reads localStorage. This is what makes
  agent-authored and human-authored operations the same artifact, both editable in the
  visual builder via the stored `builder_config` snapshot.
- **Connector auth seam.** `@pona-flow/connector` gained `configure({ fetch, apiBase,
  headers })` and routes every call through one `requestJson` helper. The browser keeps
  injecting Clerk tokens by wrapping `window.fetch`; Node has no `window` and registers an
  `stg_` agent key header instead.
- **Server-side gates.** Validation that previously existed only in the browser is now also
  enforced in Python, because any client can call the API directly: `require_flow(create,
  STEP)` on `/api/queries/upsert`, and an attributive-label uniqueness preflight in
  `packages.execute_create_package`. The uniqueness check is ownership-aware — the request
  carries `attributive_label_owner_ids` so an entity re-saving its own label is not treated
  as a collision.
- **Intent-level tool arguments.** Tools take flat arguments and the server assembles the
  nested QueryObject, with a raw `query` escape hatch. Asking a model to emit a valid nested
  QueryObject in one shot is the main reliability risk, so the intent layer is load-bearing.
  Attributive labels and property keys are normalized to UPPER_SNAKE rather than rejected,
  mirroring the builder's live input normalization.
- **Two-phase deletes.** `delete_step`, `delete_schema`, and `delete_operation` return the
  `/preview` blast radius plus a single-use, target-bound confirmation token on the first
  call and write only on the second. Deletion cascades across three stores and an agent has
  no other way to know what it is about to remove.
- **No transaction across stores.** Saving one operation is several HTTP calls spanning the
  catalog database, per-space SQLite, and Neo4j. Partial failure leaves a STEP node without
  its entity row, so a `repair_step_wraps` tool detects and re-runs those wraps.

Developer guide: `Docs/MCP-AUTHORING.md`.

**Commercial note (D1, D9):** D9 positions the runtime MCP gateway as a paid/closed feature.
An authoring surface is a larger commercial question — it is the product's configuration
interface, not an integration point — and is recorded separately here rather than inheriting
D9's position. The server is a self-contained package (`App/mcp`) that an instance simply
does not launch to disable; `App/authoring` is a pure refactor of existing builder code and
carries no such question.

---

## Out-of-scope hooks (where commercial features will plug in)

- **Enterprise RBAC** extends `users` + `space_members` (D5).
- **Audit product** plugs into the request-logging seam in the FastAPI app (D4).
- **MCP gateway** (D9) reuses the space-membership authorization path (D5) to decide which
  sequences an agent principal may call, wrapping the `server.sequence_service` primitives
  introduced in D8.
- **MCP authoring gateway** (D11) reuses the same authorization path for writes, and builds
  on `@pona-flow/authoring` — the extracted builder logic that the React app also uses.
