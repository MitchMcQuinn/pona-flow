# Frontend Security & Beta-Readiness Review

Scope: `App/ui`, `App/composer`, `App/connector`, `App/regex-validator`, `App/data-db-editor.html` (gitignored), `App/js` (gitignored). Read-only; no files modified.

---

## 1. App/ui — Structure, State, API, Clerk Auth

### Architecture

The React app is a **three-panel dashboard** with a top bar:

| Area | Key files | Role |
|------|-----------|------|
| Entry / auth | `App/ui/src/main.tsx`, `App/ui/src/services/authFetch.ts` | Clerk gate + global fetch interceptor |
| Root orchestration | `App/ui/src/App.tsx` | Spaces, sequences, events, runs, modals |
| Layout | `App/ui/src/components/layout/ResizableDashboardLayout.tsx` | Nav / visualization / config columns |
| Navigation | `App/ui/src/components/NavigationPanel.tsx` | Spaces, sequences, groups, events, user footer |
| Visualization | `App/ui/src/components/VisualizationPanel.tsx`, `GraphView.tsx` | Design graph + run results |
| Config (right panel) | `App/ui/src/components/ConfigPanel.tsx` | Mode router: builder, params, inspect, event, space |
| Builder | `App/ui/src/components/builder/BuilderPanel.tsx` + subtree | Query composer UI |
| Space admin | `App/ui/src/components/space/SpaceConfigPanel.tsx`, `agents/AgentsPanel.tsx`, `users/UsersPanel.tsx` | Settings, RBAC, agent keys, audit |
| Top bar | `App/ui/src/components/TopBar.tsx` | Back, Run |

### State management

- **App-level**: `useReducer` + `appReducer` in `App/ui/src/state/reducer.ts` with typed events in `App/ui/src/state/events.ts`. State shape in `App/ui/src/state/types.ts` covers `spaceId`, `me`, `permissions`, nav, sequence definition, params/run, view modes, events, audit log.
- **Builder-level**: separate `BuilderProvider` / `builderReducer` in `App/ui/src/state/builder/` (`BuilderContext.tsx`, `reducer.ts`, `selectors.ts`, `validation.ts`).
- **Persistence**: `App/ui/src/services/uiPersistence.ts` — localStorage for last space/sequence, panel widths, scroll (cosmetic only; explicitly not secrets).
- **Selectors**: `App/ui/src/state/selectors.ts` drives Run button visibility, visualization mode, etc.

### API service layer

Split across two modules:

- **`App/ui/src/services/api.ts`** (~1120 lines): spaces, sequences, events, RBAC, audit, agent keys, schema/step delete previews, sequence compose/run.
- **`App/ui/src/services/execute.ts`**: builder execution — composes via `@pona-flow/composer`, posts to `/api/execute-create`, `/api/execute-query`, `/api/queries/upsert`.
- **`App/connector`**: lower-level graph/catalog helpers used by the builder (`fetchSavedQueries`, `checkAttributiveLabelExists`, `executeCreatePackage`, etc.).

Vite aliases wire packages in `App/ui/vite.config.ts`; dev server proxies `/api` → `http://127.0.0.1:8765`.

### Clerk auth handling

```8:18:App/ui/src/main.tsx
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

if (!PUBLISHABLE_KEY) {
  throw new Error(
    "Missing VITE_CLERK_PUBLISHABLE_KEY. Set it in App/ui/.env (see .env.example)."
  );
}

installAuthFetch();
```

- `ClerkProvider` + `Show when="signed-in"` / `RedirectToSignIn`.
- `AuthenticatedApp` registers `getToken()` via `setTokenGetter` (sync on render + `useLayoutEffect`).
- **`authFetch.ts`** wraps `window.fetch`: same-origin `/api/*` gets `Authorization: Bearer <token>`; 401 with a sent token triggers `signOut()`.
- Only **publishable** Clerk key in client env — no secret keys found in `App/`.

### Right-panel mode priority (from reducer)

`inspect` → `space` → `event` → `params` (sequence selected) → `builder`.

---

## 2. Composer — Cypher/SQLite Building, Parameterization vs Interpolation

### Model: hybrid

| Kind | Treatment | Key functions |
|------|-----------|---------------|
| **Property values** | `$paramName` in Cypher when `parameter` set; else `formatLiteral` / `escapeCypherString` | `App/composer/src/cypher-keys.ts` `renderPropertyMap` (L17–29), `App/composer/src/literals.ts` |
| **Runtime params** | Collected into `parameters` map; sent as `cypher_params` to backend | `composeQuery` → `collectParameters` (`App/composer/src/compose/query.ts` L12–17); `execute.ts` L144, L494 |
| **Property keys** | Backtick-escape non-identifier keys | `cypherPropertyKey`, `cypherNodePropertyRef` (`cypher-keys.ts` L5–14) |
| **SQLite string values** | `escapeSqliteString` (double single-quotes) | `literals.ts` L29–31; used throughout `sqlite/entity.ts`, `sqlite/catalog.ts`, `step/endpoint.ts` |
| **Node labels** | **Direct interpolation** `:${label}` | `render/node.ts` L69; `traversal.ts` L82, L103 |
| **Relationship types** | **Direct interpolation** `:${relType}` | `render/relationship.ts` L40–42 |
| **Cypher variables** | **Direct interpolation** (user-chosen aliases) | `render/path.ts` L18–19; `render/node.ts` L68 |
| **SET clauses** | **Raw expression passthrough** | `compose/query.ts` L67–70 |
| **RETURN / ORDER BY** | **Raw expression passthrough** | `render/return.ts` L15–26, L32–40 |
| **WHERE (free-form)** | **Raw `expression` items** | `render/where.ts` L67–69 |
| **DELETE targets** | Variable names joined | `render/return.ts` L49–52 |
| **CREATE INDEX names** | `sanitizeIndexToken` (alphanumeric + `_`, max 48) | `entity/labels.ts` L30–35; `entity/instance.ts` L40–50 |

### Cited interpolation examples

**Parameterized values (good):**

```25:26:App/composer/src/cypher-keys.ts
      if (p.parameter) return `${ck}: $${p.parameter}`;
      return `${ck}: ${formatLiteral(p.value)}`;
```

**Literal escaping (good):**

```3:10:App/composer/src/literals.ts
export function escapeCypherString(value: unknown): string {
  return (
    "'" +
    String(value)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'") +
    "'"
  );
}
```

**Label / variable string interpolation (identifiers not parameterized):**

```67:70:App/composer/src/render/node.ts
  let s = "(";
  if (options.variable) s += options.variable;
  if (label) s += `:${label}`;
  s += renderPropertyMap(nodePropertiesForCypher(node, propOpts));
```

```82:86:App/composer/src/render/traversal.ts
  const start = `(:${single.label}${attributiveLabelPropertyMap(attributiveLabel)})`;
  const relationship = mode === "downstream" ? "-[*]->" : "-[*]-";
  const endVariable = mode === "downstream" ? "downstream" : "connected";
  return [`MATCH path = ${start}${relationship}(${endVariable})`, "RETURN path"];
```

**Raw Cypher fragments (injection surface if builder input is hostile):**

```67:70:App/composer/src/compose/query.ts
    const setExprs = (query.set || [])
      .map((s) => (s && s.expression ? s.expression.trim() : ""))
      .filter(Boolean);
    if (setExprs.length) lines.push(`SET ${setExprs.join(", ")}`);
```

```15:26:App/composer/src/render/return.ts
  const projections = items
    .map((item) => {
      if (!item || !item.expression) return "";
      const expr = item.expression.trim();
      if (!expr) return "";
      return item.alias ? `${expr} AS ${item.alias}` : expr;
    })
```

**SQLite — escaped values, fixed labels:**

```107:107:App/composer/src/sqlite/entity.ts
              `INSERT INTO entities (id, node_label, common_label, parameters, payload, creation_date, modified_date) VALUES (${idSql}, '${label}', ${commonLabelSql}, ${paramsSql}, ${payloadSql}, datetime('now'), datetime('now'));`
```

(`label` is `STEP`/`SCHEMA`/`INSTANCE` from match clause, not user-freeform.)

**Catalog SQLite upserts** (`sqlite/catalog.ts` L68–139): IDs, names, JSON blobs passed through `escapeSqliteString` — still **string-built SQL**, not server-side prepared statements, but values are escaped.

### Security posture

- **Values** for graph properties and Neo4j execution are largely parameterized (`$name` + `cypher_params` dict).
- **Identifiers** (labels, rel types, variables, SET/RETURN/WHERE expressions) are **not** sanitized server-side in the composer; the UI constrains labels to `STEP|SCHEMA|INSTANCE`, but the composer API accepts arbitrary strings. Trust model: authenticated builders with flow permissions; server must reject malicious packages on execute.
- **Free-form SET** in `SetSection.tsx` (non-INSTANCE) is a deliberate power feature (`App/ui/src/components/builder/SetSection.tsx` L71–79).

---

## 3. Connector + api.ts + execute.ts — Backend Calls & Auth

### Auth attachment

All `fetch("/api/...")` and `connector.joinApiPath(...)` calls rely on the **global interceptor** — no per-call token logic. Relative paths only in production build (`base: "./"` in Vite).

### Endpoint inventory

**`api.ts` (representative):**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/spaces`, `POST /api/spaces/create|update|delete` | Space CRUD |
| `GET /api/space/record`, `groups`, `permissions`, `members`, `roles` | Space config + RBAC |
| `GET /api/queries`, `POST /api/queries/upsert|reorder`, `POST .../description` | Catalog |
| `POST /api/sequence/compose`, `POST /api/sequence/run` | Execution packages |
| `GET /api/graph/step-flow` | Step flow graph |
| `GET/POST /api/events/*` | Triggers |
| `GET /api/audit-log` | Audit |
| `GET /api/me`, `POST /api/me/settings` | Principal |
| `GET/POST/DELETE /api/spaces/{id}/agent-keys` | Agent API keys |
| `POST /api/schema/delete/preview|delete`, `POST /api/step/delete/preview|delete` | Cascade deletes |

**`connector`:**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/spaces`, `/api/space/connections|labels|groups` | Space metadata |
| `GET /api/graph/*` | Label/id/property existence, pickers |
| `GET /api/queries`, `/api/queries/{id}` | Saved packages |
| `GET /api/generate-id` | IDs (client fallback if bridge fails) |
| `POST /api/execute-create` | Create packages |

**`execute.ts` additionally:**

| Endpoint | Purpose |
|----------|---------|
| `POST /api/execute-query` | Read/update/delete runs |
| `POST /api/queries/upsert` | Save operations/sequences |

### Secrets in client code

- **None found** beyond `VITE_CLERK_PUBLISHABLE_KEY` (expected).
- Agent key **plaintext** returned once from `createAgentKey` (`api.ts` L1058–1108) — handled in UI only (see §5).
- `catalogSqliteEnvKey` returned from `/api/spaces` in connector — env key **name**, not the secret value.

### CORS assumptions

App does **not** set CORS headers; docs assume **Cloudflare** at the edge (`Docs/DEPLOYMENT.md`, `Docs/DECISIONS.md`). Same-origin fetches to `/api/*` in production. Vite dev proxy avoids cross-origin during local dev.

---

## 4. data-db-editor.html — Purpose, Gating, DB Exposure

**Files are gitignored** (`App/data-db-editor.html`, `App/js/data-db-editor.js`) — not present in the workspace, but server/docs describe behavior.

### What it does

- Static **raw SQLite catalog editor** for `data.db` tables (`queries`, `regex`, `state`, `spaces`, `events`, `audit_log`, etc.).
- Uses generic **`/api/db/*`** CRUD (`Engine/server/app.py` L1441–1488).
- Backend validates table names against `sqlite_master` (`catalog.validate_table_name`); row writes use parameterized `?` placeholders (`catalog.py` L225–237).

### Gating

```426:450:Engine/server/auth.py
async def require_db_editor_admin(request: Request) -> Principal:
    """Gate for the raw catalog DB editor (``/api/db/*``).
    ...
    """
    dev_token = _dev_db_editor_token()
    if dev_token:
        supplied = (request.headers.get(DEV_DB_EDITOR_TOKEN_HEADER) or "").strip()
        if supplied and hmac.compare_digest(supplied, dev_token):
            return Principal(..., is_instance_admin=True, ...)
    ...
    return await require_instance_admin(principal)
```

- **Production**: Clerk JWT + **instance admin** only.
- **Local dev bypass**: `DEV_DB_EDITOR_TOKEN` + `X-Dev-DB-Token` header (documented in `Docs/DEPLOYMENT.md` L119–122).
- Static HTML **does not send Clerk token** — production use requires an admin-authenticated context; otherwise 403.

### Risk

- Instance admin can read/write **entire catalog** including `queries`, `users`, agent key metadata — by design for operators, catastrophic if mis-assigned.
- No table-level ACL beyond “all catalog tables.”

---

## 5. Client-Side Security Concerns

### XSS sinks

**Only `dangerouslySetInnerHTML` usage:**

```46:61:App/ui/src/components/builder/fields/StepBodyEditor.tsx
  if (readOnly) {
    return (
      <pre
        ...
        dangerouslySetInnerHTML={{ __html: highlightHtml || "&nbsp;" }}
      />
    );
  }
  ...
        dangerouslySetInnerHTML={{ __html: highlightHtml || "&nbsp;" }}
```

Mitigation: `buildStepBodyHighlightHtml` / `escapeHtml` in `stepBodyParams.ts` (L30–63) HTML-escapes all non-highlight segments and escapes tokens inside `<span>` classes. **Low risk** if that path stays the sole sink.

No `innerHTML`, `eval`, or `document.write` elsewhere in `App/`.

### localStorage

`uiPersistence.ts` stores space/sequence IDs, operation, label, panel sizes — **no tokens or API keys**.

### Hardcoded keys

None beyond Clerk publishable key from env.

### Agent key display (`AgentsPanel.tsx`)

**Good practices:**

- Plaintext token only in `AgentKeyCreatedModal` after create (`AgentsPanel.tsx` L187–229).
- One-time display messaging; not persisted client-side.
- Listed keys show metadata only (name, dates, revoked) — no token replay.
- MCP/webhook URLs use `window.location.origin` — correct for same-origin deployment.

**Residual risks:**

- Token remains in React state until modal closed — memory-only, acceptable.
- Clipboard copy has no auto-clear.
- **Admin role filtered** from key role dropdown (L141–146) — good; server enforces `require_space_manage` on agent-key routes.

### CORS / cross-origin

Assumes same-origin UI+API or edge-configured CORS. No `credentials: 'include'` overrides; Bearer header on same-origin requests.

### `/api/db` from non-admin UI

`BuilderPanel.tsx` L547 and `RegexPatternModal.tsx` L23 call `GET /api/db/rows?table=regex` on mount. Non–instance-admins get **403** — regex patterns silently empty; `RegexPatternModal` **POST** to add patterns also 403. **UX/security gap**: no client-side gate; users see broken validation without explanation.

### Permissions fail-open in builder UI

`BuilderContext.tsx` L57–58: `flows === null` → **all operations allowed** in UI. `App.tsx` L168–169 sets `permissions: null` on fetch failure. Server must enforce; UI over-exposes controls when permissions load fails.

---

## 6. Code Quality Observations

### Duplication

- API surface split between `api.ts` and `connector` with overlapping concerns (`fetchSpaces`, `fetchSpaceGroups`, `generateId`).
- Cypher statement grouping logic duplicated conceptually in `execute.ts` (`splitCypherLines`, `groupCypherStatementsForExecution`) vs composer output format.
- Fetch error handling pattern repeated (`res.json().catch(() => ({}))`) — consistent but verbose.

### Type safety

- Generally strong: typed `AppState`, `QueryObject`, API response mapping.
- Some `Record<string, unknown>` at API boundaries (`execute.ts`, audit/member mapping).
- `fetchSequenceDefinition` hardcodes `parameterSchema: []` with migration comment (`api.ts` L556–557) — stale type contract.

### Error handling

- Many `.catch(() => undefined)` swallows errors (spaces, permissions, regex load, seed loading) — quiet failures, hard to debug.
- `composeSequence` returns **`null` on any non-OK** without surfacing error (`api.ts` L509–511) — run button may fail opaquely (“Sequence is still composing”).
- `generateQueryId` falls back to client UUID (`connector/queries.ts` L22–24) — id collision risk if server down.

### Dead / stale / prototype scaffolding

- **`App/ui/README.md` L42**: claims sequence execution is “stubbed” — **outdated**; `runSequenceExecution` is implemented.
- **`ConfigPanel.tsx` InspectPropertiesPanel** L115–120: Update/Delete buttons are **inert** (no handlers) — prototype UI.
- **`App/ui/tsconfig.tsbuildinfo`** modified in git — build artifact.
- No `App/js/` in repo (gitignored legacy).

### Tests

Composer/validator tests in `/tests/`; no broad React component test suite visible.

---

## 7. New/Modified Files — Half-Finished or Risky

### `AgentsPanel.tsx` (new)

- **Complete enough for beta** for happy path: list/create/revoke keys, MCP URL copy, role selection.
- **Gaps**: no loading state on create beyond form; errors aggregated in one banner; revoked keys stay in list (read-only) — fine.
- **Security**: server gates with `require_space_manage`; UI gates tab via `canManageSpace` in `SpaceConfigPanel.tsx` L352.

### `SpaceConfigPanel.tsx`

- Adds **Agents** tab, **description** field for MCP space instructions, shared sequence labels.
- **Risk**: `description` saved on settings tab but only space managers can edit — good.
- Audit tab is read-only for all space members (no `canManageSpace` gate on audit tab L261–267) — likely intentional.

### `ConfigPanel.tsx`

- **SequenceDescriptionEditor** — focused MCP tool description edit; solid.
- **Inspect panel** — half-finished (inert buttons).
- Parameter locking during `awaitingParams` — well thought out.

### `BuilderPanel.tsx`

- Large orchestration file; edit-operation vs create flows split cleanly.
- **Risk**: regex load via `/api/db` without permission check (see §5).
- `flows` RBAC wired through `OperationSelect` / `LabelSelect` — good when permissions load.

### `ParametersSection.tsx`

- New **parameter descriptions** for MCP schema (`L194–199`) — aligns with `composer/step/parameters.ts` serialization.
- Attributive label live uniqueness check — good.

### `CreateOperationModal.tsx`

- **Half-finished**: `description` field only shown when **“add as sequence”** is checked (L106–169), and `save()` only passes `description` when `addAsSequence` (L73). **Standalone operations cannot get an MCP description from this modal** despite `buildQueriesCatalogPayload` supporting `description` (`execute.ts` L177–178).

### `api.ts`

- Agent key APIs well-typed.
- `composeSequence` silent failure — beta risk for run flow.
- `parseSequenceAttributiveLabel` regex-parses stored Cypher client-side (`api.ts` L329–338) — fragile if Cypher format changes.

### `execute.ts`

- `buildQueriesCatalogPayload` includes `builder_config` for round-trip — good for edit-operation flow.
- Auto-wrap STEP/sequence side effects (`autoWrapInStep`, `autoWrapInSequence`) — complex; failures throw but partial success possible if second call fails.

### `types.ts` (app + composer)

- `Parameter.description` and sequence `description` fields added for MCP — coherent.
- Composer `Parameter` type in `App/composer/src/types.ts` should include `description` if serialized (confirmed in `step/parameters.ts` L29–32).

### `composer/src/step/parameters.ts` (modified)

- Fix: catalog `parameters` column no longer blanked for STEP custom endpoints — comment at L38–41 documents prior bug. **Low risk**, improves data integrity.

---

## Summary Risk Matrix (Beta)

| Area | Severity | Notes |
|------|----------|-------|
| Composer raw SET/RETURN/WHERE expressions | Medium | Trusted-builder model; server validation critical |
| `/api/db` regex load without admin UI gate | Low–Med | Broken feature for non-admins; confusing |
| Permissions `null` → unrestricted builder UI | Low–Med | Fail-open client; server must deny |
| data-db-editor + `/api/db/*` | High (if misconfigured) | Instance-admin skeleton key; dev token bypass in local only |
| Agent key one-time display | Low | Reasonable; depends on server hashing |
| StepBodyEditor XSS sink | Low | Escaped today; regression-sensitive |
| Stale ui README / inspect stub / composeSequence null | Low (beta polish) | User confusion, not direct exploit |

---

## App/js

Not in repository (gitignored with `data-db-editor.js`). Referenced only as companion script for the SQLite editor per `.gitignore` and `README.md`.

---

**Bottom line:** The frontend is structurally mature — Clerk auth is centralized, composer hybrid-parameterizes **values** while interpolating **identifiers and expressions**, and agent-key handling follows one-time-display conventions. Main beta-readiness gaps are **fail-open permissions UI**, **non-admin regex/DB editor calls**, **silent compose failures**, **stale docs/scaffold inspect UI**, and **CreateOperationModal description only for sequences**. For production, rely on server-side authorization on every execute/upsert path and keep `DEV_DB_EDITOR_TOKEN` unset.

# pona flow — Defensive Security & Beta-Readiness Review

Read-only exploration of `/Users/mitchie/Documents/schematago/schematago`. No files were modified.

---

## 1. Documentation Summary

### 1.1 Product vision & commercial model

**Open-core, single-tenant SaaS.** Core repo is open source; revenue from managed dedicated instances + consulting. Each client gets an isolated instance (own Neo4j + SQLite + secrets). Within an instance: multiple users and multiple **spaces** as the isolation boundary.

```9:27:Docs/DECISIONS.md
## D1. Product & commercial model

**Decision:** pona flow is an **open-core** product. The core (this repository) is
open source. Revenue comes primarily from a **dedicated single-tenant instance
management service** ...
**Commercial-license (paid, closed) features** — explicitly *out of scope* for the
open-core production launch:
- SSO (SAML/enterprise IdP federation beyond the standard hosted login)
- Audit logging *product* (retention, export, search UI). Minimal operational request
  logging is fine in core.
- Enterprise / custom RBAC (role matrices, fine-grained per-sequence grants, custom roles)
- MCP gateway (exposing a space's sequences as agent-callable tools)
```

**Product positioning (CONTEXT-GRAPH-DECISIONING.md):** Agentic context engineering via a hybrid graph model — `STEP` / `SCHEMA` / `INSTANCE` nodes linked by `POINTS_TO`, with SQLite payloads for nested data. Decisioning = graph traversal + workflow routing + taxonomy inheritance.

**End-user vision (GETTING-STARTED.md):** Managed hosting (browser + Clerk login) or self-hosted. Spaces → sequences → builder. First login = instance admin; space creator = owner.

---

### 1.2 Architecture decisions

| Decision | Stated choice | Key citation |
|----------|---------------|--------------|
| **D2 Tenancy** | Single-tenant per client | ```31:42:Docs/DECISIONS.md``` |
| **D3 Auth + edge** | Clerk JWT (JWKS); Cloudflare for TLS/CORS/WAF/rate limit; app not exposed directly | ```46:65:Docs/DECISIONS.md``` |
| **D4 Backend** | FastAPI/uvicorn ASGI; domain modules unchanged | ```69:78:Docs/DECISIONS.md``` |
| **D5 Permissions** | Auth + space membership; owner + instance admin | ```82:96:Docs/DECISIONS.md``` |
| **D6 Secrets** | Env-key indirection in `spaces` rows; no secrets in DB | ```100:108:Docs/DECISIONS.md``` |
| **D7 SSRF** | Block private/loopback; optional `PONA_FLOW_OUTBOUND_ALLOWLIST` | ```112:117:Docs/DECISIONS.md``` |
| **D8 Webhooks + agent keys** | Dual auth (Clerk or `stg_` key); `sequence_service` primitive | ```121:145:Docs/DECISIONS.md``` |
| **D9 MCP gateway** | Per-space Streamable HTTP MCP; thin wrapper over D8 | ```149:179:Docs/DECISIONS.md``` |

**JSON schemas** define the data contracts:
- **QUERY-package.schema.json:** Legacy query packages + CRUD v2; graph patterns (`STEP`/`SCHEMA`/`INSTANCE`, `POINTS_TO`); endpoint steps with `format: uri`; `read_traversal` downstream/network.
- **EXECUTION-package.schema.json:** Step graph with `condition_expected` branching, HTTP methods, `response_parameters`, lazy HITL via `parameters[]`.

---

### 1.3 Security model (as documented)

**SECURITY-GUIDE.md** — defense in depth analogy:

```9:44:Docs/SECURITY-GUIDE.md
> **The one-sentence version:** We turned an app that anyone on your laptop could fully
> control into a building with a locked front door (Cloudflare), a professional reception
> desk that checks ID (Clerk), key-card access to individual rooms (space membership),
> and a vault for the keys (secret management) ...
```

Layers: Cloudflare (TLS, CORS, rate limit) → Clerk (auth) → space membership (authz) → SSRF controls on endpoint steps → admin-only `/api/db/*`.

**SEQUENCE-WEBHOOKS.md / MCP-GATEWAY.md** extend this for agents: SHA-256 hashed keys, per-sequence RBAC allowlist, immediate revocation, same SSRF rules, Cloudflare still applies.

---

### 1.4 Deployment assumptions

```3:17:Docs/DEPLOYMENT.md
pona flow is delivered as a **dedicated single-tenant instance** per client ...
User[Browser / API client] --> CF[Cloudflare: TLS, CORS, WAF, rate limit]
  CF --> Uvicorn[uvicorn + FastAPI app]
  Uvicorn --> Clerk[(Clerk JWKS verify)]
  Uvicorn --> Catalog[(catalog SQLite data.db)]
  Uvicorn --> Neo4j[(per-space Neo4j)]
```

Operational checklist: venv + `requirements.txt`, build UI (`App/ui/dist`), Clerk env vars, secrets via host env, Cloudflare origin lock, first user = instance admin.

**Migrations:** Idempotent startup only — no manual step, no rollback documented.

```102:107:Docs/DEPLOYMENT.md
Catalog schema is applied deterministically at startup by
`Engine/server/migrations.py` ... No manual migration step is needed ...
```

**Backup:** Mentioned only in customer-facing copy (“we set up … backups”), not in DEPLOYMENT operator steps.

```32:34:Docs/GETTING-STARTED.md
You receive a **ready-to-use web address** ...
We set up the servers, security, backups, and updates.
```

```94:99:Docs/DEPLOYMENT.md
The catalog database (`data.db`) holds `spaces`, `queries`, `state`, `users`,
`space_members`, and `regex`. Back it up alongside the per-space SQLite files and Neo4j.
```

One sentence on backup — no procedure, schedule, or restore test.

---

### 1.5 Stated known gaps / TODOs in docs

| Gap | Where stated |
|-----|--------------|
| Commercial SSO, audit product UI, enterprise RBAC, MCP as paid tier | ```16:23:Docs/DECISIONS.md```, ```199:204:Docs/GETTING-STARTED.md``` |
| Self-service email invites “may expand” | ```186:188:Docs/GETTING-STARTED.md``` |
| `external` event type reserved, not evaluated | ```4:4:Engine/schema/events-table.sql``` |
| MCP DNS-rebinding disabled by default; opt-in Host allowlist | ```172:174:Docs/DECISIONS.md```, ```195:202:Docs/MCP-GATEWAY.md``` |
| Commercial “audit product” vs minimal `audit_log` in core | D1 vs ```1:19:Engine/schema/audit-log-table.sql``` |

---

## 2. Engine/schema/*.sql — DDL Summary

### 2.1 Tables (14 SQL files)

| Table | File | PK / constraints / indexes |
|-------|------|---------------------------|
| **users** | `users-table.sql` | PK `id`; `clerk_user_id UNIQUE`; CHECKs on `principal_type`, `can_create_spaces`, `is_instance_admin`; idx on `clerk_user_id` | ```17:30:Engine/schema/users-table.sql``` |
| **space_members** | `space-members-table.sql` | PK `id`; CHECK `status IN ('pending','active')`, `is_owner`; UNIQUE `(space_id, principal_id)`, `(space_id, invited_email)`; indexes on principal/space | ```15:30:Engine/schema/space-members-table.sql``` |
| **space_roles** | `space-roles-table.sql` | PK `id`; `permissions` JSON CHECK; UNIQUE `(space_id, name)`; idx on `space_id` | ```9:20:Engine/schema/space-roles-table.sql``` |
| **agent_keys** | `agent-keys-table.sql` | PK `id`; `key_hash UNIQUE` (also unique index); CHECK `revoked`; idx on `space_id` | ```10:22:Engine/schema/agent-keys-table.sql``` |
| **queries** | `queries-table.sql` | PK `id`; CHECKs on `kind`, `operation`, policy flags; JSON validity on `cypher`/`sqlite`/`parameters`/`builder_config`; **no secondary indexes, no UNIQUE on name** | ```4:24:Engine/schema/queries-table.sql``` |
| **state** | `state-table.sql` | PK `id`; CHECK `status IN ('active','pending','inactive')`; JSON on `package`; **no indexes** | ```4:11:Engine/schema/state-table.sql``` |
| **entities** | `entities-table.sql` | PK `id`; **no indexes on `node_label`/`common_label`** | ```5:13:Engine/schema/entities-table.sql``` |
| **events** | `events-table.sql` | PK `id`; CHECK `type`, `enabled`; JSON columns; idx on `space_id` | ```13:27:Engine/schema/events-table.sql``` |
| **audit_log** | `audit-log-table.sql` | PK `id`; CHECK `trigger IN ('manual','event','recovery')`; idx on `run_at`, `space_id` | ```11:22:Engine/schema/audit-log-table.sql``` |
| **regex** | `regex-table.sql` | PK `name`; seed data | ```4:16:Engine/schema/regex-table.sql``` |
| **spaces** (columns only) | `spaces-*-column.sql` | Additive ALTERs: `is_private`, `dev_mode`, `groups`, (description via Python) | e.g. ```5:5:Engine/schema/spaces-is-private-column.sql``` |
| **queries-seed-system.sql** | Seed | `INSERT OR IGNORE` + `UPDATE` for system query primitives | ```14:44:Engine/schema/queries-seed-system.sql``` |

### 2.2 Missing / weak schema elements

1. **No `CREATE TABLE spaces` DDL file.** Base `spaces` table is legacy/bootstrap only; migrations add columns if table exists.

```868:877:Engine/server/spaces.py
def ensure_catalog_space_schema(conn: sqlite3.Connection | None = None) -> None:
    """Ensure catalog ``spaces`` schema columns exist (safe to call repeatedly)."""
    ...
        _ensure_spaces_groups_column(conn)
        _ensure_spaces_is_private_column(conn)
        _ensure_spaces_dev_mode_column(conn)
        _ensure_spaces_description_column(conn)
```

2. **Zero `FOREIGN KEY` / `REFERENCES` / `ON DELETE` anywhere** in `Engine/schema/` (grep returned no matches). Orphan rows possible for `agent_keys.principal_id`, `space_members.role_id`, `events.space_id`, etc.

3. **`space_members` not in migration DDL loop** — rebuilt by `rbac.ensure_rbac_schema` instead.

```27:29:Engine/server/migrations.py
# NOTE: ``space-members`` is intentionally absent — its table can require a rebuild
# from the legacy (space_id, user_id) shape, so it is owned by ``rbac.ensure_rbac_schema``.
```

4. **`audit_log.trigger` CHECK** does not include `webhook` or `mcp`, but code passes those triggers — they are coerced to `manual`:

```760:760:Engine/server/catalog.py
    trigger_val = trigger if trigger in ("manual", "event", "recovery") else "manual"
```

5. **`agent_keys`:** no FK to `users` or `spaces`; no index on `principal_id`; revoked keys remain in DB (by design per docs).

6. **`queries`:** no uniqueness on `name`; `sort_order` and other columns added at runtime in `catalog.py`, not in base DDL.

7. **`entities`:** per-space table; no FK to graph `id`; no indexes for label lookups.

---

## 3. Tests — Coverage & Gaps

### 3.1 Frameworks / runners

| Stack | Runner | Invocation |
|-------|--------|------------|
| **Python** | Ad-hoc diagnostic scripts (`check()` + `sys.exit(1)`); **not pytest/unittest** | `.venv/bin/python tests/<name>.py` |
| **JavaScript/TS** | Node `assert` + **tsx** | `cd App/ui && npm run test:composer` etc. |

```11:11:App/ui/package.json
    "test:composer": "tsx ../../tests/composer-golden.mjs && tsx ../../tests/composer-path-where.mjs && ...
```

**No CI config** found (no `.github/workflows`, no pytest config).

### 3.2 Test inventory (38 files)

#### Python (11) — mostly unit/integration against throwaway SQLite, stubs for Neo4j/HTTP

| Category | Files | Style |
|----------|-------|-------|
| **RBAC** | `rbac-permissions.py`, `rbac-owner-admin-guards.py` | Temp SQLite; real `rbac`/`auth` guards; no HTTP | ```1:14:tests/rbac-permissions.py``` |
| **MCP gateway** | `mcp-gateway-smoke.py` | Hermetic; stubs `sequence_service` + `auth.effective_permissions` | ```1:14:tests/mcp-gateway-smoke.py``` |
| **Sequences / execution** | `sequence-compose-scope.py`, `sequence-relationship-branch.py`, `sequence-name-uniqueness.py` | Stubbed loaders or temp DB | ```11:13:tests/sequence-compose-scope.py``` |
| **Event triggers** | `event-trigger-evaluation.py`, `event-trigger-timezone.py` | Pure `triggers` module | ```1:11:tests/event-trigger-evaluation.py``` |
| **Spaces / catalog** | `space-label-closure.py`, `state-purge-finished.py`, `schema-delete-reference-scan.py` | Mixed stub/real | |

#### JavaScript (27 + 1 helper) — composer/UI/validator

| Category | Representative files |
|----------|---------------------|
| **Composer / Cypher** | `composer-golden.mjs`, `composer-read-traversal.mjs`, `cypher-create-multi-pattern.mjs`, `composer-path-where.mjs`, … |
| **Match graph / aliases** | `matchgraph-serialize.mjs`, `match-alias-reference.mjs`, `match-mode-hop-gate.mjs` |
| **Schema / INSTANCE** | `schema-effective-schemata.mjs`, `instance-create-key-id.mjs`, `delete-label-only-compose.mjs` |
| **UI builder logic** | `endpoint-step-runnable.mjs`, `step-wrap-operation.mjs`, `step-flow-query-filter.mjs` |
| **Validator** | `regex-validator.mjs` |
| **Connector** | `connector-api-path.mjs` (path helper only) |
| **UI utils** | `format-sql-preview.mjs` |
| **Catalog persist** | `queries-catalog-persist.mjs`, `composer-parameter-serialization.mjs` |

### 3.3 How representative tests work

**`rbac-permissions.py`** — Unit-style against minimal catalog; patches `config.catalog_sqlite_path`; exercises permission resolution, invite-claim, `auth.require_flow`, `require_can_create_spaces`. No Clerk JWT, no FastAPI TestClient.

```54:69:tests/rbac-permissions.py
tmpdir = tempfile.mkdtemp(prefix="pona-flow-rbac-test-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db
...
    rbac.ensure_rbac_schema(conn)
```

**`rbac-owner-admin-guards.py`** — Same pattern; sole-owner protection, Admin role immutability.

**`mcp-gateway-smoke.py`** — Unit smoke; explicitly **no live server**:

```4:10:tests/mcp-gateway-smoke.py
Covers the transport-independent core (no live HTTP server, no Neo4j):
  ...
Sequence_service and permission resolution are stubbed so the test is hermetic.
```

**`sequence-compose-scope.py`** — Unit; monkeypatches `execution._load_step_entities`, `catalog.fetch_query_for_compose`.

### 3.4 Major coverage gaps (security-relevant)

| Area | Status |
|------|--------|
| **Clerk JWT verification** (`auth.verify_clerk_token`) | No tests |
| **Agent key mint/verify/revoke** (`agent_keys.py`) | No tests |
| **Webhook HTTP endpoints** (`POST .../sequences/.../run`, `GET .../sequences`) | No tests |
| **MCP HTTP transport** (Streamable HTTP mount) | Smoke only on Python helpers |
| **SSRF / outbound allowlist** (`execution._validate_outbound_url`) | No tests |
| **FastAPI route auth** (401/403 on unauthenticated routes) | No tests |
| **Instance admin gate** on `/api/db/*` | No tests |
| **`require_sequence_run`** with agent principals | Only via MCP stub |
| **Scheduler / event firing** end-to-end | Trigger logic only, not scheduler |
| **Neo4j integration** | Not in tests/ |
| **E2E / browser** | None |
| **CI pipeline** | None found |

---

## 4. Deployment & Runtime Config

### 4.1 `Engine/dev_server.py`

```4:18:Engine/dev_server.py
pona flow server entry point — FastAPI/ASGI app served by uvicorn.
...
Unlike the original stdlib http.server, every /api/* route requires a verified Clerk
session token, and space-scoped routes enforce membership ...
TLS and CORS are handled by Cloudflare in front of the instance.
```

```28:49:Engine/dev_server.py
    config.load_env_file(config.ROOT / ".env")
    host = os.environ.get("FORM_BRIDGE_HOST", "127.0.0.1")
    port = int(os.environ.get("FORM_BRIDGE_PORT", "8765"))
    ...
    uvicorn.run("server.app:app", host=host, port=port, log_level="info")
```

Startup migrations run in app lifespan:

```109:111:Engine/server/app.py
async def _lifespan(_app: FastAPI):
    config.load_env_file(config.ROOT / ".env")
    migrations.run_startup_migrations()
```

### 4.2 `.env.example` — variable NAMES only

Documented in `.env.example`:
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
- `SQLITE_DATABASE_PATH`
- `PONA_FLOW_CATALOG_SQLITE_KEY`
- `CLERK_ISSUER`, `CLERK_JWKS_URL`, `CLERK_AUTHORIZED_PARTIES`
- `VITE_CLERK_PUBLISHABLE_KEY` (UI build)
- `PONA_FLOW_OUTBOUND_ALLOWLIST`, `PONA_FLOW_ALLOW_PRIVATE_OUTBOUND`
- `FORM_BRIDGE_HOST`, `FORM_BRIDGE_PORT`

**Used in code but absent from `.env.example`:**
- `SUPERADMIN_CLERK_ID`, `SUPERADMIN_EMAIL` — ```111:118:Engine/server/config.py```
- `CLERK_SECRET_KEY`, `CLERK_API_BASE` — ```121:132:Engine/server/config.py```
- `PONA_FLOW_MCP_ALLOWED_HOSTS` — ```256:256:Engine/server/mcp_gateway.py```
- Per-space keys: `{SPACE}_NEO4J_URI`, `{SPACE}_NEO4J_USER`, `{SPACE}_NEO4J_PASSWORD`, `{SPACE}_SQLITE_DATABASE_PATH` (documented in DEPLOYMENT, not `.env.example`)

### 4.3 `requirements.txt`

```1:6:requirements.txt
neo4j>=5.0.0
fastapi>=0.110.0
uvicorn[standard]>=0.29.0
pyjwt[crypto]>=2.8.0
httpx>=0.27.0
mcp>=1.27.0
```

MCP is a **default** dependency (contrasts with D1 “optional commercial” positioning; disable by uninstalling per MCP-GATEWAY.md).

### 4.4 `package.json` files

- **Root** (`package.json`): only `@clerk/react` dependency.
- **`App/ui/package.json`:** Vite/React build; `test:composer`, `test:validator`, `test:connector` npm scripts; tsx for tests.
- **`App/composer/package.json`:** ES module package `@pona-flow/composer`, no test script (tests live in `/tests`).

---

## 5. Doc ↔ Code Discrepancies (Beta-readiness risks)

### 5.1 Permission model drift (high)

**Docs (D5, SECURITY-GUIDE, GETTING-STARTED):** Binary membership — member = full access.

```84:88:Docs/DECISIONS.md
- A user is either a **member of a space or not**. Members get **full access** to that
  space (read catalog, run sequences, mutate graph, edit). Non-members get nothing.
```

**Code:** Full hybrid RBAC with roles, flow matrix (`create:STEP`, etc.), per-sequence allowlists, superadmin env gate, `can_create_spaces` delegation.

```7:26:Engine/server/rbac.py
The original model (see Docs/DECISIONS.md D5) was binary: a principal was either a space
member (full access) or not ...
This module implements a hybrid RBAC layer ...
    {
        "flows": ["read:STEP", "create:INSTANCE", ...],
        "sequences": {"all": false, "ids": ["ID_..."]},
        "manage_space": false
    }
```

Default **Member** role is read-only for writes (`READ_FLOWS` only) — ```63:73:Engine/server/rbac.py``` — contradicting “full access for members.”

### 5.2 Commercial vs shipped features (medium)

| Feature | D1 says | Repo reality |
|---------|---------|--------------|
| MCP gateway | Paid / out of scope | Implemented; in `requirements.txt` | ```149:179:Docs/DECISIONS.md``` |
| Enterprise RBAC | Commercial | Shipped in `rbac.py` + tests |
| Audit logging product | Commercial UI | `audit_log` table + `record_audit` in core | ```1:19:Engine/schema/audit-log-table.sql``` |
| Agent webhooks | Groundwork for MCP | Fully documented + implemented | D8 |

### 5.3 `auth.py` module doc still describes D5 only

```12:14:Engine/server/auth.py
- **Authorization** is space ownership/membership only. A user is either a member of a
  space (full access) or not.
```

Does not mention agent keys, RBAC flows, or `require_sequence_run`.

### 5.4 Audit trigger taxonomy (medium)

Webhook/MCP runs pass `trigger="webhook"` / `"mcp"` but DB only allows `manual|event|recovery` — attribution lost.

### 5.5 DEPLOYMENT typo (low)

```24:24:Docs/DEPLOYMENT.md
python3 -m venv .venv && ç
```

Stray `ç` character in install command.

### 5.6 Instance admin bootstrap

Docs: first authenticated user → instance admin. Code also supports env-based **superadmin** (`SUPERADMIN_CLERK_ID` / `SUPERADMIN_EMAIL`) not documented in DEPLOYMENT or `.env.example`.

```7:8:Engine/schema/users-table.sql
-- The single server superadmin is determined by environment (SUPERADMIN_CLERK_ID /
-- SUPERADMIN_EMAIL), not by this table
```

---

## 6. Missing Operational Pieces

| Concern | Documented? | Implemented? |
|---------|-------------|--------------|
| **Backup / restore** | One line in DEPLOYMENT; marketing in GETTING-STARTED | No automation, no restore test |
| **Migration rollback** | Forward-only idempotent migrations | No down migrations | ```49:59:Engine/server/migrations.py``` |
| **Structured logging / audit trail** | Commercial audit = paid; minimal logging OK | `audit_log` inserts; errors to stderr; uvicorn `log_level="info"` only | ```798:799:Engine/server/execution.py``` |
| **App-level rate limiting** | Delegated to Cloudflare | None in FastAPI | ```61:71:Docs/DEPLOYMENT.md``` |
| **Health checks / readiness** | Not documented | Not found in `app.py` skim |
| **Secret rotation** | Env injection assumed | No key rotation workflow for agent keys beyond revoke+remint |
| **Monitoring / alerting** | Not documented | Not found |
| **CI / automated test gate** | README shows manual test commands | No workflow files |

---

## 7. Beta-readiness assessment (concise)

**Strengths**
- Clear single-tenant + Clerk + Cloudflare security story in docs.
- SSRF guard implemented with allowlist and private-range blocking — ```525:531:Engine/server/execution.py```.
- Agent keys: SHA-256 + `secrets.token_urlsafe` + constant-time compare — ```39:40:Engine/server/agent_keys.py```.
- Good composer/RBAC/trigger **unit** coverage for core domain logic.
- Deterministic startup migrations for most catalog tables.

**Blockers / high-priority gaps before public beta**
1. **Reconcile docs with RBAC reality** (Member ≠ full access; roles/sequences permissions exist).
2. **Security integration tests:** auth (JWT + agent key), webhook routes, SSRF, admin-only `/api/db/*`.
3. **Catalog schema hardening:** consider FKs or application-level cascade; `spaces` base DDL in repo; fix `audit_log.trigger` for `webhook`/`mcp`.
4. **Operational runbook:** backup/restore, `.env.example` completeness, remove DEPLOYMENT typo.
5. **CI** to run existing diagnostic scripts on every change.

**Medium priority**
- HTTP-level MCP smoke test (even against TestClient).
- `agent_keys` unit tests (mint, verify, revoke, wrong space).
- Document superadmin env vars in DEPLOYMENT / `.env.example`.

---

This review is informational only (Ask mode). Switch to Agent mode if you want help closing specific gaps.

# Security & Beta-Readiness Code Review

Review of the requested modules plus HTTP guards in `auth.py` / `app.py` where RBAC is enforced. No files were modified.

---

## 1. RBAC model (`Engine/server/rbac.py`)

### Permission structure

Canonical vocabulary at `rbac.py:44-47`:
- **Operations:** `create`, `read`, `update`, `delete`
- **Elements:** `STEP`, `SCHEMA`, `INSTANCE`
- **Flow keys:** `"<operation>:<element>"` (e.g. `read:STEP`)

Permission JSON shape documented at `rbac.py:20-26` and normalized by `normalize_permissions` (`rbac.py:81-106`):

| Key | Shape | Meaning |
|-----|-------|---------|
| `flows` | `string[]` | Allowed `<op>:<element>` keys; unknown entries dropped |
| `sequences` | `{all: bool, ids: string[]}` | Which sequences may be run |
| `manage_space` | `bool` | Space admin (members, roles, events, settings) |

### Default roles

Seeded per space by `_seed_default_roles` (`rbac.py:285-308`):

| Role | `is_default` | Permissions (`rbac.py:54-73`) |
|------|--------------|-------------------------------|
| **Admin** | `0` | All flows, `sequences.all=true`, `manage_space=true` |
| **Member** | `1` | `read:*` only, `sequences.all=true`, `manage_space=false` |

Owners are migrated to Admin role in `_seed_existing_spaces` (`rbac.py:269-282`).

### Predicate functions

```146:159:Engine/server/rbac.py
def perms_allow_flow(perms: dict[str, Any], operation: str, element: str) -> bool:
    key = f"{(operation or '').strip().lower()}:{(element or '').strip().upper()}"
    return key in (perms.get("flows") or [])

def perms_allow_sequence(perms: dict[str, Any], sequence_id: str) -> bool:
    seqs = perms.get("sequences") or {}
    if seqs.get("all"):
        return True
    return (sequence_id or "").strip() in (seqs.get("ids") or [])

def perms_allow_manage(perms: dict[str, Any]) -> bool:
    return bool(perms.get("manage_space"))
```

HTTP wrappers: `auth.require_flow` (`auth.py:484-496`), `auth.require_sequence_run` (`auth.py:499-511`), `auth.require_space_manage` (`auth.py:514-524`).

### Owner / superadmin semantics

`resolve_effective_permissions` (`rbac.py:645-689`):

1. **Superadmin** (`is_superadmin=True`) → `admin_permissions()` (`rbac.py:653-654`)
2. **Space owner** (`is_owner=1`, active) → `admin_permissions()` (`rbac.py:668-669`) — **owners bypass role and override**
3. Otherwise: role template merged with `permissions_override` via `merge_permissions` (`rbac.py:128-140`, `681-687`)
4. Non-members → `empty_permissions()` (`rbac.py:76-78`, `666-667`)

Admin **role name** also forces full access even for non-owners (`rbac.py:677-679`).

Superadmin is env-defined (`auth.py:146-154`, `config.py:111-118`), not a DB role.

### Invite flow

- `invite_member` (`rbac.py:454-494`): pending row by email, or immediate active if user exists (`rbac.py:462-481`)
- `claim_pending_invites` (`rbac.py:497-517`): on sign-in, binds `principal_id`, skips spaces where user is already a member
- Duplicate guard (`rbac.py:466-473`)

### Who can change roles / members (HTTP layer)

All gated by `auth.require_space_manage` in `app.py`:
- Invite: `app.py:407`
- Update member: `app.py:424`
- Remove: `app.py:453`
- Roles CRUD: `app.py:468`, `483`, `508`

Space creation assigns creator as owner + Admin role (`app.py:213-223`).

### Privilege-escalation gaps

**High — `role_id` not validated against `space_id`**

- `invite_member` (`rbac.py:480`, `488`): inserts `role_id` with no FK/space check
- `update_member` (`rbac.py:534-536`): same
- `resolve_effective_permissions` (`rbac.py:672-675`): `SELECT ... FROM space_roles WHERE id = ?` — **no `space_id` filter**

A manager (or invite payload) could attach another space’s Admin `role_id` and inherit that role’s permissions. `agent_keys.create_key` has the same gap (`agent_keys.py:83-87`).

**High — manager can grant owner**

- `update_member` accepts `is_owner=True` (`rbac.py:542-544`) with only “last owner” protection on **demotion** (`rbac.py:549-555`) and **removal** (`rbac.py:587-588`)
- No requirement that the caller is an owner; `require_space_manage` is sufficient (`app.py:424-436`)
- Any principal with `manage_space` can promote themselves (or others) to owner

**Medium — `permissions_override` can grant full admin without `is_owner`**

- `sanitize_override` allows `manage_space: true` and arbitrary `flows` (`rbac.py:109-125`)
- Manager can set override on any member (`update_member` `rbac.py:539-541`)
- Effective perms then include `manage_space` and custom flows without `is_owner`

**Low — built-in Admin role protection**

- `upsert_role` blocks create/edit of role named “Admin” (`rbac.py:357-358`, `367-368`)
- `delete_role` blocks deleting Admin (`rbac.py:397-398`, `405`: `is_default = 0` also blocks Member delete)
- Admin permissions can still be obtained via **owner flag**, **Admin role assignment by id**, or **override**

**Low — `add_member` upgrade semantics**

- `MAX(is_owner, ?)` (`rbac.py:438-440`) can upgrade existing member to owner if called with `is_owner=True` (internal API; space create uses it legitimately)

**Note — instance admin ≠ space manager**

- `require_space_access` bypasses membership for `is_instance_admin` (`auth.py:463-464`)
- `require_space_manage` does **not** bypass for instance admin — only superadmin (`auth.py:517-518`)
- Instance admin can access spaces but needs normal RBAC for manage/flows unless superadmin

---

## 2. Execution (`Engine/server/execution.py`)

### How EXECUTION packages run

Two phases:

1. **Compose** — `compose_execution_package` (`execution.py:246-357`): walks STEP graph from catalog sequence cypher, builds flat `steps` + `response_parameters`
2. **Run** — `run_execution` (`execution.py:733-893`): state machine over stored package in catalog `state` table

### Does it execute arbitrary Cypher/SQL?

| Store | Source at run time | Module |
|-------|-------------------|--------|
| **Cypher** | Catalog `queries.cypher` via `catalog.fetch_query_for_compose` | `execution.py:489-514` (`_execute_query_step`) |
| **SQL** | **Not executed** in this module | SQL lives in `packages.py` (builder write path) |
| **HTTP** | STEP `endpoint`/`method`/`headers`/`body` from per-space SQLite entities | `execution.py:570-633` |

Statements are **not client-supplied at run time**; they are fixed when the package was composed from DB-backed queries and entities.

### String interpolation

- **Cypher:** `graph.run_cypher_for_space(space_id, stmt_text, dict(resolved))` (`execution.py:505`) — Neo4j parameterized binding, no f-string into query text
- **HTTP body:** `_substitute` (`execution.py:474-486`) replaces strings that are exactly `$paramName` (after strip); not general template injection
- **Compose-time regex** parses `attributive_label` from stored cypher (`execution.py:37-39`, `53-59`) — read-only parsing, not execution

**Residual risk:** catalog-stored cypher that uses unsafe string concatenation (author-defined) is not sanitized; only bound params are safe if queries use `$name` placeholders.

### Parameter binding

- Run params merged into `resolved` (`execution.py:773-778`)
- Passed as Neo4j param dict (`execution.py:505`)
- Response parameters extracted via `_extract_path` (`execution.py:442-471`) and `_bind_response_parameters` (`execution.py:647-660`)
- Endpoint body: `_substitute(body, resolved)` (`execution.py:582`)

### Policy checks (`runtime_enabled`, `kind`, `triggerable`)

At **compose** for the **top-level sequence only** (`execution.py:259-268`):

```262:268:Engine/server/execution.py
    if not int(seq.get("runtime_enabled", 1)):
        raise PermissionError(...)
    if seq.get("kind") == "sequence" and not int(seq.get("triggerable", 1)):
        raise PermissionError(...)
```

**Gaps:**
- Nested operation `query_id` steps: **no** `runtime_enabled` check in `_execute_query_step` (`execution.py:489-514`)
- Nested sequences enqueued in compose (`execution.py:285-296`) — no per-nested runtime/triggerable check
- **Scheduler** calls `compose_and_store` without principal — policy enforced only at compose, not RBAC

### Swallowed exceptions

- `_load_step_adjacency` (`execution.py:151-154`): bare `except Exception: return {}` — silent empty graph on Neo4j failure
- Cleanup/audit (`execution.py:384-385`, `798-799`, `880-881`): logged to stderr, run continues

---

## 3. Spaces (`Engine/server/spaces.py`)

### Env-key resolution

- Space row stores **key names**, not secrets (`spaces.py:7-11`, `49-55`)
- Default keys: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `SQLITE_DATABASE_PATH` (`spaces.py:910-913`)
- Per-space keys: `{SPACE_ID}_NEO4J_URI`, etc. (`spaces.py:897-905`)
- Resolution: `config.env_value(key, fallback_key=...)` (`spaces.py:74-76`, `88-92`; `config.py:64-81`)
- Neo4j password loaded server-side only; API exposes `password_configured` not value (`spaces.py:1235-1264`)

### SQLite path / path traversal

`config.sqlite_path_for_env_key` (`config.py:84-88`):

```84:88:Engine/server/config.py
def sqlite_path_for_env_key(env_key_name: str, fallback_key: str | None = None) -> Path:
    raw = env_value(env_key_name, fallback_key=fallback_key)
    p = Path(raw)
    return p if p.is_absolute() else ROOT / p
```

- API only sets **env key column names** (derived from normalized space id); paths come from server `.env`
- **No canonicalization** — a malicious `.env` value like `../../outside/db.sqlite` resolves under/above `ROOT`
- **No writes to `.env` or filesystem** in `spaces.py` — only catalog SQLite updates and per-space SQLite via `connect_sqlite_for_space` (`spaces.py:150-154`)

### Space creation / deletion

- **Create** `create_space` (`spaces.py:949-1025`): validates name (`spaces.py:916-924`), labels against shared sequences (`spaces.py:397-414`, `981-984`), expands label closure (`spaces.py:443-513`), inserts catalog row
- **Update** `update_space` (`spaces.py:1069-1178`): rename recomputes id + env-key columns; does not migrate DB files or `.env`
- **Delete** `delete_space` (`spaces.py:1181-1195`): **only** `DELETE FROM spaces WHERE id = ?` — **no cascade** of `space_members`, `space_roles`, `events`, `agent_keys`, or data files

### Filesystem writes

- Per-space `entities` schema ensured on connect (`spaces.py:106-136`)
- Catalog `spaces.labels` / `groups` updates (`spaces.py:528-567`, etc.)
- No `.env` mutation

---

## 4. Scheduler (`scheduler.py`) & Triggers (`triggers.py`)

### Background job model

- In-process `Scheduler` singleton (`scheduler.py:161-231`)
- Started on app lifespan (`scheduler.py:210-216`)
- Loop: `asyncio.to_thread(_tick)` (`scheduler.py:191-204`) — blocking work off event loop

### What runs on a schedule

- Enabled events with `type == "time"` (`scheduler.py:107-112`)
- On fire: `event["sequences"]` (`scheduler.py:81-87`)
- On missed timer at startup: `recovery_sequences` (`scheduler.py:115-129`, trigger `"recovery"`)

Pipeline per sequence (`scheduler.py:59-68`):

```59:68:Engine/server/scheduler.py
def _run_one_sequence(...):
    composed = execution.compose_and_store(space_id, seq_id)
    ...
    execution.run_execution(
        space_id, state_id, dict(params or {}), trigger=trigger, event_id=event_id
    )
```

Note: **no `principal_id`** — audit records NULL principal (`execution.py:746-747`, `791-797`).

### Auth context

- **No authentication** — trusted server-side scheduler
- Event CRUD requires `require_space_manage` (`app.py:715`, `766`)
- **Listing events** only requires `require_space_access` (`app.py:686`) — any member can read schedules and sequence IDs

### Failure handling

- Per-sequence failures caught (`scheduler.py:86-91`) — stderr log, other sequences continue
- Startup recovery / tick errors logged (`scheduler.py:176-177`, `196-198`)
- Failed compose: early return if no `state_id` (`scheduler.py:63-65`)

### Timezone handling (`triggers.py`)

- `_package_zone` (`triggers.py:51-62`): IANA via `zoneinfo`; invalid → UTC
- `evaluate_package` / `next_activation` evaluate rules in package timezone (`triggers.py:193-209`, `212-244`)
- UTC storage for `next_fire_at` / `last_fired_at` (`scheduler.py:39-56`, `98-104`)
- Event upsert validates timezone in `app.py:723-725`

---

## 5. Schema delete (`schema_delete.py`) & Step delete (`step_delete.py`)

### Purpose

| Module | Deletes | Stores touched |
|--------|---------|----------------|
| `schema_delete` | SCHEMA + instances + dependent queries/sequences/steps/state | Neo4j, per-space `entities`, catalog `queries`/`state`, `spaces.labels` |
| `step_delete` | STEP + dependent sequences/state | Same pattern, narrower blast radius |

Both: **preview** (read-only) + **execute** requiring `confirm=True`.

### Modes

- **purge** — physical delete when no other non-private space references labels (`schema_delete.py:268-273`, `step_delete.py:127-132`)
- **unlink** — only `spaces.remove_space_attributive_labels` (`schema_delete.py:459-465`, `step_delete.py:282-288`)

### Cascade-delete risks

**High (operational):**
- **Purge** deletes catalog `queries` and `state` rows globally by id (`schema_delete.py:405-423`, `step_delete.py:231-247`) — correct for shared catalog but irreversible
- **Shared public graph:** purge affects all spaces on same Neo4j store, not only requesting space
- **Unlink** leaves data in shared stores; other spaces keep access (warned in `_build_warnings`)

**Medium:**
- State detection uses substring `token in package` on JSON string (`schema_delete.py:276-282`, `step_delete.py:135-140`) — possible false positives, unlikely false negatives

### Raw query construction

- Cypher: parameterized `$al` / `$attributive_label` (`schema_delete.py:77-127`, `375-385`; `step_delete.py:48-60`, `203-208`)
- SQL deletes: `IN ({placeholders})` with bound id lists (`schema_delete.py:388-395`, `405-420`; `step_delete.py:214-244`) — ids from prior queries, not user strings
- Dynamic `node_label_col` in SELECT (`schema_delete.py:145-146`) — value is `'STEP'` from `entities_node_label_column`, not user input

---

## 6. Clerk API (`clerk_api.py`)

### API calls

Single endpoint: **`GET {CLERK_API_BASE}/users/{clerk_user_id}`** (`clerk_api.py:69-74`)

Used by:
- `fetch_identity` (`clerk_api.py:59-83`)
- `enrich_missing_identities` (`clerk_api.py:86-127`) — batch backfill

### Secret key handling

- Read from `config.clerk_secret_key()` → `CLERK_SECRET_KEY` env (`clerk_api.py:66-67`; `config.py:121-127`)
- Sent as `Authorization: Bearer {secret}` (`clerk_api.py:73`)
- If unset: returns `None` / no-op (`clerk_api.py:67-68`, `92-93`)
- **Not logged** on success; non-200 returns `None` without body logging (`clerk_api.py:76-77`)

### Error handling

- `httpx.HTTPError`, `ValueError` → `None` (`clerk_api.py:79-80`)
- `sqlite3.OperationalError` in enrich → `0` (`clerk_api.py:102-103`)
- Graceful degradation documented (`clerk_api.py:13-14`)

---

## 7. Brief: `migrations.py`, `ui_build.py`, `id_generator.py`

### `migrations.py`

- `run_startup_migrations` (`migrations.py:49-61`): ordered DDL from `Engine/schema/*.sql`, then `spaces.ensure_catalog_space_schema`, then `rbac.ensure_rbac_schema`
- Idempotent (`IF NOT EXISTS` / additive `ALTER`)
- Per-space `entities` **not** migrated here (`migrations.py:15-16`)

### `ui_build.py`

- `warn_if_ui_distale` (`ui_build.py:8-32`): compares `App/ui/src` vs `dist` mtimes at startup; prints warnings only — no security impact

### `id_generator.py`

- `generate_id()` → `ID_{uuid4.hex}` (`id_generator.py:29-31`)
- Used for RBAC rows, members, etc. — unpredictable, no sequential leakage

---

## 8. Cross-cutting: logging, swallowed exceptions, TODOs, broken code

### TODO / FIXME

**None** in `Engine/server/*.py` (repo-wide grep in that tree).

### Sensitive data logging

- Passwords: not exposed in `space_connections_payload` (`spaces.py:1263`)
- Clerk secret: not logged
- stderr errors often include **exception messages** and ids (`scheduler.py:89-90`, `app.py` various `*-error: {e}`) — may leak internal paths/Neo4j errors to server logs, not to clients
- JWT verification errors return `detail=f"Invalid authentication token: {e}"` to client (`auth.py:108-110`) — minor information disclosure

### Notable swallowed / broad exceptions

| Location | Behavior |
|----------|----------|
| `execution.py:153-154` | Neo4j adjacency load → empty dict |
| `execution.py:384-385`, `798-799`, `880-881` | Cleanup/audit failures → stderr only |
| `execution.py:608-609` | HTTP error body read failure → empty |
| `scheduler.py:86-91` | Sequence failure isolated |
| `spaces.py:475-478` | Neo4j unavailable during label closure → skip expansion |
| `clerk_api.py:79-80` | Clerk failure → silent `None` |
| `triggers.py:60-61` | Invalid timezone → UTC |

### Obviously risky / beta gaps (summary)

1. **`role_id` cross-space + owner promotion** (RBAC) — see §1  
2. **`delete_space` orphan data** — members, roles, events, keys, Neo4j/SQLite files remain (`spaces.py:1181-1195`)  
3. **Scheduler runs without RBAC/principal** — by design; anyone with `manage_space` can schedule arbitrary `runtime_enabled` sequences  
4. **Nested operation steps skip `runtime_enabled` at execute** (`execution.py:489-514`)  
5. **Path traversal via `.env` paths** if env is compromised (`config.py:84-88`)  
6. **`auth.py` module docstring outdated** — still describes binary member model (`auth.py:12-14`) while RBAC is hybrid  
7. **`_columns` PRAGMA** (`rbac.py:171-172`) — `table` is internal-only today; would be unsafe if ever user-controlled  

---

## HTTP guard quick-reference (for beta testers)

| Action | Guard | File:line |
|--------|-------|-----------|
| Space access | `require_space_access` | `auth.py:453-469` |
| Flow CRUD | `require_flow` | `auth.py:484-496` |
| Run sequence | `require_sequence_run` | `auth.py:499-511` |
| Manage space / members / roles / events | `require_space_manage` | `auth.py:514-524` |
| Create space | `require_can_create_spaces` | `auth.py:527-534` |
| Instance principals | `require_instance_admin` | `app.py:517`, `527` |

**Owner and superadmin bypass** all flow/sequence checks; **manage** requires `manage_space` (or superadmin), not merely ownership — but owners always have `manage_space` via `admin_permissions()`.