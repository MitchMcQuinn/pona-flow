"""
Sandbox runner — a separate, low-privilege service that executes code-step scripts.

Purpose in the project
----------------------
The main app (Engine/server) NEVER executes user code in-process and never touches the
Docker socket. When a sequence reaches a code-execution STEP, the executor POSTs
``{language, code, timeout_seconds, space_id}`` to this service, which runs the script
in a hardened, disposable Docker container and returns a JSON envelope. Run this as a
separate OS process (ideally a separate unprivileged OS user) so a compromise of the
web tier still cannot reach Docker.

Sandbox profile (per execution)
-------------------------------
- ``--network none``           no network at all (default; SSRF/credential theft moot)
- ``--user 65534:65534``       non-root (nobody), on top of the image's non-root user
- ``--read-only``              read-only root filesystem
- ``--tmpfs /tmp``             fresh, size-capped, noexec scratch dir per run
- ``--memory/--memory-swap``   memory ceiling (cgroups; recursion/array bombs)
- ``--cpus``                   CPU ceiling (infinite loops cannot hog cores)
- ``--pids-limit``             process ceiling (fork bombs)
- ``--cap-drop ALL``           no Linux capabilities
- ``--security-opt no-new-privileges`` + Docker's default seccomp/AppArmor profiles
- no volumes, no host mounts, no Docker socket — code+input arrive on stdin only
- wall-clock timeout enforced here (``docker kill``), container removed afterwards

Every execution is disposable: start, run, collect result, kill, delete.

Abuse controls
--------------
- shared-secret auth (``PONA_FLOW_RUNNER_TOKEN``), bound to 127.0.0.1 by default
- max concurrent executions + bounded wait queue (429 when saturated)
- per-space token-bucket rate limit (429 ``rate_limited``)
- kill switch: ``PONA_FLOW_CODE_EXEC_ENABLED=0`` refuses everything;
  ``POST /admin/kill-all`` kills any in-flight containers
- structured JSON alert lines on stderr for timeouts / OOM kills / denials

Environment
-----------
  PONA_FLOW_RUNNER_TOKEN          shared secret (strongly recommended)
  PONA_FLOW_CODE_EXEC_ENABLED     kill switch (default enabled)
  PONA_FLOW_RUNNER_IMAGE_PYTHON   default pona-flow-runner-python:latest
  PONA_FLOW_RUNNER_IMAGE_NODE     default pona-flow-runner-node:latest
  PONA_FLOW_RUNNER_MAX_CONCURRENCY  default 4
  PONA_FLOW_RUNNER_QUEUE_LIMIT      default 16
  PONA_FLOW_RUNNER_RATE_PER_MINUTE  default 30 (per space)
  PONA_FLOW_RUNNER_MEMORY           default 256m
  PONA_FLOW_RUNNER_CPUS             default 1
  PONA_FLOW_RUNNER_PIDS_LIMIT       default 64
  PONA_FLOW_RUNNER_TMPFS_SIZE       default 64m
  PONA_FLOW_RUNNER_MAX_TIMEOUT      default 30 (seconds; requests are clamped)
  PONA_FLOW_RUNNER_MAX_OUTPUT_BYTES default 1048576 (1 MB)
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import JSONResponse

CONTAINER_LABEL = "pona-flow-runner"
_RESULT_SENTINEL = "\n__PONA_FLOW_RESULT__"

LANGUAGES = ("python", "javascript")


def _env_int(name: str, default: int) -> int:
    try:
        return int((os.environ.get(name) or "").strip() or default)
    except ValueError:
        return default


def _env_str(name: str, default: str) -> str:
    return (os.environ.get(name) or "").strip() or default


def code_exec_enabled() -> bool:
    raw = (os.environ.get("PONA_FLOW_CODE_EXEC_ENABLED") or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def image_for(language: str) -> str:
    if language == "javascript":
        return _env_str("PONA_FLOW_RUNNER_IMAGE_NODE", "pona-flow-runner-node:latest")
    return _env_str("PONA_FLOW_RUNNER_IMAGE_PYTHON", "pona-flow-runner-python:latest")


def alert(event: str, **fields: Any) -> None:
    """Structured JSON alert line on stderr (timeouts / OOM kills / denials)."""
    record = {"alert": "code_exec", "event": event, "ts": time.time(), **fields}
    sys.stderr.write(json.dumps(record) + "\n")
    sys.stderr.flush()


# --------------------------------------------------------------------------------------
# Abuse controls: concurrency semaphore, bounded queue, per-space token bucket
# --------------------------------------------------------------------------------------


class TokenBucket:
    """Per-space rate limiter: ``rate_per_minute`` executions, burst up to the same."""

    def __init__(self, rate_per_minute: int) -> None:
        self.rate = max(1, rate_per_minute)
        self.tokens: dict[str, tuple[float, float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        level, last = self.tokens.get(key, (float(self.rate), now))
        level = min(float(self.rate), level + (now - last) * (self.rate / 60.0))
        if level < 1.0:
            self.tokens[key] = (level, now)
            return False
        self.tokens[key] = (level - 1.0, now)
        return True


class ExecutionGate:
    """Concurrency cap with a bounded wait queue; rejects when saturated."""

    def __init__(self, max_concurrency: int, queue_limit: int) -> None:
        self.semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self.queue_limit = max(0, queue_limit)
        self.waiting = 0

    async def __aenter__(self) -> None:
        if self.waiting >= self.queue_limit:
            raise HTTPException(
                429, "Code execution queue is full; try again shortly."
            )
        self.waiting += 1
        try:
            await self.semaphore.acquire()
        finally:
            self.waiting -= 1

    async def __aexit__(self, *exc: Any) -> None:
        self.semaphore.release()


_gate = ExecutionGate(
    _env_int("PONA_FLOW_RUNNER_MAX_CONCURRENCY", 4),
    _env_int("PONA_FLOW_RUNNER_QUEUE_LIMIT", 16),
)
_bucket = TokenBucket(_env_int("PONA_FLOW_RUNNER_RATE_PER_MINUTE", 30))


# --------------------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------------------


_warned_no_token = False


async def require_token(request: Request) -> None:
    """Shared-secret bearer auth. Without a configured token the runner still works
    (dev convenience, 127.0.0.1 bind) but logs a loud warning once."""
    global _warned_no_token
    expected = (os.environ.get("PONA_FLOW_RUNNER_TOKEN") or "").strip()
    if not expected:
        if not _warned_no_token:
            _warned_no_token = True
            sys.stderr.write(
                "WARNING: PONA_FLOW_RUNNER_TOKEN is not set — the runner accepts any "
                "local request. Set a shared secret in production.\n"
            )
        return
    header = request.headers.get("authorization") or ""
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if token != expected:
        alert("auth_denied", client=str(request.client.host if request.client else ""))
        raise HTTPException(401, "invalid runner token")


# --------------------------------------------------------------------------------------
# Docker execution
# --------------------------------------------------------------------------------------


def _docker_args(language: str, container_name: str) -> list[str]:
    memory = _env_str("PONA_FLOW_RUNNER_MEMORY", "256m")
    cpus = _env_str("PONA_FLOW_RUNNER_CPUS", "1")
    pids = _env_int("PONA_FLOW_RUNNER_PIDS_LIMIT", 64)
    tmpfs_size = _env_str("PONA_FLOW_RUNNER_TMPFS_SIZE", "64m")
    return [
        "docker",
        "run",
        "--rm",
        "-i",
        "--name",
        container_name,
        "--label",
        f"{CONTAINER_LABEL}=1",
        # No network: blocks SSRF, metadata services (169.254.169.254), internal
        # IPs, and calls back into our own admin APIs in one stroke.
        "--network",
        "none",
        # Non-root even if the image misconfigures its user.
        "--user",
        "65534:65534",
        "--read-only",
        "--tmpfs",
        f"/tmp:rw,noexec,nosuid,size={tmpfs_size}",
        "--workdir",
        "/tmp",
        "--memory",
        memory,
        "--memory-swap",
        memory,
        "--cpus",
        cpus,
        "--pids-limit",
        str(pids),
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--env",
        "PYTHONDONTWRITEBYTECODE=1",
        image_for(language),
    ]


def _parse_harness_envelope(stdout_text: str) -> dict[str, Any] | None:
    """Extract the harness result envelope (sentinel-delimited JSON at the end)."""
    idx = stdout_text.rfind(_RESULT_SENTINEL.strip())
    if idx < 0:
        return None
    raw = stdout_text[idx + len(_RESULT_SENTINEL.strip()):].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


async def run_in_sandbox(
    language: str, code: str, timeout_seconds: int, space_id: str
) -> dict[str, Any]:
    """Run one disposable container; returns the runner envelope."""
    max_output = _env_int("PONA_FLOW_RUNNER_MAX_OUTPUT_BYTES", 1024 * 1024)
    container_name = f"pona-flow-exec-{uuid.uuid4().hex[:16]}"
    args = _docker_args(language, container_name)
    request_payload = json.dumps({"code": code}).encode("utf-8")

    started = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        alert("docker_missing", space_id=space_id)
        return {
            "ok": False,
            "outcome": "unavailable",
            "error": "Docker is not available on the runner host.",
        }

    timed_out = False
    try:
        # Wall-clock limit on the user's code plus a fixed grace for container
        # start/stop overhead (the user's script does not get the grace — the
        # harness inside the container is started immediately).
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(request_payload), timeout=timeout_seconds + 10
        )
    except asyncio.TimeoutError:
        timed_out = True
        # Kill the container by name (kills the whole sandbox, not just the client).
        kill = await asyncio.create_subprocess_exec(
            "docker",
            "kill",
            container_name,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await kill.wait()
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
        except asyncio.TimeoutError:
            proc.kill()
            stdout, stderr = b"", b""

    duration_ms = int((time.monotonic() - started) * 1000)

    if timed_out:
        alert("timeout", space_id=space_id, duration_ms=duration_ms)
        return {
            "ok": False,
            "outcome": "timeout",
            "error": f"Execution exceeded the {timeout_seconds}s time limit.",
            "duration_ms": duration_ms,
        }

    stdout_text = stdout[: max_output + 1].decode("utf-8", errors="replace")
    output_truncated = len(stdout) > max_output
    returncode = proc.returncode or 0

    # 137 = SIGKILL: with no external kill issued, that is the cgroup OOM killer.
    if returncode == 137:
        alert("oom_kill", space_id=space_id, duration_ms=duration_ms)
        return {
            "ok": False,
            "outcome": "oom",
            "error": "Execution was killed for exceeding the memory limit.",
            "duration_ms": duration_ms,
        }

    envelope = _parse_harness_envelope(stdout_text)
    if envelope is None:
        stderr_tail = stderr[-2048:].decode("utf-8", errors="replace").strip()
        if output_truncated:
            alert("output_limit", space_id=space_id, duration_ms=duration_ms)
            return {
                "ok": False,
                "outcome": "output_limit",
                "error": "Execution produced more output than the limit allows.",
                "duration_ms": duration_ms,
            }
        alert("harness_failure", space_id=space_id, returncode=returncode)
        return {
            "ok": False,
            "outcome": "error",
            "error": stderr_tail or f"sandbox exited with code {returncode}",
            "duration_ms": duration_ms,
        }

    ok = bool(envelope.get("ok"))
    result: dict[str, Any] = {
        "ok": ok,
        "outcome": "ok" if ok else "error",
        "result": envelope.get("result"),
        "stdout": str(envelope.get("stdout") or "")[:8192],
        "error": envelope.get("error"),
        "duration_ms": duration_ms,
    }
    if envelope.get("truncated") or output_truncated:
        result["truncated"] = True
    return result


# --------------------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------------------


def create_app() -> FastAPI:
    app = FastAPI(title="pona flow sandbox runner", docs_url=None, redoc_url=None)

    @app.exception_handler(HTTPException)
    async def _http_error(_request: Request, exc: HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": str(exc.detail), "ok": False, "outcome": _outcome_for(exc)},
        )

    def _outcome_for(exc: HTTPException) -> str:
        if exc.status_code == 429:
            return "rate_limited"
        if exc.status_code == 503:
            return "disabled"
        return "error"

    @app.get("/healthz")
    async def healthz():
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "info",
            "--format",
            "{{.ServerVersion}}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        docker_ok = proc.returncode == 0
        return {
            "ok": docker_ok and code_exec_enabled(),
            "docker": docker_ok,
            "docker_version": out.decode().strip() if docker_ok else None,
            "enabled": code_exec_enabled(),
        }

    @app.post("/execute")
    async def execute(request: Request, _auth: None = Depends(require_token)):
        if not code_exec_enabled():
            alert("denied_disabled")
            raise HTTPException(503, "Code execution is disabled (kill switch).")

        try:
            body = json.loads((await request.body()) or b"{}")
        except json.JSONDecodeError:
            raise HTTPException(400, "invalid JSON body")
        if not isinstance(body, dict):
            raise HTTPException(400, "JSON body must be an object")

        language = str(body.get("language") or "").strip().lower()
        if language not in LANGUAGES:
            raise HTTPException(400, f"language must be one of {list(LANGUAGES)}")
        code = body.get("code")
        if not isinstance(code, str) or not code.strip():
            raise HTTPException(400, "code is required")
        if len(code.encode("utf-8")) > 512 * 1024:
            raise HTTPException(400, "code exceeds the 512 KB limit")
        space_id = str(body.get("space_id") or "").strip() or "_unknown"

        max_timeout = _env_int("PONA_FLOW_RUNNER_MAX_TIMEOUT", 30)
        try:
            requested = int(body.get("timeout_seconds") or max_timeout)
        except (TypeError, ValueError):
            requested = max_timeout
        timeout_seconds = max(1, min(requested, max_timeout))

        if not _bucket.allow(space_id):
            alert("rate_limited", space_id=space_id)
            raise HTTPException(429, "Rate limit exceeded for code executions.")

        async with _gate:
            return await run_in_sandbox(language, code, timeout_seconds, space_id)

    @app.post("/admin/kill-all")
    async def kill_all(_auth: None = Depends(require_token)):
        """Admin kill switch helper: kill every in-flight sandbox container."""
        lister = await asyncio.create_subprocess_exec(
            "docker",
            "ps",
            "-q",
            "--filter",
            f"label={CONTAINER_LABEL}=1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await lister.communicate()
        ids = [line.strip() for line in out.decode().splitlines() if line.strip()]
        killed = 0
        for cid in ids:
            killer = await asyncio.create_subprocess_exec(
                "docker",
                "kill",
                cid,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
            killed += 1
        alert("kill_all", killed=killed)
        return {"killed": killed}

    return app


app = create_app()
