"""
Docker integration test for the sandbox runner (Engine/runner/runner.py).

Exercises run_in_sandbox against REAL disposable containers — this is the test that
proves the isolation profile actually holds:

- happy path: code runs and returns a JSON result;
- wall-clock timeout: an infinite sleep is docker-killed (outcome: timeout);
- memory limit: an allocation bomb is OOM-killed or denied (outcome: oom/MemoryError);
- fork bomb: --pids-limit stops runaway process creation well short of the bomb;
- output bomb: stdout beyond the cap is rejected/truncated, never returned whole;
- no network: outbound connections fail inside the container;
- filesystem: rootfs is read-only, /tmp is writable scratch, user is nobody (65534);
- container cleanup: no leftover containers after the runs (--rm).

Requires Docker plus the sandbox images (Engine/runner/images/build.sh). When Docker
or the images are missing the test SKIPS (exit 0) with instructions, so it is safe in
environments without Docker.

Run: ``.venv/bin/python tests/runner-sandbox-docker.py`` from the repo root.
"""

import asyncio
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.runner import runner  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool, extra: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    suffix = f"  ({extra})" if extra and not condition else ""
    print(f"[{status}] {name}{suffix}")
    if not condition:
        failures.append(name)


def docker_ready() -> tuple[bool, str]:
    try:
        info = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True, text=True, timeout=20,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False, "docker CLI not available"
    if info.returncode != 0:
        return False, "docker daemon not running"
    image = runner.image_for("python")
    inspect = subprocess.run(
        ["docker", "image", "inspect", image], capture_output=True, timeout=20
    )
    if inspect.returncode != 0:
        return False, f"image {image!r} not built (run Engine/runner/images/build.sh)"
    return True, ""


def run(code: str, timeout_seconds: int = 20, language: str = "python") -> dict:
    return asyncio.run(
        runner.run_in_sandbox(language, code, timeout_seconds, "DOCKER_TEST")
    )


def main() -> None:
    ready, reason = docker_ready()
    if not ready:
        print(f"[SKIP] {reason} — Docker sandbox integration test skipped.")
        return

    # --- happy path -------------------------------------------------------------------
    env = run("result = {'n': 6 * 7}")
    check("python code runs and returns JSON", env.get("result") == {"n": 42}, str(env))

    # --- wall-clock timeout ------------------------------------------------------------
    env = run("import time\ntime.sleep(120)", timeout_seconds=3)
    check("infinite sleep is killed (timeout outcome)", env.get("outcome") == "timeout", str(env))
    check("timeout reports not-ok", env.get("ok") is False)

    # --- memory limit ---------------------------------------------------------------------
    env = run(
        "data = []\n"
        "while True:\n"
        "    data.append(bytearray(16 * 1024 * 1024))\n",
        timeout_seconds=25,
    )
    oom = env.get("outcome") == "oom" or (
        env.get("ok") is False and "memory" in str(env.get("error") or "").lower()
    )
    check("allocation bomb hits the memory ceiling", oom, str(env)[:300])

    # --- fork bomb --------------------------------------------------------------------------
    env = run(
        "import os, time\n"
        "n = 0\n"
        "try:\n"
        "    for _ in range(500):\n"
        "        pid = os.fork()\n"
        "        if pid == 0:\n"
        "            time.sleep(60)\n"
        "            os._exit(0)\n"
        "        n += 1\n"
        "except OSError:\n"
        "    pass\n"
        "result = {'forks': n}\n",
        timeout_seconds=20,
    )
    forks = (env.get("result") or {}).get("forks") if isinstance(env.get("result"), dict) else None
    check(
        "fork bomb stopped by --pids-limit",
        isinstance(forks, int) and 0 < forks < 200,
        str(env)[:300],
    )

    # --- output bomb -----------------------------------------------------------------------------
    env = run("print('x' * (4 * 1024 * 1024))", timeout_seconds=20)
    capped = (
        env.get("outcome") == "output_limit"
        or env.get("truncated") is True
        or (env.get("ok") is False)
    )
    check("output bomb is capped, never returned whole", capped, str(env)[:300])
    raw = str(env.get("result") or "") + str(env.get("stdout") or "")
    check("no multi-megabyte payload escapes the sandbox", len(raw) < 2 * 1024 * 1024)

    # --- network isolation ------------------------------------------------------------------------
    env = run(
        "import socket\n"
        "try:\n"
        "    socket.create_connection(('1.1.1.1', 80), timeout=3)\n"
        "    result = {'network': 'reachable'}\n"
        "except OSError:\n"
        "    result = {'network': 'blocked'}\n",
        timeout_seconds=15,
    )
    check(
        "outbound network is blocked (--network none)",
        env.get("result") == {"network": "blocked"},
        str(env)[:300],
    )

    # --- filesystem + identity ----------------------------------------------------------------------
    env = run(
        "import os\n"
        "res = {'uid': os.getuid()}\n"
        "try:\n"
        "    open('/etc/poison', 'w').write('x')\n"
        "    res['rootfs'] = 'writable'\n"
        "except OSError:\n"
        "    res['rootfs'] = 'readonly'\n"
        "try:\n"
        "    open('/tmp/scratch', 'w').write('x')\n"
        "    res['tmp'] = 'writable'\n"
        "except OSError:\n"
        "    res['tmp'] = 'readonly'\n"
        "result = res\n",
        timeout_seconds=15,
    )
    res = env.get("result") or {}
    check("runs as nobody (uid 65534)", res.get("uid") == 65534, str(env)[:300])
    check("root filesystem is read-only", res.get("rootfs") == "readonly")
    check("/tmp scratch dir is writable", res.get("tmp") == "writable")

    # --- javascript image (only when built) -----------------------------------------------------------
    js_image = runner.image_for("javascript")
    js_built = subprocess.run(
        ["docker", "image", "inspect", js_image], capture_output=True, timeout=20
    ).returncode == 0
    if js_built:
        env = run("globalThis.result = {lang: 'js'};", timeout_seconds=15, language="javascript")
        check("javascript sandbox runs", env.get("result") == {"lang": "js"}, str(env)[:300])
    else:
        print(f"[SKIP] image {js_image!r} not built — javascript sandbox check skipped")

    # --- cleanup: disposable containers leave nothing behind --------------------------------------------
    ps = subprocess.run(
        ["docker", "ps", "-aq", "--filter", f"label={runner.CONTAINER_LABEL}=1"],
        capture_output=True, text=True, timeout=20,
    )
    check("no leftover sandbox containers (--rm)", ps.stdout.strip() == "")

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All Docker sandbox checks passed.")


if __name__ == "__main__":
    main()
