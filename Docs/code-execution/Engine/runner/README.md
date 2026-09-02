# Sandbox runner

A separate, low-privilege FastAPI service that executes code-execution STEP scripts in
disposable, hardened Docker containers. The main app (`Engine/server`) never executes
user code and never touches Docker — it only POSTs `{language, code, timeout_seconds,
space_id}` to this service over localhost HTTP and reads back a JSON envelope.

## Setup

1. Build the sandbox images (requires Docker):

   ```bash
   Engine/runner/images/build.sh
   ```

2. Set a shared secret in `.env` (used by both the main app and the runner):

   ```
   PONA_FLOW_RUNNER_TOKEN=<long random string>
   ```

3. Start the runner (as a separate process; in production use a dedicated
   unprivileged OS user — the main app's user must NOT have Docker access):

   ```bash
   python Engine/runner/dev_runner.py   # binds 127.0.0.1:8766
   ```

Health check: `GET /healthz` reports Docker availability and the kill-switch state.

## Sandbox profile (per execution)

One disposable container per execution (`docker run --rm -i`), with:

| Flag | Why |
| --- | --- |
| `--network none` | no network: blocks SSRF, metadata services, internal IPs, admin APIs |
| `--user 65534:65534` | non-root (also baked into the images) |
| `--read-only` + `--tmpfs /tmp:rw,noexec,nosuid,size=64m` | fresh, capped, non-executable scratch dir; no app source, `.env`, or host paths |
| `--memory 256m --memory-swap 256m` | memory ceiling (cgroups) |
| `--cpus 1` | CPU ceiling |
| `--pids-limit 64` | fork-bomb ceiling |
| `--cap-drop ALL --security-opt no-new-privileges` | no capabilities, no privilege escalation; Docker's default seccomp/AppArmor apply |
| 30s wall clock (runner `docker kill`s on expiry) | runaway scripts |
| stdout capped at 1 MB | output floods |

Code and parameters are delivered on **stdin** (JSON envelope) — there are never any
volumes or host mounts. The container is deleted after every run.

## Abuse controls

- Shared-secret bearer auth (`PONA_FLOW_RUNNER_TOKEN`); binds `127.0.0.1` by default.
- Concurrency semaphore (default 4) + bounded wait queue (default 16) → HTTP 429.
- Per-space token-bucket rate limit (default 30/min) → HTTP 429 `rate_limited`.
- Kill switch: `PONA_FLOW_CODE_EXEC_ENABLED=0` (checked by the main app AND the
  runner) plus `POST /admin/kill-all` to kill in-flight containers.
- Structured JSON alert lines on stderr for timeouts, OOM kills, output-limit hits,
  auth denials, and rate-limit denials (`{"alert": "code_exec", "event": ...}`).
- The main app writes one `audit_log` row per execution (`trigger='code'`, with
  `{resource_id, outcome, duration_ms}` in `detail` — never code/params/secrets).

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PONA_FLOW_RUNNER_HOST` / `PONA_FLOW_RUNNER_PORT` | `127.0.0.1` / `8766` | bind address |
| `PONA_FLOW_RUNNER_TOKEN` | _(unset)_ | shared secret (required in production) |
| `PONA_FLOW_CODE_EXEC_ENABLED` | `1` | kill switch |
| `PONA_FLOW_RUNNER_IMAGE_PYTHON` | `pona-flow-runner-python:latest` | Python image tag |
| `PONA_FLOW_RUNNER_IMAGE_NODE` | `pona-flow-runner-node:latest` | Node image tag |
| `PONA_FLOW_RUNNER_MAX_CONCURRENCY` | `4` | parallel executions |
| `PONA_FLOW_RUNNER_QUEUE_LIMIT` | `16` | queued waiters before 429 |
| `PONA_FLOW_RUNNER_RATE_PER_MINUTE` | `30` | per-space token bucket |
| `PONA_FLOW_RUNNER_MEMORY` | `256m` | container memory (and swap) cap |
| `PONA_FLOW_RUNNER_CPUS` | `1` | container CPU cap |
| `PONA_FLOW_RUNNER_PIDS_LIMIT` | `64` | container process cap |
| `PONA_FLOW_RUNNER_TMPFS_SIZE` | `64m` | scratch dir size |
| `PONA_FLOW_RUNNER_MAX_TIMEOUT` | `30` | wall-clock ceiling (seconds) |
| `PONA_FLOW_RUNNER_MAX_OUTPUT_BYTES` | `1048576` | stdout cap |

The main app finds the runner via `PONA_FLOW_RUNNER_URL` (default
`http://127.0.0.1:8766`) and authenticates with the same `PONA_FLOW_RUNNER_TOKEN`.

## Phase 2 (documented, not built)

Configurable per-space egress: a `code_exec_allowed_domains` space setting backed by
an egress-proxy sidecar (allowlisted domains only, private-IP and metadata-endpoint
blocking, outbound request logging). Until then the sandbox default stays
`--network none`.
