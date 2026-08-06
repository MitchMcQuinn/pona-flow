# pona flow React UI Scaffold

This folder contains the new React-based dashboard scaffold for the STEP sequence workflow.

## Run

The React builder does **not** hot-reload through `python Engine/dev_server.py` alone. Pick one:

### Live development (recommended)

1. Start the API: `python Engine/dev_server.py` (port **8765**)
2. In this folder: `npm install` then `npm run dev`
3. Open **`http://127.0.0.1:5173`** — edits to `src/` apply immediately

Vite proxies `/api/*` to `http://127.0.0.1:8765`.

### Built UI via Python (same port as the API)

After changing `src/`, run **`npm run build`** in `App/ui`, then open:

**`http://127.0.0.1:8765/App/ui/dist/index.html`**

Restarting only the Python server serves the previous `dist/` bundle until you rebuild.

While iterating on UI with the Python server, you can run **`npm run build:watch`** in `App/ui` to rebuild `dist/` automatically on save.

The Builder header shows a **build timestamp** — confirm it updates after `npm run build`.

## Implemented foundation

- Three-panel dashboard + top bar
- Formal app state via reducer and typed events
- Deterministic right-panel mode priority:
  - inspect -> params -> builder
- Run button guards:
  - sequence selected
  - params valid
  - not already running

## Update INSTANCE: SET value modes

When you author an **update INSTANCE** operation, each SET assignment has a **mode** that controls how the right-hand side is written. The compiled Cypher always stores a single `expression` string; the mode is a builder hint so the row round-trips correctly in the UI.

### Value (literal / `$parameter`)

The default. Type a concrete value or an exact `$parameter` reference. Use this when the new property value is known at author time or supplied by the caller.

| Use case | Example assignment |
|----------|--------------------|
| Flip a flag from a parameter | `n.IS_COMPLETE = $actionIsComplete` |
| Hard-code a status | `n.STATUS = 'archived'` |
| Rename from form input | `n.NAME = $actionName` |

Composed Cypher looks like `n.NAME = $actionName` or `n.IS_COMPLETE = true`.

### Negate property (NOT)

Writes a **boolean** target from another in-scope boolean property: `(NOT coalesce(source.prop, false))`. Missing/`null` on the source is treated as `false`, so the result is `true`. Use this when completion or activation should be the inverse of a relationship or sibling flag — especially when the source lives on a different alias than the target.

| Use case | Example assignment |
|----------|--------------------|
| Routine vs event on trigger | `t.IS_COMPLETE = (NOT coalesce(r.RESET_ON_EVENT, false))` — if `RESET_ON_EVENT` is true (routine), complete becomes false (reset); if false (one-shot event), complete becomes true |
| Invert an active flag | `n.IS_PAUSED = (NOT coalesce(n.IS_ACTIVE, false))` |

Only offered when the **target** property is boolean; the source picker lists boolean properties on MATCH aliases (variable-length relationship aliases are excluded — they bind a list, not a single relationship).

### Expression (free-form Cypher)

Paste any Cypher right-hand side. The builder does **not** type-check it; Neo4j validates at run time. Use this as an escape hatch for math, `coalesce`, functions, or anything the other modes do not cover.

| Use case | Example assignment |
|----------|--------------------|
| Increment a counter | `n.COUNT = coalesce(n.COUNT, 0) + 1` |
| Compose a label from fields | `n.LABEL = n.NAME + ' (' + n.CODE + ')'` |
| Conditional with `CASE` | `n.TIER = CASE WHEN n.SCORE >= 80 THEN 'A' ELSE 'B' END` |

There is also a **now (timestamp)** mode (not in the three above): for string properties it writes `toString(datetime())` — e.g. `n.LAST_MODIFIED = toString(datetime())` — so you do not need a free-form expression for “set to current time.”

### Choosing a mode quickly

1. **Value** — you know the literal or have a `$param`.
2. **Negate property** — the new boolean is the inverse of another boolean already in the MATCH.
3. **Expression** — anything else (arithmetic, `CASE`, multi-property formulas). Prefer **now** instead of expression when you only need a timestamp.

## Notes

- Sequence execution is fully wired: `src/services/api.ts` composes via `POST /api/sequence/compose` and runs via `POST /api/sequence/run` (including pending human-in-the-loop pauses).
- Existing pages in `/App/*.html` are unchanged and continue to work.
