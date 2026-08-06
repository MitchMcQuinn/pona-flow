# First-time local setup (developers)

Checklist for cloning this repo and running a **local development instance** on your
machine. Follow the steps in order; you can stop after “Verify it works” and come back
for optional pieces later.

| Audience | Doc |
|----------|-----|
| You (dev / operator spinning up the app locally) | **This file** |
| Non-technical end users of a hosted instance | [GETTING-STARTED.md](GETTING-STARTED.md) |
| Production / Cloudflare / secrets | [DEPLOYMENT.md](DEPLOYMENT.md) |

---

## Prerequisites

Install these before cloning (or as you hit each step):

| Tool | Notes |
|------|--------|
| **Git** | Clone the repo |
| **Python 3** | 3.11+ recommended. On macOS Homebrew, do **not** `pip install` globally — use a venv (below). |
| **Node.js + npm** | Needed for the React UI (`App/ui`). Current LTS is fine. |
| **Neo4j** | Local DB reachable at `bolt://localhost:7687` (Neo4j Desktop is the usual path). Remember the password you set when creating the DB. |
| **Clerk** (optional for day one) | Free Clerk development app if you want real sign-in. You can also bypass auth locally (see Auth below). |

Optional later: Docker (for the code runner images under `Engine/runner/`).

---

## 1. Clone and enter the project

```bash
git clone <your-remote-url> pona-flow
cd pona-flow
```

**Confirm you are in the repo root before continuing.** The prompt / cwd must be the
folder that *itself* contains these siblings (not a parent folder that merely wraps them):

```text
App/   Docs/   Engine/   requirements.txt   .env.example   README.md
```

Quick check:

```bash
pwd
ls requirements.txt    # must succeed — if "No such file", you are in the wrong directory
```

If your Cursor workspace is a parent folder (e.g. `pona-flow-engine/`) that contains a
nested `pona-flow/` clone, `cd` into that nested repo first:

```bash
cd pona-flow            # from the parent workspace, if needed
ls requirements.txt
```

All later steps assume this cwd. Creating `.venv` one level up will not see `requirements.txt`.

---

## 2. Python virtual environment

macOS Homebrew Python blocks global `pip install` (PEP 668). Always use a project venv
**inside the repo root from step 1** (the directory that has `requirements.txt`):

```bash
# typo watch: it is  python3 -m venv   (dash-m), not  python3 .m venv
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Activate the venv in **every new terminal** before running Python tools (from the same
repo root):

```bash
source .venv/bin/activate
```

Or call tools via `.venv/bin/python` / `.venv/bin/uvicorn` without activating.

If you accidentally created a `.venv` in a parent folder, you can ignore or delete that
one and create a fresh `.venv` here.

---

## 3. Environment files

### Backend — project root `.env`

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```bash
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<password-from-neo4j-desktop>

SQLITE_DATABASE_PATH=data.db
PONA_FLOW_CATALOG_SQLITE_KEY=SQLITE_DATABASE_PATH
```

`data.db` is local-only (gitignored). Catalog schema is applied automatically at server
startup (see [DEPLOYMENT.md](DEPLOYMENT.md) § Migrations). You do **not** need to run the
SQL files under `Engine/schema/` by hand for a normal first boot.

**Credentials tab (local writes to `.env`):** for day-to-day local work you usually want:

```bash
PONA_FLOW_CREDENTIAL_BACKEND=local
```

(Default is `passthrough`, which only reads `os.environ` and will not write secrets into
`.env` from the UI.)

### Frontend — `App/ui/.env`

Create this file (it is not committed). Minimum depends on your auth choice (next section).

```bash
# Create empty file, then add the lines from the auth path you choose:
touch App/ui/.env
```

---

## 4. Auth: pick one path

Every `/api/*` route requires auth unless you explicitly disable it.

### Path A — Local auth bypass (fastest for first boot)

You must set **both** flags. If only the UI flag is on, the browser sends no token and every
`/api/*` call returns **401 Unauthorized**.

In **project** `.env` (uncomment / add — do not leave this line commented):

```bash
PONA_FLOW_DISABLE_AUTH=1
# optional:
# PONA_FLOW_DEV_USER_EMAIL=dev@localhost
```

In **`App/ui/.env`**:

```bash
VITE_DISABLE_AUTH=true
```

Restart `python Engine/dev_server.py` after changing the project `.env` (env is loaded at
startup). Restart Vite after changing `App/ui/.env`.

This grants a synthetic superadmin on every API request. **Never** enable these flags on a
shared or production host.

You can leave `CLERK_ISSUER` as the placeholder while bypass is on.

### Path B — Real Clerk (closer to production)

1. Create a free Clerk development application.
2. In project `.env`, set the Frontend API URL as issuer:

   ```bash
   CLERK_ISSUER=https://your-app.clerk.accounts.dev
   ```

3. In `App/ui/.env`, set the publishable key:

   ```bash
   VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx
   ```

4. Do **not** set `PONA_FLOW_DISABLE_AUTH` / `VITE_DISABLE_AUTH`.

The **first person** to sign in on a fresh instance becomes the instance admin.

Full variable list: [.env.example](../.env.example). Operator notes: [DEPLOYMENT.md](DEPLOYMENT.md) § Authentication.

---

## 5. Start Neo4j

The UI and catalog API can look “up” while Neo4j is down — graph calls then fail with
**500** / `Unable to retrieve routing information`. Do this **before** relying on spaces
that use the graph:

1. Open **Neo4j Desktop** (or start your local Neo4j service).
2. Start the DBMS whose password matches `NEO4J_PASSWORD` in `.env`.
3. In `.env`, prefer a direct Bolt URI for Desktop (not the routing scheme):

   ```bash
   NEO4J_URI=bolt://127.0.0.1:7687
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=<password-from-neo4j-desktop>
   ```

   Use `bolt://…`, not `neo4j://…`, for a local single-instance DBMS. `neo4j://` asks the
   driver for cluster routing and often fails locally with “Unable to retrieve routing
   information.”
4. Confirm the port is open (while the DBMS is started):

   ```bash
   nc -z 127.0.0.1 7687 && echo "Neo4j port open"
   ```

Restart `python Engine/dev_server.py` after changing `NEO4J_*` in `.env`.

Spaces store **names** of env keys for Neo4j/SQLite, not the secrets themselves. If a
space-specific key is missing, the runtime falls back to `NEO4J_*` / `SQLITE_DATABASE_PATH`.
For a brand-new local instance, the shared defaults above are enough until you add
per-space overrides.

---

## 6. Install UI dependencies

```bash
cd App/ui
npm install
cd ../..
```

(Root `package.json` only forwards scripts into `App/ui`; install under `App/ui`.)

---

## 7. Run the stack (two terminals)

**Terminal 1 — API** (venv activated):

```bash
source .venv/bin/activate
python Engine/dev_server.py
```

Default bind: `http://127.0.0.1:8765`.

**Terminal 2 — React (live reload, recommended):**

```bash
cd App/ui
npm run dev
```

Open **`http://127.0.0.1:5173`**. Vite proxies `/api/*` to port `8765`.

### Alternative: built UI on the API port

```bash
cd App/ui && npm run build
# then open:
# http://127.0.0.1:8765/App/ui/dist/index.html
```

UI source changes are **not** picked up by the Python server until you rebuild (or use
`npm run build:watch` while iterating on the built bundle). Details: [App/ui/README.md](../App/ui/README.md).

---

## 8. Verify it works

1. Browser opens the sign-in screen (Clerk) **or** goes straight in (auth bypass).
2. Create a **space** when prompted (required on an empty / new membership view).
3. You should see the three-panel dashboard (nav / visualization / builder).
4. Optional smoke: open the catalog editor (instance-admin / local bypass):
   `http://127.0.0.1:8765/App/data-db-editor.html`

If Neo4j is down, space/graph operations will fail even when the UI loads — start the DB
before expecting graph CRUD to work.

---

## 9. Optional follow-ups

### Seed system query primitives

Catalog migrations create tables automatically. To load starter system queries into an
empty or wiped catalog:

```bash
sqlite3 data.db < Engine/schema/queries-seed-system.sql
```

### Wipe local data (dev only)

Dry run, then confirm:

```bash
.venv/bin/python tools/dev_reset.py
.venv/bin/python tools/dev_reset.py --confirm
```

Irreversible. Never point this at real data. See the docstring in `tools/dev_reset.py`.

### Cypress E2E

Needs Clerk test credentials (not auth bypass). See [App/ui/cypress/README.md](../App/ui/cypress/README.md):

- Copy `App/ui/cypress.env.example` → `App/ui/cypress.env.json`
- Set `CLERK_SECRET_KEY` in project `.env`
- Use `npm run dev:e2e` in `App/ui` (loads `.env.e2e`) so Clerk stays on localhost

### Code runner (`Engine/runner/`)

Separate process / Docker images for sandboxed step execution. Not required for UI + API
first boot. See [Engine/runner/README.md](../Engine/runner/README.md).

---

## Quick command cheat sheet

```bash
# one-time
python3 -m venv .venv
source .venv/bin/activate && pip install -r requirements.txt
cp .env.example .env          # then edit Neo4j + auth
# create App/ui/.env          # VITE_DISABLE_AUTH=true  OR  VITE_CLERK_PUBLISHABLE_KEY=...
cd App/ui && npm install && cd ../..

# every session
source .venv/bin/activate
python Engine/dev_server.py                 # terminal 1
cd App/ui && npm run dev                    # terminal 2 → http://127.0.0.1:5173
```

---

## Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| `pip` / `externally-managed-environment` | Use the project `.venv`; don’t install into system Python. |
| `command not found: uvicorn` | Activate venv, or use `.venv/bin/uvicorn` / `python Engine/dev_server.py`. |
| `AttributeError: ... no attribute 'list_tools'` on startup | `mcp` 2.x was installed; this repo needs 1.x. Re-run `pip install -r requirements.txt` (pins `mcp>=1.27,<2`). |
| `WARNING: App/ui/dist is missing` | Harmless if you use `npm run dev` on `:5173`. Only needed for the built UI on `:8765`. |
| API `401` / auth errors with UI open | Backend and UI auth modes must match (both bypass, or both Clerk). Restart Vite after changing `App/ui/.env`. |
| Clerk redirect breaks local / Cypress | Use `npm run dev:e2e` for E2E; plain `npm run dev` may send you to the hosted Account Portal. |
| Vite `http proxy error` / `ECONNREFUSED 127.0.0.1:8765` | The API isn’t running (or was restarted). Keep `python Engine/dev_server.py` up in another terminal, then refresh the UI. |
| Graph **500** / `Unable to retrieve routing information` | Start Neo4j Desktop DBMS; use `NEO4J_URI=bolt://127.0.0.1:7687` (not `neo4j://`); password must match Desktop. Restart the API after `.env` changes. |
| Graph / space DB errors | Neo4j not running, wrong URI scheme, or `NEO4J_PASSWORD` mismatch. |
| UI changes don’t show on `:8765` | Rebuild: `cd App/ui && npm run build`. Prefer `:5173` + `npm run dev` while coding. |
| Port already in use | Stop the other process on `8765` / `5173`, or change `FORM_BRIDGE_PORT` / Vite port. |

---

## Related docs

- [README.md](../README.md) — project overview + module map  
- [DEPLOYMENT.md](DEPLOYMENT.md) — production checklist  
- [SECURITY-GUIDE.md](SECURITY-GUIDE.md) — auth model in plain language  
- [DECISIONS.md](DECISIONS.md) — why Clerk, single-tenant, credential backends, etc.  
- [SEQUENCE-WEBHOOKS.md](SEQUENCE-WEBHOOKS.md) / [MCP-GATEWAY.md](MCP-GATEWAY.md) — agent surfaces after the app is up  
