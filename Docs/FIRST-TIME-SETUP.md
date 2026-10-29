# First-time local setup (developers)

Checklist for cloning this repo and running a **local development instance** on your
machine. Follow the steps in order; you can stop after “Verify it works” and come back
for optional pieces later.

| Audience | Doc |
|----------|-----|
| You (developer working on the source) | **This file** |
| Someone who just wants to run it | [SELF-HOSTING.md](SELF-HOSTING.md) (Docker, no toolchain needed) |
| Non-technical end users of an instance | [GETTING-STARTED.md](GETTING-STARTED.md) |
| Production / proxy / secrets | [DEPLOYMENT.md](DEPLOYMENT.md) |

---

## Prerequisites

Install these before cloning (or as you hit each step):

| Tool | Notes |
|------|--------|
| **Git** | Clone the repo |
| **Python 3** | 3.11+ recommended. On macOS Homebrew, do **not** `pip install` globally — use a venv (below). |
| **Node.js + npm** | Needed for the React UI (`App/ui`). Current LTS is fine. |
| **Neo4j** | Local DB reachable at `bolt://localhost:7687` (Neo4j Desktop, or `docker compose up -d neo4j` from this repo with `NEO4J_PASSWORD` set in `.env`). Remember the password. |

No third-party sign-in service is needed: accounts are built in. Clerk is optional
(see Auth below).

Optional later: Ollama for local vector search, or a Gemini API key for a cloud embedding model ([README.md § Vector search](../README.md#vector-search)).

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
NEO4J_PASSWORD=<your-neo4j-password>
```

That is the only required block. The catalog lives at `data.db` in the repo root
(gitignored); set `PONA_FLOW_DATA_DIR=./data` if you prefer all runtime files in one
folder. Catalog schema is applied automatically at server startup (see
[DEPLOYMENT.md](DEPLOYMENT.md) § Migrations); you do **not** run the SQL under
`Engine/schema/` by hand.

**Credentials tab:** `PONA_FLOW_CREDENTIAL_BACKEND=local` (the default in `.env.example`)
lets values entered in the UI persist to `.env`. `passthrough` makes it read-only.

### Frontend — `App/ui/.env` (optional)

Not needed for the default setup. The UI learns the auth mode from the server at runtime.
`App/ui/.env.example` documents the few Vite-only variables (dev proxy target, E2E).

---

## 4. Auth

The default is **built-in accounts** (`PONA_FLOW_AUTH_MODE=local`, nothing to configure).
The first time you open the app it shows a setup page; the account you create there is
the instance admin. Later accounts sign up with an email that a space admin has invited
from the Users panel, or anyone can if `PONA_FLOW_ALLOW_OPEN_SIGNUP=1`.

Forgot the password of a local account: `.venv/bin/python tools/reset_password.py you@example.com`.

### Alternative: Clerk

Set in project `.env`:

```bash
PONA_FLOW_AUTH_MODE=clerk
CLERK_ISSUER=https://your-app.clerk.accounts.dev
CLERK_PUBLISHABLE_KEY=pk_test_xxx
```

No UI rebuild is needed; the publishable key is served by `/api/auth/status`. The first
person to sign in on a fresh instance becomes the instance admin.

### Alternative: no auth at all (loopback only)

```bash
PONA_FLOW_DISABLE_AUTH=1
# PONA_FLOW_DEV_USER_EMAIL=dev@localhost
```

Every request acts as a synthetic admin. The server refuses to start with this set unless
it is bound to `127.0.0.1`, so it cannot leak into a deployment. Restart the dev server
after changing `.env`.

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
npm ci
cd ../..
```

(Root `package.json` only forwards scripts into `App/ui`; install under `App/ui`. `npm ci`
also downloads the Cypress binary; set `CYPRESS_INSTALL_BINARY=0` to skip it.)

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

Open **`http://127.0.0.1:5273`**. Vite proxies `/api/*` to port `8765`.

### Alternative: built UI on the API port

```bash
cd App/ui && npm run build
# then open:
# http://127.0.0.1:8765/
```

UI source changes are **not** picked up by the Python server until you rebuild (or use
`npm run build:watch` while iterating on the built bundle). Details: [App/ui/README.md](../App/ui/README.md).

---

## 8. Verify it works

1. Browser opens **Set up pona flow**; create the admin account (or you go straight in
   with the auth bypass; or Clerk's sign-in appears in Clerk mode).
2. Create a **space** when prompted (required on an empty / new membership view).
3. You should see the three-panel dashboard (nav / visualization / builder).
4. Optional smoke: `curl -s 'http://127.0.0.1:8765/healthz?deep=1'` should report
   `"status":"ok"` with Neo4j up; the catalog editor (instance admin) is at
   `http://127.0.0.1:8765/App/data-db-editor.html`.

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

Runs against Clerk mode with Clerk test credentials. See [App/ui/cypress/README.md](../App/ui/cypress/README.md):

- Copy `App/ui/cypress.env.example` → `App/ui/cypress.env.json`
- Set `CLERK_SECRET_KEY` in project `.env`
- Use `npm run dev:e2e` in `App/ui` (loads `.env.e2e`) so Clerk stays on localhost

---

## Quick command cheat sheet

```bash
# one-time
python3 -m venv .venv
source .venv/bin/activate && pip install -r requirements.txt
cp .env.example .env          # then set NEO4J_*
cd App/ui && npm ci && cd ../..

# every session
source .venv/bin/activate
python Engine/dev_server.py                 # terminal 1
cd App/ui && npm run dev                    # terminal 2 → http://127.0.0.1:5273
```

---

## Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| `pip` / `externally-managed-environment` | Use the project `.venv`; don’t install into system Python. |
| `command not found: uvicorn` | Activate venv, or use `.venv/bin/uvicorn` / `python Engine/dev_server.py`. |
| `AttributeError: ... no attribute 'list_tools'` on startup | `mcp` 2.x was installed; this repo needs 1.x. Re-run `pip install -r requirements.txt` (pins `mcp>=1.27,<2`). |
| `WARNING: App/ui/dist is missing` | Harmless if you use `npm run dev` on `:5273`. Only needed for the built UI on `:8765`. |
| API `401` after the UI loads | Your session cookie expired or the catalog was reset; reload to get the login page. In Clerk mode confirm `PONA_FLOW_AUTH_MODE=clerk` and `CLERK_ISSUER` are set. |
| Server refuses to start: "PONA_FLOW_DISABLE_AUTH ... loopback" | The bypass flags are only honoured when bound to `127.0.0.1`. Unset them or set `PONA_FLOW_HOST=127.0.0.1`. |
| Setup page does not appear, login does | An account already exists in this `data.db`. `tools/reset_password.py --list` shows it; `tools/dev_reset.py` wipes local data. |
| Clerk redirect breaks local / Cypress | Use `npm run dev:e2e` for E2E; plain `npm run dev` may send you to the hosted Account Portal. |
| Vite `http proxy error` / `ECONNREFUSED 127.0.0.1:8765` | The API isn’t running (or was restarted). Keep `python Engine/dev_server.py` up in another terminal, then refresh the UI. |
| Graph **500** / `Unable to retrieve routing information` | Start Neo4j Desktop DBMS; use `NEO4J_URI=bolt://127.0.0.1:7687` (not `neo4j://`); password must match Desktop. Restart the API after `.env` changes. |
| Graph / space DB errors | Neo4j not running, wrong URI scheme, or `NEO4J_PASSWORD` mismatch. |
| UI changes don’t show on `:8765` | Rebuild: `cd App/ui && npm run build`. Prefer `:5273` + `npm run dev` while coding. |
| Port already in use | Stop the other process on `8765` / `5273`, or change `PONA_FLOW_PORT` / Vite port. |

---

## Related docs

- [README.md](../README.md) — project overview, module map, and local vector search  
- [SELF-HOSTING.md](SELF-HOSTING.md) — run it with Docker instead  
- [DEPLOYMENT.md](DEPLOYMENT.md) — production checklist  
- [OPERATOR-BACKUP.md](OPERATOR-BACKUP.md) — backup and restore  
- [SEQUENCE-WEBHOOKS.md](SEQUENCE-WEBHOOKS.md) / [MCP-GATEWAY.md](MCP-GATEWAY.md) — agent surfaces after the app is up  
