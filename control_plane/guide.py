"""Public guide agent. It answers product questions and has no tools."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .util import GITHUB_REPO, SANDBOX_DAYS

ROOT = Path(__file__).resolve().parents[1]
DOC_FILES = (
    ROOT / "Docs" / "WHY-PONA-FLOW.md",
    ROOT / "Docs" / "PITCH.md",
    ROOT / "Docs" / "GETTING-STARTED.md",
)
DOC_CHAR_CAP = 6000
MAX_MESSAGE_CHARS = 2000

SYSTEM = f"""You are the pona flow guide. Visitors have not created an instance yet.
Answer questions about pona flow and encourage them to use the Get started button under your context wizard.
You cannot create an instance, take a payment, collect a Fly token or database password, or change a workspace.
If they want an instance, tell them to click Get started. Do not pretend you started one.

Editions, which Get started walks through:
- Local: fork {GITHUB_REPO} and run it themselves. Support is priced separately.
- Self-hosted: their own Fly.io account and their own Neo4j Aura database. Get started creates the Fly app. They need an org token from `fly tokens create org`, pasted alone. An app deploy token is optional: paste one if this app already exists (`fly tokens create deploy -a <app>`); otherwise leave it blank and add it later under Instance settings. Aura Free's database user is the instance id in the URI, not `neo4j`. Aura Pro's user is `neo4j`. Support is priced separately.
- Hosted Basic: we run pona flow and Neo4j Community on a virtual machine after they subscribe. The form shows the price. Do not quote a dollar amount. They can download their data and move it.
- Hosted Business: the same with Neo4j Aura. It is coming soon. Do not offer it as available.
- Sandbox: the code sandbox starts a {SANDBOX_DAYS}-day preview on their own graph. It is not a shared demo.
- A VIP code is one-time and provisions hosting without a subscription. Do not invent a code.

Keep replies short. You have no tools. Never emit a tool call.
"""

Complete = Callable[[str, list[dict[str, str]]], str]


class RateLimiter:
    def __init__(self, limit: int, window_seconds: int):
        self.limit = limit
        self.window_seconds = window_seconds
        self.hits: dict[str, list[float]] = {}

    def allow(self, key: str, now: float | None = None) -> bool:
        moment = time.time() if now is None else now
        recent = [stamp for stamp in self.hits.get(key, []) if moment - stamp < self.window_seconds]
        if len(recent) >= self.limit:
            self.hits[key] = recent
            return False
        recent.append(moment)
        self.hits[key] = recent
        return True


def load_docs() -> str:
    parts: list[str] = []
    for path in DOC_FILES:
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        parts.append(f"\n\n# Source: {path.name}\n" + text[:DOC_CHAR_CAP])
    return "".join(parts)


def guide_reply(messages: list[dict[str, Any]], complete: Complete) -> str:
    cleaned: list[dict[str, str]] = []
    for message in messages[-12:]:
        role = str(message.get("role") or "")
        if role not in ("user", "assistant"):
            continue
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        if len(content) > MAX_MESSAGE_CHARS:
            raise ValueError(f"Message must be at most {MAX_MESSAGE_CHARS} characters.")
        cleaned.append({"role": role, "content": content})
    if not cleaned or cleaned[-1]["role"] != "user":
        raise ValueError("A user message is required.")
    system = SYSTEM + "\n\nProduct notes:\n" + load_docs()
    reply = (complete(system, cleaned) or "").strip()
    if not reply:
        reply = "I can answer questions about pona flow. When you want an instance, click Get started."
    return reply


def default_complete(system: str, messages: list[dict[str, str]]) -> str:
    """Real model, or a fixed reply when CONTROL_PLANE_GUIDE_FAKE=1 outside production."""
    fake = (os.environ.get("CONTROL_PLANE_GUIDE_FAKE") or "").strip() == "1"
    production = (os.environ.get("CONTROL_PLANE_ENV") or "").strip().lower() == "production"
    if fake and not production:
        return (
            "pona flow keeps the rulebook, the chart, and the checklist in one place. "
            "Use Get started when you want an instance."
        )
    return platform_complete(system, messages)


def platform_complete(system: str, messages: list[dict[str, str]]) -> str:
    """Text-only call. The request never includes tools."""
    key = (os.environ.get("PONA_FLOW_CHAT_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("The guide model is not configured.")
    provider = (os.environ.get("PONA_FLOW_CHAT_PROVIDER") or "openai").strip().lower()
    model = (os.environ.get("PONA_FLOW_CHAT_MODEL") or "").strip()
    if provider == "anthropic":
        return _anthropic(system, messages, key, model or "claude-sonnet-4-5")
    if provider == "gemini":
        return _gemini(system, messages, key, model or "gemini-3.8-flash")
    return _openai(system, messages, key, model or "gpt-4.1", provider)


def _post_json(url: str, body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Guide model failed (HTTP {exc.code})") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Guide model returned an unexpected body")
    return payload


def _openai(system: str, messages: list[dict[str, str]], key: str, model: str, provider: str) -> str:
    base = (os.environ.get("PONA_FLOW_CHAT_BASE_URL") or "").strip().rstrip("/")
    if not base:
        base = "https://api.openai.com/v1" if provider != "openai_compatible" else ""
    if not base:
        raise RuntimeError("PONA_FLOW_CHAT_BASE_URL is required for this provider.")
    payload = _post_json(
        base + "/chat/completions",
        {
            "model": model,
            "messages": [{"role": "system", "content": system}, *messages],
        },
        {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    choices = payload.get("choices") if isinstance(payload.get("choices"), list) else []
    message = choices[0].get("message") if choices and isinstance(choices[0], dict) else {}
    if isinstance(message, dict) and message.get("tool_calls"):
        return ""
    content = message.get("content") if isinstance(message, dict) else ""
    return str(content or "")


def _anthropic(system: str, messages: list[dict[str, str]], key: str, model: str) -> str:
    payload = _post_json(
        "https://api.anthropic.com/v1/messages",
        {"model": model, "max_tokens": 800, "system": system, "messages": messages},
        {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
    )
    blocks = payload.get("content") if isinstance(payload.get("content"), list) else []
    texts = [str(block.get("text") or "") for block in blocks if isinstance(block, dict) and block.get("type") == "text"]
    return "\n".join(part for part in texts if part).strip()


def _gemini(system: str, messages: list[dict[str, str]], key: str, model: str) -> str:
    contents = []
    for message in messages:
        role = "model" if message["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": message["content"]}]})
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    payload = _post_json(
        url,
        {"system_instruction": {"parts": [{"text": system}]}, "contents": contents},
        {"Content-Type": "application/json"},
    )
    candidates = payload.get("candidates") if isinstance(payload.get("candidates"), list) else []
    content = candidates[0].get("content") if candidates and isinstance(candidates[0], dict) else {}
    parts = content.get("parts") if isinstance(content, dict) else []
    texts = []
    for part in parts if isinstance(parts, list) else []:
        if isinstance(part, dict) and part.get("text") and not part.get("functionCall"):
            texts.append(str(part["text"]))
    return "\n".join(texts).strip()
