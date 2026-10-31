"""Instance update status: compare this build to GitHub ``main``, redeploy via Fly.

Self-hosted Fly apps bake ``PONA_FLOW_BUILD_SHA`` at image build time. Instance
admins see the commits on ``main`` they do not have yet, and (when a Fly deploy
token is configured) can roll the Machines onto ``ghcr.io/…/pona-flow:main``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

log = logging.getLogger("pona_flow.updates")

DEFAULT_GITHUB_REPO = "MitchMcQuinn/pona-flow"
DEFAULT_IMAGE = "ghcr.io/mitchmcquinn/pona-flow:main"
DEFAULT_BRANCH = "main"
GITHUB_API = "https://api.github.com"
FLY_MACHINES_API = "https://api.machines.dev/v1"

HttpGet = Callable[[str, dict[str, str]], tuple[int, Any]]
HttpPost = Callable[[str, dict[str, str], dict[str, Any]], tuple[int, Any]]

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
    return raw


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
    return {"build_sha": build_sha(), "started_at": STARTED_AT}


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
    # A failed or still-running CI run has not moved :main. Restarting would
    # come back on the image already running.
    image_ready = publish["status"] in ("success", "unknown")
    can_update = bool(token and app and not up_to_date and image_ready)
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
        "update_method": "fly" if (token and app) else "manual",
        "fly_token_configured": bool(token),
        "fly_app_name": app,
        "image": image_ref(),
        "publish_status": publish["status"],
        "publish_url": publish["url"],
        "publish_error": publish["error"],
        "manual_hint": (
            f"fly deploy --app {app or 'YOUR_APP'} --image {image_ref()}"
            if app or token
            else "docker compose pull && docker compose up -d"
        ),
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


def apply_update(
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
        config = machine.get("config") if isinstance(machine.get("config"), dict) else {}
        new_config = dict(config)
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
