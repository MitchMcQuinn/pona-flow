"""Instance update status: compare this build to GitHub ``main``, then roll forward.

Fly apps with a deploy token roll their Machines onto ``ghcr.io/…/pona-flow:main``.
A Docker Compose install (``PONA_FLOW_LOCAL_UPDATE=1``) asks the compose updater to
pull and recreate the app container. A source checkout fast-forwards to the tracked
branch and restarts the process. ``PONA_FLOW_BUILD_SHA`` is baked into images; a
checkout with no sha uses ``git rev-parse HEAD``.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

from . import config

log = logging.getLogger("pona_flow.updates")

DEFAULT_GITHUB_REPO = "MitchMcQuinn/pona-flow"
DEFAULT_IMAGE = "ghcr.io/mitchmcquinn/pona-flow:main"
DEFAULT_BRANCH = "main"
GITHUB_API = "https://api.github.com"
FLY_MACHINES_API = "https://api.machines.dev/v1"

HttpGet = Callable[[str, dict[str, str]], tuple[int, Any]]
HttpPost = Callable[[str, dict[str, str], dict[str, Any]], tuple[int, Any]]
GitRun = Callable[[list[str]], subprocess.CompletedProcess[str]]

# The compose updater refreshes this file every couple of seconds. Older than this
# means that container is gone, so the menu must not pretend a click will restart us.
WATCHER_TTL_S = 20
REQUEST_NAME = "update-request"
RESULT_NAME = "update-result"
WATCHER_NAME = "update-watcher"

# Unauthenticated GitHub API calls are limited to 60/hour per IP, and Fly apps share
# outbound IPs — so answers are reused for a few minutes and kept as a fallback.
GITHUB_CACHE_TTL_S = 300
_github_cache: dict[str, tuple[float, Any]] = {}
_github_cache_lock = threading.Lock()

STARTED_AT = time.time()


class GitHubUnavailable(RuntimeError):
    """GitHub refused or failed; the message is safe to show an instance admin."""


def clear_github_cache() -> None:
    with _github_cache_lock:
        _github_cache.clear()


def _github_error_message(repo: str, status: int, body: Any) -> str:
    message = str(body.get("message") or "") if isinstance(body, dict) else ""
    if status in (403, 429) and ("rate limit" in message.lower() or status == 429):
        hint = (
            "" if os.environ.get("PONA_FLOW_GITHUB_TOKEN")
            else " Set PONA_FLOW_GITHUB_TOKEN to a GitHub token for a much higher limit."
        )
        return (
            "GitHub's hourly limit for update checks was reached (hosting providers share "
            f"network addresses, so other apps count too). Try again later.{hint}"
        )
    return f"Could not read {repo} from GitHub (HTTP {status})."


def _github_get(url: str, http_get: HttpGet) -> Any:
    """GET a GitHub API URL with a short cache; serve the last good answer if GitHub refuses."""
    now = time.time()
    with _github_cache_lock:
        cached = _github_cache.get(url)
    if cached and now - cached[0] < GITHUB_CACHE_TTL_S:
        return cached[1]
    status, body = http_get(url, _github_headers())
    if status == 200:
        with _github_cache_lock:
            _github_cache[url] = (now, body)
        return body
    if cached:
        log.info("github %s returned HTTP %s; serving cached answer", url, status)
        return cached[1]
    raise GitHubUnavailable(_github_error_message(github_repo(), status, body))


def github_repo() -> str:
    return (os.environ.get("PONA_FLOW_GITHUB_REPO") or DEFAULT_GITHUB_REPO).strip() or DEFAULT_GITHUB_REPO


def track_branch() -> str:
    return (os.environ.get("PONA_FLOW_UPDATE_BRANCH") or DEFAULT_BRANCH).strip() or DEFAULT_BRANCH


def build_sha() -> str:
    raw = (os.environ.get("PONA_FLOW_BUILD_SHA") or "").strip()
    if raw:
        return raw
    # Source checkouts have no baked sha. HEAD is the version the menu compares to main.
    if git_checkout_available():
        return _git_head_sha()
    return ""


def local_update_enabled() -> bool:
    flag = (os.environ.get("PONA_FLOW_LOCAL_UPDATE") or "").strip().lower()
    return flag in {"1", "true", "yes", "on"}


def configured_version() -> str:
    return (os.environ.get("PONA_FLOW_VERSION") or "main").strip() or "main"


def version_pin() -> str | None:
    """A compose tag other than ``main`` is a pin. The menu will not roll it forward."""
    version = configured_version()
    if version == "main":
        return None
    return version


def running_in_docker() -> bool:
    return os.path.exists("/.dockerenv")


def on_fly() -> bool:
    if (os.environ.get("FLY_MACHINE_ID") or "").strip():
        return True
    if local_update_enabled():
        return False
    return bool(fly_app_name())


def _marker(name: str) -> Path:
    return config.data_dir() / name


def local_watcher_ready(now: float | None = None) -> bool:
    path = _marker(WATCHER_NAME)
    try:
        line = path.read_text(encoding="utf-8").splitlines()[0].strip()
        seen = float(line)
    except (OSError, ValueError, IndexError):
        return False
    current = time.time() if now is None else now
    return current - seen < WATCHER_TTL_S


def read_update_result() -> dict[str, Any] | None:
    path = _marker(RESULT_NAME)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    if not lines:
        return None
    head = lines[0].strip()
    if head == "ok":
        return {"ok": True, "error": None}
    if head == "fail":
        error = lines[1].strip() if len(lines) > 1 else ""
        return {"ok": False, "error": error or "local update failed"}
    return None


def _clear_marker(name: str) -> None:
    path = _marker(name)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        log.warning("could not remove %s", path)


def git_checkout_available() -> bool:
    if running_in_docker():
        return False
    if not (config.ROOT / ".git").exists():
        return False
    return shutil.which("git") is not None


def _run_git(args: list[str]) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    # `true` exits without prompting, so a missing credential fails instead of hanging.
    env["GIT_ASKPASS"] = "true"
    return subprocess.run(
        ["git", *args],
        cwd=config.ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )


def _git_head_sha(run: GitRun = _run_git) -> str:
    try:
        done = run(["rev-parse", "HEAD"])
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if done.returncode != 0:
        return ""
    return (done.stdout or "").strip()


def git_block_reason(run: GitRun = _run_git) -> str | None:
    """Why a source checkout cannot fast-forward, or None when it can."""
    branch = track_branch()
    try:
        head = run(["rev-parse", "--abbrev-ref", "HEAD"])
    except (OSError, subprocess.TimeoutExpired):
        return "git could not read this checkout"
    if head.returncode != 0:
        detail = (head.stderr or head.stdout or "").strip().splitlines()
        return detail[-1][:200] if detail else "git could not read this checkout"
    current = (head.stdout or "").strip()
    if current != branch:
        shown = current or "a detached commit"
        return f"this checkout is on {shown}. switch to {branch} to update from this menu."
    for args in (["diff", "--quiet"], ["diff", "--cached", "--quiet"]):
        try:
            diff = run(args)
        except (OSError, subprocess.TimeoutExpired):
            return "git could not check for local changes"
        if diff.returncode == 1:
            return "this checkout has uncommitted changes. commit or stash them, then update."
        if diff.returncode != 0:
            return "git could not check for local changes"
    return None


def project_dir() -> str:
    """Folder an admin would update by hand: the compose project, or this checkout."""
    configured = (os.environ.get("PONA_FLOW_COMPOSE_DIR") or "").strip()
    if configured:
        return configured
    if git_checkout_available():
        return str(config.ROOT)
    return ""


def current_update_method() -> str:
    """How this process rolls forward. Fly credentials win over a git checkout."""
    if local_update_enabled():
        return "docker"
    if fly_api_token() and fly_app_name():
        return "fly"
    if git_checkout_available():
        return "git"
    return "manual"


def manual_hint() -> str:
    app = fly_app_name()
    if app or fly_api_token():
        return f"fly deploy --app {app or 'YOUR_APP'} --image {image_ref()}"
    if git_checkout_available():
        return f"git pull --ff-only origin {track_branch()}"
    return "docker compose pull && docker compose up -d"


def image_ref() -> str:
    return (os.environ.get("PONA_FLOW_IMAGE") or DEFAULT_IMAGE).strip() or DEFAULT_IMAGE


def fly_app_name() -> str:
    return (os.environ.get("FLY_APP_NAME") or os.environ.get("FLY_APP") or "").strip()


def fly_api_token() -> str:
    return (os.environ.get("FLY_API_TOKEN") or "").strip()


def _http_get(url: str, headers: dict[str, str]) -> tuple[int, Any]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            parsed: Any = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"message": raw[:200]}
        return e.code, parsed


def _http_post(url: str, headers: dict[str, str], payload: dict[str, Any]) -> tuple[int, Any]:
    data = json.dumps(payload).encode("utf-8")
    hdrs = dict(headers)
    hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            parsed: Any = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"message": raw[:200]}
        return e.code, parsed


def _github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "pona-flow-instance-updates",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = (os.environ.get("PONA_FLOW_GITHUB_TOKEN") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _normalize_sha(value: str) -> str:
    return (value or "").strip().lower()


def _sha_matches(current: str, latest: str) -> bool:
    a, b = _normalize_sha(current), _normalize_sha(latest)
    if not a or not b:
        return False
    return a == b or a.startswith(b) or b.startswith(a)


def _commit_payload(item: dict[str, Any]) -> dict[str, str]:
    sha = str(item.get("sha") or "")
    commit = item.get("commit") if isinstance(item.get("commit"), dict) else {}
    message = str(commit.get("message") or "").splitlines()[0].strip()
    date = ""
    author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
    date = str(author.get("date") or "")
    html = str(item.get("html_url") or "")
    return {"sha": sha, "message": message, "date": date, "url": html}


def fetch_branch_tip(http_get: HttpGet = _http_get) -> dict[str, Any]:
    repo = github_repo()
    branch = track_branch()
    url = f"{GITHUB_API}/repos/{repo}/commits/{urllib.parse.quote(branch)}"
    body = _github_get(url, http_get)
    if not isinstance(body, dict):
        raise GitHubUnavailable(f"Could not read {repo}@{branch} from GitHub.")
    return body


def fetch_commits_since(
    current_sha: str, http_get: HttpGet = _http_get
) -> tuple[str, list[dict[str, str]]]:
    """Return ``(latest_sha, commits_on_main_after_current)``.

    When ``current_sha`` is empty or unknown to GitHub, fall back to recent
    commits on the tracked branch (so the UI still has something to show).
    """
    tip = fetch_branch_tip(http_get=http_get)
    latest = str(tip.get("sha") or "")
    if current_sha and _sha_matches(current_sha, latest):
        return latest, []
    repo = github_repo()
    branch = track_branch()
    if current_sha:
        url = (
            f"{GITHUB_API}/repos/{repo}/compare/"
            f"{urllib.parse.quote(current_sha)}...{urllib.parse.quote(branch)}"
        )
        try:
            body = _github_get(url, http_get)
        except GitHubUnavailable as e:
            log.info("github compare %s...%s failed (%s); listing branch", current_sha, branch, e)
            body = None
        if isinstance(body, dict):
            raw = body.get("commits") if isinstance(body.get("commits"), list) else []
            commits = [_commit_payload(c) for c in raw if isinstance(c, dict)]
            return latest, commits[-50:]
    list_url = f"{GITHUB_API}/repos/{repo}/commits?sha={urllib.parse.quote(branch)}&per_page=20"
    body = _github_get(list_url, http_get)
    if not isinstance(body, list):
        raise GitHubUnavailable(f"Could not list commits for {repo}@{branch}.")
    commits = [_commit_payload(c) for c in body if isinstance(c, dict)]
    return latest, commits


def fetch_ci_publish(sha: str, http_get: HttpGet = _http_get) -> dict[str, Any]:
    """Whether the CI workflow has published ``:main`` for ``sha``.

    ``status`` is ``success``, ``failure``, ``in_progress``, or ``unknown``.
    An unreadable Actions response is ``unknown`` so a GitHub hiccup does not
    block an update. ``failure`` includes a cancelled run: that also leaves
    ``:main`` on the previous image.
    """
    repo = github_repo()
    url = (
        f"{GITHUB_API}/repos/{repo}/actions/workflows/ci.yml/runs"
        f"?head_sha={urllib.parse.quote(sha)}&per_page=1"
    )
    try:
        body = _github_get(url, http_get)
    except GitHubUnavailable:
        return {"status": "unknown", "url": "", "error": None}
    runs = body.get("workflow_runs") if isinstance(body, dict) else None
    run = runs[0] if isinstance(runs, list) and runs and isinstance(runs[0], dict) else None
    if not run:
        return {"status": "unknown", "url": "", "error": None}
    html = str(run.get("html_url") or "")
    if str(run.get("status") or "") != "completed":
        return {
            "status": "in_progress",
            "url": html,
            "error": "CI is still building the image. Update once that run finishes.",
        }
    if str(run.get("conclusion") or "") == "success":
        return {"status": "success", "url": html, "error": None}
    return {
        "status": "failure",
        "url": html,
        "error": (
            "CI did not publish an image for the newest commit, so updating would "
            "restart onto the version already running."
        ),
    }


def version_payload() -> dict[str, Any]:
    """Cheap identity of the running process — polled while an update rolls out."""
    return {
        "build_sha": build_sha(),
        "started_at": STARTED_AT,
        "update_result": read_update_result(),
    }


def status_payload(http_get: HttpGet = _http_get) -> dict[str, Any]:
    current = build_sha()
    github_error: str | None = None
    try:
        latest, commits = fetch_commits_since(current, http_get=http_get)
    except GitHubUnavailable as e:
        # Still let the admin update: the :main image doesn't depend on GitHub's API.
        log.warning("instance updates: %s", e)
        github_error = str(e)
        latest, commits = "", []
    up_to_date = bool(current) and _sha_matches(current, latest)
    publish = (
        {"status": "unknown", "url": "", "error": None}
        if up_to_date or not latest
        else fetch_ci_publish(latest, http_get=http_get)
    )
    token = fly_api_token()
    app = fly_app_name()
    # A failed or still-running CI run has not moved :main. Restarting a container
    # or a Fly machine would come back on the image already running. A git checkout
    # pulls the commit itself, so that check does not apply there.
    image_ready = publish["status"] in ("success", "unknown")
    method = current_update_method()
    pin = version_pin() if method == "docker" else None
    watcher = local_watcher_ready() if method == "docker" else False
    git_error = git_block_reason() if method == "git" and not up_to_date else None
    result = read_update_result()
    local_update_error = (
        result["error"] if method == "docker" and result and result.get("ok") is False else None
    )
    if method == "docker":
        can_update = bool(watcher and not pin and not up_to_date and image_ready)
    elif method == "git":
        can_update = bool(not up_to_date and not git_error)
    elif method == "fly":
        can_update = bool(not up_to_date and image_ready)
    else:
        can_update = False
    return {
        "github_error": github_error,
        "started_at": STARTED_AT,
        "repo": github_repo(),
        "branch": track_branch(),
        "current_sha": current,
        "latest_sha": latest,
        "behind": (not up_to_date) and bool(latest),
        "up_to_date": up_to_date,
        "commits": commits,
        "can_update": can_update,
        "update_method": method,
        "fly_token_configured": bool(token),
        "fly_app_name": app,
        "on_fly": on_fly(),
        "local_update_enabled": local_update_enabled(),
        "local_updater_ready": watcher,
        "local_update_error": local_update_error,
        "version_pin": pin,
        "git_error": git_error,
        "project_dir": project_dir(),
        "image": image_ref(),
        "publish_status": publish["status"],
        "publish_url": publish["url"],
        "publish_error": publish["error"],
        "manual_hint": manual_hint(),
    }


def save_fly_credentials(token: str | None, app_name: str | None) -> dict[str, Any]:
    """Persist the deploy token / app name to the writable ``.env`` (and live env)."""
    from . import config

    if token is not None:
        cleaned = token.strip()
        if cleaned:
            config.set_env_value("FLY_API_TOKEN", cleaned)
        else:
            config.delete_env_value("FLY_API_TOKEN")
    if app_name is not None:
        cleaned_app = app_name.strip()
        if cleaned_app:
            config.set_env_value("FLY_APP_NAME", cleaned_app)
        else:
            config.delete_env_value("FLY_APP_NAME")
    return {
        "fly_token_configured": bool(fly_api_token()),
        "fly_app_name": fly_app_name(),
    }


def _fly_headers() -> dict[str, str]:
    token = fly_api_token()
    if not token:
        raise ValueError("FLY_API_TOKEN is not set")
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "pona-flow-instance-updates",
    }


def _restart_soon() -> None:
    """Replace this process after the HTTP response has a chance to flush."""

    def _go() -> None:
        time.sleep(1)
        log.warning("restarting after local git update")
        os.execv(sys.executable, [sys.executable, *sys.argv])

    threading.Thread(target=_go, name="pona-flow-restart", daemon=False).start()


def apply_docker_update() -> dict[str, Any]:
    """Ask the compose updater to pull and recreate this service."""
    if not local_update_enabled():
        raise ValueError("local updates are not enabled on this instance")
    pin = version_pin()
    if pin:
        raise ValueError(
            f"this install is pinned to {pin}. "
            "Set PONA_FLOW_VERSION=main in .env and restart to update from this menu."
        )
    if not local_watcher_ready():
        raise ValueError(
            "the local updater is not running. In the folder that contains docker-compose.yml, run: docker compose up -d"
        )
    _clear_marker(RESULT_NAME)
    _marker(REQUEST_NAME).write_text("update\n", encoding="utf-8")
    return {"ok": True, "method": "docker", "image": image_ref()}


def apply_git_update(
    run: GitRun = _run_git,
    restart: Callable[[], None] = _restart_soon,
) -> dict[str, Any]:
    """Fast-forward the source checkout, then restart this process."""
    if not git_checkout_available():
        raise ValueError("this instance is not a git checkout")
    reason = git_block_reason(run)
    if reason:
        raise ValueError(reason)
    branch = track_branch()
    try:
        fetched = run(["fetch", "origin", branch])
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("git fetch did not finish") from exc
    if fetched.returncode != 0:
        detail = (fetched.stderr or fetched.stdout or "git fetch failed").strip().splitlines()
        raise RuntimeError(detail[-1][:300] if detail else "git fetch failed")
    try:
        merged = run(["merge", "--ff-only", f"origin/{branch}"])
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("git merge did not finish") from exc
    if merged.returncode != 0:
        detail = (merged.stderr or merged.stdout or "could not fast-forward").strip().splitlines()
        raise RuntimeError(detail[-1][:300] if detail else "could not fast-forward")
    restart()
    return {"ok": True, "method": "git", "branch": branch}


def apply_fly_update(
    http_get: HttpGet = _http_get,
    http_post: HttpPost = _http_post,
) -> dict[str, Any]:
    """Point every Fly Machine at ``image_ref()``. Raises ValueError for operator errors."""
    app = fly_app_name()
    if not app:
        raise ValueError("FLY_APP_NAME is not set")
    if not fly_api_token():
        raise ValueError("FLY_API_TOKEN is not set")
    image = image_ref()
    list_url = f"{FLY_MACHINES_API}/apps/{urllib.parse.quote(app)}/machines"
    status, body = http_get(list_url, _fly_headers())
    if status != 200 or not isinstance(body, list):
        raise RuntimeError(f"Fly Machines list failed (HTTP {status}).")
    if not body:
        raise RuntimeError(f"No Fly machines found for app {app!r}.")
    updated: list[str] = []
    for machine in body:
        if not isinstance(machine, dict):
            continue
        mid = str(machine.get("id") or "")
        if not mid:
            continue
        machine_config = machine.get("config") if isinstance(machine.get("config"), dict) else {}
        new_config = dict(machine_config)
        new_config["image"] = image
        machine_url = (
            f"{FLY_MACHINES_API}/apps/{urllib.parse.quote(app)}/machines/{urllib.parse.quote(mid)}"
        )
        payload = {"config": new_config}
        code, _resp = http_post(f"{machine_url}/update", _fly_headers(), payload)
        if code >= 400:
            code, _resp = http_post(machine_url, _fly_headers(), payload)
        if code >= 400:
            raise RuntimeError(f"Fly machine {mid} update failed (HTTP {code}).")
        updated.append(mid)
        w_code, _ = http_get(f"{machine_url}/wait?state=started&timeout=90", _fly_headers())
        if w_code >= 400:
            log.warning("fly wait for %s returned HTTP %s (deploy may still be rolling)", mid, w_code)
    return {"ok": True, "app": app, "image": image, "machines": updated}


def apply_update(
    http_get: HttpGet = _http_get,
    http_post: HttpPost = _http_post,
    run_git: GitRun | None = None,
    restart: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Roll this instance forward. Raises ValueError for operator errors."""
    method = current_update_method()
    if method == "docker":
        return apply_docker_update()
    if method == "git":
        return apply_git_update(run_git or _run_git, restart or _restart_soon)
    return apply_fly_update(http_get, http_post)
