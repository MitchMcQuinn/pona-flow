# Changelog

All notable changes to pona flow. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Phones and tablets**: on phones the app shows one screen at a time — Menu, Workbench,
  or Map — switched from a bottom tab bar, and follows you to the right one (pick a
  sequence → Workbench; a finished run → Map). On tablets the menu slides out from the
  ☰ button. Larger tap targets, always-visible row actions, a **Reorder** mode with
  up/down buttons in place of drag-and-drop, pinch-to-zoom, **Fit** and **Link dots**
  controls on graphs, bottom-sheet dialogs, and side-scrolling tables. The product tour
  adapts too: on phones it switches screens for you and its card swipes between steps.
  The desktop layout is unchanged; the new graph buttons (zoom, Fit, Link dots) appear
  there too.
- **Product tour**: a plain-language walkthrough (spaces, types and records, sequences,
  events, the workbench, the map, running, account) that starts on a person's first visit
  once a space exists. It can be skipped, and replayed from **Space settings → Take the
  product tour**. Completion is stored per account (`users.onboarding_tour_seen`, exposed on
  `/api/me`, set via `POST /api/me/onboarding`).
- Repository licensed under **AGPL-3.0-only** (`LICENSE`); README documents contribution /
  CLA intent for a future hosted product.
- Product editions: **Community** (GitHub/Docker), **Self-hosted** (Fly+Aura wizard on
  GitHub Pages), **Hosted** (paid, coming soon). No shared public sandbox.
- [`fly.toml`](fly.toml) is a per-customer template; client-side
  [wizard](https://mitchmcquinn.github.io/pona-flow/wizard.html) generates deploy commands
  without uploading secrets.
- `PONA_FLOW_SIGNUP_CAN_CREATE_SPACES` for optional open sign-up deployments.
- Terminal installer [`scripts/fly-setup.sh`](scripts/fly-setup.sh) replaces the
  browser form: prompts for Aura / Fly / auth / optional deploy token, then deploys
  `ghcr.io/mitchmcquinn/pona-flow:main`.
- Every push to `main` publishes that image (with `PONA_FLOW_BUILD_SHA`). Instance
  admins see commits since the last deploy in the gear menu and can roll forward
  when `FLY_API_TOKEN` is set.

## [0.1.0] - 2026-10-14

First public, self-hostable release.

### Added

- **Built-in accounts** (`PONA_FLOW_AUTH_MODE=local`, the default): first-run setup page
  creates the instance admin; email/password sign-in with scrypt hashing, hashed cookie
  sessions, same-origin enforcement on unsafe requests, and login throttling. Sign-up is
  invitation-gated (`PONA_FLOW_ALLOW_OPEN_SIGNUP=1` to open it). `tools/reset_password.py`
  for recovery. Clerk remains available as `PONA_FLOW_AUTH_MODE=clerk`.
- **Docker image** (`ghcr.io/mitchmcquinn/pona-flow`) and **`docker-compose.yml`** with a
  bundled Neo4j (`neo4j` profile) and optional automatic-TLS Caddy (`https` profile);
  `.env.docker.example` needs only `NEO4J_PASSWORD`.
- `PONA_FLOW_DATA_DIR`: one directory for the catalog, per-space SQLite files, and the
  credential `.env` (the image uses `/data`).
- `GET /healthz` (and `?deep=1` for Neo4j) for orchestrators and first-boot checks.
- Baseline security headers; HSTS when served over HTTPS.
- `PONA_FLOW_PUBLIC_URL` drives Secure cookies and MCP gateway Host validation.
- CI (tests, UI build, image build + smoke test) and a tag-triggered release workflow that
  pushes multi-arch images to GHCR and attaches a self-host bundle to the GitHub release.
- `Docs/SELF-HOSTING.md` quickstart; `README`, `DEPLOYMENT`, `FIRST-TIME-SETUP`, and
  `GETTING-STARTED` rewritten around self-hosting.

### Changed

- The UI discovers the auth provider at runtime from `/api/auth/status`; no Vite build-time
  auth variables are needed.
- Error responses are generic by default; exception detail goes to the server log
  (`PONA_FLOW_DEBUG_ERRORS=1` restores the old behaviour for local development).
- `PONA_FLOW_HOST` / `PONA_FLOW_PORT` replace `FORM_BRIDGE_HOST` / `FORM_BRIDGE_PORT`
  (the old names still work).
- Instance-admin status is stored on the user row; the first human user on an empty
  instance is bootstrapped as admin in both auth modes.
- `PONA_FLOW_DISABLE_AUTH` and `DEV_DB_EDITOR_TOKEN` are refused unless the server binds to
  loopback.

### Fixed

- Fresh catalogs lacked the `spaces` table DDL and failed on first `/api/spaces` call.
- `App/ui/package-lock.json` was out of sync with `package.json`, breaking `npm ci` on
  new machines.
- The built UI's hashed assets are now served at `/assets/*` when the app is opened at `/`.

[Unreleased]: https://github.com/MitchMcQuinn/pona-flow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MitchMcQuinn/pona-flow/releases/tag/v0.1.0
