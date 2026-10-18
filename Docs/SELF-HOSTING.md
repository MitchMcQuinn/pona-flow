# Self-hosting pona flow

Run your own pona flow instance with Docker. One container for the app, one for Neo4j,
your data in two named volumes. Ten minutes from nothing to a signed-in dashboard.

> **Editions:** Community = this Docker / local path. Prefer Fly.io + Aura with a guided
> script? Use the [terminal installer](https://mitchmcquinn.github.io/pona-flow/wizard.html)
> (`scripts/fly-setup.sh`).
> Hosted (we run it) is coming soon.

---

## Requirements

| What | Notes |
|------|-------|
| **Docker** with Compose v2 | Docker Desktop (macOS/Windows) or Docker Engine 24+ (Linux). `docker compose version` should print 2.24 or newer. |
| **2 GB RAM free** | Neo4j is tuned to 512 MB heap + 256 MB page cache by default; the app itself is small. |
| **A port** | `8765` on the machine (configurable). |

No Python, Node, or Neo4j install is needed on the host.

---

## Quickstart (local machine)

```bash
# 1. Grab the compose bundle (no clone needed)
curl -fsSL https://github.com/MitchMcQuinn/pona-flow/releases/latest/download/pona-flow-selfhost.tar.gz | tar xz
cd pona-flow-selfhost

# 2. Configure: set NEO4J_PASSWORD (8+ characters). Everything else has a working default.
cp .env.docker.example .env
$EDITOR .env

# 3. Start
docker compose up -d

# 4. Create your admin account
open http://localhost:8765        # Linux: xdg-open
```

The first page you see is **Set up pona flow**. The account you create there is the instance
admin. There is nothing else to configure: the app is already pointed at the bundled Neo4j.

> **Prefer a git clone?** `git clone https://github.com/MitchMcQuinn/pona-flow && cd pona-flow`
> then the same steps 2–4. Compose builds the image locally if you add `--build`.

### What you get

| URL | What |
|-----|------|
| `http://localhost:8765` | The dashboard (bound to `127.0.0.1` by default) |
| `http://localhost:8765/healthz` | Liveness; `?deep=1` also checks Neo4j |
| `http://localhost:7474` | Neo4j Browser for the bundled database (user `neo4j`, your `NEO4J_PASSWORD`) |

### First things to do in the app

1. **Create a space.** The empty instance asks you to. A space is a working environment
   (a project, a client, a team); it uses the instance's Neo4j connection by default.
2. **Invite a colleague** from the space's **Users** panel. They open the same URL, choose
   *Create an account*, and sign up with the invited email. (Anyone without an invite is
   turned away unless you set `PONA_FLOW_ALLOW_OPEN_SIGNUP=1`.)
3. **Build something.** [GETTING-STARTED.md](GETTING-STARTED.md) walks through the
   dashboard; [5-MINUTE-ARCHITECTURE.md](5-MINUTE-ARCHITECTURE.md) explains the model.
4. **Connect an agent.** The **Agents** panel mints an API key and shows the MCP URL
   (`/api/spaces/<id>/mcp`). See [MCP-GATEWAY.md](MCP-GATEWAY.md).

---

## Day-2 operations

### Upgrade

```bash
docker compose pull
docker compose up -d
```

Fly self-host (after `scripts/fly-setup.sh`):

```bash
fly deploy --app YOUR_APP --image ghcr.io/mitchmcquinn/pona-flow:main
```

Every push to `main` publishes that tag. Instance admins can also open the gear menu →
**Update to latest main** when `FLY_API_TOKEN` was saved at setup (or later in that menu).

Catalog schema migrations run automatically at startup. Your data is in the `pona-data`
and `neo4j-data` volumes and is untouched by image upgrades. Pin a version with
`PONA_FLOW_VERSION=0.1.0` in `.env` if you do not want `latest`.

### Back up

Everything the app owns is in two volumes:

| Volume | Contents |
|--------|----------|
| `pona-data` | `/data/data.db` (catalog: spaces, members, saved operations, run state, accounts), per-space SQLite files, and `/data/.env` (credential values entered in the UI) |
| `neo4j-data` | The graph |

```bash
docker compose stop
docker run --rm -v pona-flow_pona-data:/from -v "$PWD":/to alpine tar czf /to/pona-data.tgz -C /from .
docker run --rm -v pona-flow_neo4j-data:/from -v "$PWD":/to alpine tar czf /to/neo4j-data.tgz -C /from .
docker compose start
```

(Volume names are prefixed by the compose project name, `pona-flow` when you kept the
directory name; `docker volume ls` shows the exact names.) Restore is the reverse: stop,
extract into the volumes, start. The longer procedure, including a consistent Neo4j dump,
is in [OPERATOR-BACKUP.md](OPERATOR-BACKUP.md).

### Logs

```bash
docker compose logs -f pona-flow
```

`PONA_FLOW_LOG_LEVEL=DEBUG` in `.env` for more. Error responses to the browser are generic
on purpose; the detail is in this log.

### Reset an account password

```bash
docker compose exec pona-flow python tools/reset_password.py you@example.com
```

Prompts for a new password and signs that user out everywhere. `--list` shows accounts,
`--make-admin` grants instance admin.

---

## Putting it on the internet

The default compose file binds the app to `127.0.0.1` so nothing is exposed until you
choose how. Two common options:

### Option A: built-in Caddy (automatic HTTPS)

Point a DNS A/AAAA record at the machine, open ports 80 and 443, then in `.env`:

```bash
COMPOSE_PROFILES=neo4j,https
PONA_FLOW_DOMAIN=flow.example.com
PONA_FLOW_PUBLIC_URL=https://flow.example.com
```

```bash
docker compose up -d
```

Caddy obtains a Let's Encrypt certificate and proxies to the app. The app sees
`X-Forwarded-Proto: https` and issues `Secure` cookies.

### Option B: your own reverse proxy / tunnel

nginx, Traefik, a Cloudflare Tunnel, Tailscale Serve, anything that forwards HTTP to
`127.0.0.1:8765` works. Set `PONA_FLOW_PUBLIC_URL` to the public URL and make sure the
proxy sends `X-Forwarded-Proto`. That is the only requirement. The app sets baseline
security headers itself; add CSP or rate limiting at the proxy if you want them.

Operator-level detail (secrets, SSRF controls, the admin surface, Clerk as an
alternative login provider): [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Using your own Neo4j

Remove `neo4j` from `COMPOSE_PROFILES` and set the connection:

```bash
COMPOSE_PROFILES=
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io     # Aura
NEO4J_USER=neo4j
NEO4J_PASSWORD=...
```

For Neo4j Desktop on the same machine use `NEO4J_URI=bolt://host.docker.internal:7687`.
Vector search needs Neo4j 5.18+ (or 2025.x). Per-space databases are configured later in
the UI; the instance connection above is the default every new space inherits.

---

## Without Docker

The image is a convenience, not a requirement. The app is a Python/uvicorn process plus a
static React build:

```bash
git clone https://github.com/MitchMcQuinn/pona-flow && cd pona-flow
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
(cd App/ui && npm ci && npm run build)
cp .env.example .env            # set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD
.venv/bin/python Engine/dev_server.py      # http://127.0.0.1:8765
```

For a service, run `uvicorn server.app:app --host 127.0.0.1 --port 8765 --app-dir Engine
--proxy-headers` under systemd with `PONA_FLOW_DATA_DIR` pointing at a writable directory.
Keep it to **one worker**: the event scheduler and MCP session manager live in-process.
Developer workflow (live-reloading UI, tests): [FIRST-TIME-SETUP.md](FIRST-TIME-SETUP.md).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Set NEO4J_PASSWORD in .env` when running `docker compose` | Copy `.env.docker.example` to `.env` and set the password (8+ characters). |
| `/healthz?deep=1` says `neo4j unreachable or credentials rejected` | Neo4j is still starting (give it ~40 s on first boot), or `NEO4J_URI` / password is wrong. `docker compose logs neo4j`. |
| Setup page never appears, login page does | An account already exists in this volume. Use `tools/reset_password.py --list` / reset, or remove the `pona-data` volume to start over. |
| Browser says cookies are blocked / keep getting signed out over HTTPS | The proxy is not sending `X-Forwarded-Proto: https`, or `PONA_FLOW_PUBLIC_URL` is unset. |
| `Sign-up is by invitation` | Have a space admin invite the email from the Users panel, or set `PONA_FLOW_ALLOW_OPEN_SIGNUP=1`. |
| MCP client gets 421 / Host errors | `PONA_FLOW_PUBLIC_URL` (or `PONA_FLOW_MCP_ALLOWED_HOSTS`) must include the hostname the client connects to. |
| Port 8765 already in use | `PONA_FLOW_PORT=9000` in `.env`. |

Still stuck? Open an issue: <https://github.com/MitchMcQuinn/pona-flow/issues>.
