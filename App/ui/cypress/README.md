# Schematago / pona flow — Cypress E2E

End-to-end tests for the React dashboard. Tests run against the **real stack**
(live Vite + FastAPI + Neo4j), with per-test isolation via `tools/dev_reset.py`
and programmatic Clerk sign-in. This document is the living **coverage matrix**
and the **selector (`data-testid`) convention** the specs are built on.

## Running locally

E2E requires three things running plus Clerk config:

1. API + Neo4j: `python Engine/dev_server.py` (port 8765, Neo4j reachable)
2. E2E Vite server: `cd App/ui && npm run dev:e2e` (port 5173 — **not** `npm run dev`)
3. Root `.env` with `CLERK_SECRET_KEY` + `SUPERADMIN_EMAIL`, and
   `App/ui/cypress.env.json` with `CLERK_TEST_IDENTIFIER` (copy from `cypress.env.example`)

Then:

```bash
cd App/ui
npm run test:e2e:preflight   # verifies API, Vite, Clerk env
npm run test:e2e             # headless run
npm run cy:open              # interactive
```

Every spec gets a clean slate: `cypress/support/e2e.ts` runs
`cy.resetDevState()` + `cy.signInAsTestUser()` in a global `beforeEach`.

## Architecture (what the tests drive)

- Single-page dashboard, **no URL router**. Views are state-driven
  (`builder`, `createSequence`, `sequence`, `event`, `createEvent`, `space`).
- Three resizable columns: Navigation, Visualization, Config (right panel).
- Core engine: the **builder** composes a Cypher `QueryObject` over the
  operation x label matrix; saved operations wrap STEP nodes; sequences chain
  STEPs and run with progressive (human-in-the-loop) parameters.

## Selector convention (`data-testid`)

Prefer `data-testid` for anything a test interacts with or asserts on. Existing
stable IDs (`#space-selector`, `#builder-operation-label`, `#event-name`, …) and
ARIA labels remain valid and are still used where they are already stable.

Format: `data-testid="<area>-<element>[-<qualifier>]"`, kebab-case.

| Area prefix | Used for |
|-------------|----------|
| `builder-` | builder toggles, run/save/create-operation buttons, picker |
| `nav-` | navigation panel: space selector, sequence/event items, group controls |
| `topbar-` | top bar run / back buttons |
| `modal-` | modal panels and their confirm/cancel buttons |
| `space-` | space-config tabs and admin panels |
| `event-` | event builder save/delete |
| `param-` | dynamic sequence run parameter inputs (`param-input-{name}`) |
| `graph-` | D3 graph nodes / relationships in the visualization panel |
| `result-` | result graph/table toggle and response view |

### Priority targets (rollout complete)

Builder toggles, primary action buttons, modal confirm/cancel, picker menus,
nav sequence/event items, space-admin tabs, dynamic param inputs, D3 graph
nodes/relationships (`GraphView.tsx`), and result-view toggles.

### Concrete testids in source

Builder (`components/builder/`):

- `builder-operation-toggle`, `builder-operation-toggle-option-{create|read|update|delete}`
- `builder-label-toggle`, `builder-label-toggle-option-{STEP|SCHEMA|INSTANCE}`
- `builder-picker-toggle`, `builder-picker-menu`
- `builder-run-btn`, `builder-create-operation-btn`, `builder-save-operation-btn`
- `builder-create-sequence-btn`
- `builder-sequence-name`
- `vector-search-section`, `vector-search-text`, `vector-search-k`,
  `vector-search-hint` (the toggles are the `#vector-search-toggle` and
  `#vector-search-all-labels-toggle` element ids, as elsewhere for `Toggle`).
  `vector-search-k` is a text input, not a number one, so it can hold `$topK`

Top bar: `topbar-run-btn`, `topbar-back-btn`

Navigation:

- `nav-add-sequence`, `nav-add-event`, `nav-create-space`, `nav-space-settings`
- `nav-sequence-item`, `nav-event-item`, `nav-add-group`

Modals:

- `modal-create-space`, `modal-create-operation`, `modal-sequence-delete`,
  `modal-delete-space`, `modal-schema-delete`, `modal-step-delete`,
  `modal-schema-update-suspend`, `modal-new-step-node`, `modal-agent-key`
- `modal-confirm-btn`, `modal-cancel-btn` (within each panel)

Space admin:

- `space-tab-settings`, `space-tab-users`, `space-tab-agents`,
  `space-tab-credentials`, `space-tab-embeddings`, `space-tab-templates`,
  `space-tab-audit`
- `space-settings-save-btn`, `space-delete-btn`
- `embeddings-url-input`, `embeddings-model-input`, `embeddings-save-btn`,
  `embeddings-check-btn`, `embeddings-reindex-btn` (the enabled switch is the
  `#embeddings-enabled-toggle` element id, as elsewhere for `Toggle`)
- `template-select-sequences`, `template-select-operations`,
  `template-select-schemas`, `template-select-events`, `template-resolve-btn`,
  `template-export-summary`, `template-export-btn` (download)
- `template-import-file`, `template-import-btn`, `template-import-result`,
  `template-rename-<conflict-id>`, `template-credentials-needed`

Events: `event-save-btn`, `event-delete-btn`

Graph (`components/results/GraphView.tsx`):

- `graph-view-container`
- `graph-node-{group}-{label-slug}` — e.g. `graph-node-step-read_person`
- `graph-rel-{label-slug}` — relationship hit targets

Result view (`components/results/ResultView.tsx`):

- `result-toggle-graph`, `result-toggle-table`, `result-table`, `result-response`

Params panel (`components/ConfigPanel.tsx`):

- `param-input-{name}` — wrapper around each run-time parameter input

## Custom commands

Reusable flows live in `cypress/support/commands/`. Specs should stay
declarative and lean on these (see `e2e/journeys/golden-path.cy.ts`). Shared
fixtures are in `cypress/support/constants.ts`.

| File | Commands |
|------|----------|
| `auth.ts` | `resetDevState`, `signInAsTestUser` |
| `space.ts` | `createSpace`, `bootstrapApp`, `openSpaceTab`, `inviteMember`, `createAgentKey`, `upsertCredential` |
| `builder.ts` | operation/label segment, attributive-label picker, schema props, `runBuilderCreate`, `createSchemaNode` |
| `instance.ts` | `createInstanceNode` |
| `operation.ts` | `configureReadInstanceMatch`, `configureReadInstanceParamFilter`, `saveBuilderOperation` |
| `sequence.ts` | `openSequenceCreator`, `createSequenceFromStep`, `selectSequenceInNav`, `selectSingleStepInNav`, `runSelectedSequence` |
| `update.ts` | `updateInstanceMatch`, `setInstanceProperty`, `addSchemaPropertyUpdate`, `confirmSchemaUpdate` |
| `delete.ts` | `deleteSchema`, `deleteStep` |
| `nav.ts` | `editSequenceInNav`, `editSingleStepInNav`, `deleteSequenceInNav`, `deleteSingleStepInNav`, `addNavGroup`, `openSpaceSettings` |
| `event.ts` | `openEventCreator`, `fillTimeEvent`, `fillExternalEvent`, `saveEvent`, `deleteEventInNav` |
| `run.ts` | `triggerSequenceRun`, `fillSequenceParam`, `expectAwaitingParams`, `expectRunSuccess` |
| `graph.ts` | `clickGraphNode`, `clickGraphRelationship`, `expectGraphNodeAffected` |

## Spec layout

```
cypress/e2e/
  auth/           bootstrap, permissions
  builder/        operation x label matrix
  sequence/       lifecycle, HITL, nav groups, cascade delete
  events/         time + external webhook triggers
  space/          admin tabs, delete space
  visualization/  design graph, result view, suspended highlighting
  journeys/       multi-feature golden paths
  schema/         legacy create-person (also covered under builder/)
```

## Coverage matrix

Status legend: [x] covered by a spec, [~] partial / blocked, [ ] not yet covered.

### Auth & bootstrap (`e2e/auth/`)

- [x] Clerk sign-in + E2E auth shell (`bootstrap.cy.ts`)
- [x] First-space create modal (`bootstrap.cy.ts`)
- [x] Superadmin sees all space-admin tabs (`permissions.cy.ts`)
- [x] Fully-permissioned user has all builder operations enabled (`permissions.cy.ts`)
- [~] No-access screen + auto sign-out — needs second Clerk identity (`permissions.cy.ts` skip)
- [~] Permission-gated builder operations disabled — needs restricted role (`permissions.cy.ts` skip)
- [~] Space-admin tab visibility for non-owner — needs member identity (`permissions.cy.ts` skip)

### Builder operation x label (`e2e/builder/`)

- [x] create / SCHEMA (`schema/create-person.cy.ts`, `create-instance.cy.ts` prerequisite)
- [x] create / INSTANCE (`create-instance.cy.ts`)
- [x] read / INSTANCE + save operation (`read-query.cy.ts`, golden path)
- [x] read / SCHEMA (`read-schema.cy.ts`)
- [x] read / STEP (`read-step.cy.ts`)
- [x] update / INSTANCE SET (`update-instance.cy.ts`)
- [x] update / SCHEMA + suspension preview (`update-schema.cy.ts`, `journeys/schema-update.cy.ts`)
- [x] delete / SCHEMA cascade (`delete-schema.cy.ts`)
- [x] delete / STEP cascade (`delete-step.cy.ts`)
- [x] edit saved operation (locked toggles, Save operation) (`edit-operation.cy.ts`)

### Sequence lifecycle (`e2e/sequence/`)

- [x] create from STEP + run (golden path)
- [x] edit description metadata (`lifecycle.cy.ts`)
- [x] edit from nav → Save sequence (`lifecycle.cy.ts`)
- [x] edit from graph click → operation edit deep link (`edit-from-graph.cy.ts`)
- [~] reorder sequences / groups — needs DnD helper (`nav-groups.cy.ts` skip)
- [x] delete nav-only (`lifecycle.cy.ts`)
- [x] delete cascade (`delete-cascade.cy.ts`)
- [x] human-in-the-loop run (`human-in-the-loop.cy.ts`)
- [x] suspended sequence blocks run + red highlight (`visualization/suspended-sequence.cy.ts`)

### Events (`e2e/events/`)

- [x] create time trigger (`time-event.cy.ts`)
- [x] edit time event name (`time-event.cy.ts`)
- [x] delete time event (`time-event.cy.ts`)
- [x] create external webhook (secret, filter, ingest URL) (`external-event.cy.ts`)
- [~] assign recovery sequences — not yet isolated (partial via `journeys/event-driven.cy.ts`)
- [~] enable/disable toggle — not yet isolated

### Space administration (`e2e/space/`)

- [x] settings: edit description + save (`admin.cy.ts`)
- [x] users: invite member (`admin.cy.ts`)
- [x] agents: create API key (`admin.cy.ts`)
- [x] credentials: upsert `$secret.NAME` (`admin.cy.ts`)
- [x] audit log: refresh + empty/list state (`admin.cy.ts`)
- [x] delete space (`delete-space.cy.ts`)
- [~] permission matrix editing — not yet isolated (superadmin-only E2E user today)

### Visualization & deep links (`e2e/visualization/`)

- [x] design graph render for selected sequence (`design-graph.cy.ts`)
- [x] graph STEP click → builder edit (`design-graph.cy.ts`)
- [x] result graph + table toggle after run (`result-view.cy.ts`)
- [x] suspended sequence red highlighting (`suspended-sequence.cy.ts`)
- [~] inspect panel (read-only payload) from graph element — not yet covered
- [~] custom-endpoint HTTP response view — needs custom-endpoint STEP command (`design-graph.cy.ts` skip)

### Journeys (`e2e/journeys/`)

- [x] golden path: schema → instance → operation → sequence → run (`golden-path.cy.ts`)
- [x] schema update with dependent operation (`schema-update.cy.ts`)
- [x] event-driven: sequence + time event + manual run (`event-driven.cy.ts`)

## Deferred

- **CI workflow** (GitHub Actions booting API + Neo4j + Vite e2e) — revisit before beta.
- **Second Clerk test identity** — unlocks negative auth/permission cases.
- **DnD plugin** — unlocks sequence/group reorder spec.
- **Custom-endpoint STEP command** — unlocks HTTP response visualization spec.

## Validation

Each phase runs green locally via `npm run test:e2e` after `npm run dev:e2e` + API on :8765 + Neo4j, with `npm run test:e2e:preflight` confirming env.
