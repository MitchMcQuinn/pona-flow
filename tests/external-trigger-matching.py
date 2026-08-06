"""
Diagnostic test for external-trigger payload matching and parameter mapping.

Covers the pure functions in Engine/server/external_triggers.py:
  - resolve_path over nested objects and list indexing (dot and bracket forms);
  - matches() with equals/contains/exists/regex operators and AND/OR combinators;
  - empty/absent filters always match (a bare POST fires the event);
  - extract_params() layering mapped payload values over fixed fallback parameters,
    skipping mappings that resolve to None;
  - verify_signature() with and without a configured secret (HMAC-SHA256).

No database or network needed.

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/external-trigger-matching.py
"""

import hashlib
import hmac
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import external_triggers as et  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# A representative Slack-style event payload.
SLACK = {
    "type": "event_callback",
    "event": {"type": "message", "text": "deploy please", "user": "U123"},
    "items": [{"id": "first"}, {"id": "second"}],
}

# --- resolve_path -----------------------------------------------------------
check("resolve nested object path", et.resolve_path(SLACK, "event.type") == "message")
check("resolve list bracket index", et.resolve_path(SLACK, "items[0].id") == "first")
check("resolve list dotted index", et.resolve_path(SLACK, "items.1.id") == "second")
check("resolve missing key -> None", et.resolve_path(SLACK, "event.missing") is None)
check("resolve out-of-range index -> None", et.resolve_path(SLACK, "items[9].id") is None)
check("blank path returns payload", et.resolve_path(SLACK, "") is SLACK)

# --- matches ----------------------------------------------------------------
check(
    "no filters always matches",
    et.matches({}, SLACK) and et.matches({"filters": []}, SLACK),
)
check(
    "equals filter matches",
    et.matches(
        {"filters": [{"path": "event.type", "operator": "equals", "value": "message"}]},
        SLACK,
    ),
)
check(
    "equals filter rejects mismatch",
    not et.matches(
        {"filters": [{"path": "event.type", "operator": "equals", "value": "reaction"}]},
        SLACK,
    ),
)
check(
    "contains filter matches substring",
    et.matches(
        {"filters": [{"path": "event.text", "operator": "contains", "value": "deploy"}]},
        SLACK,
    ),
)
check(
    "exists filter matches present field",
    et.matches({"filters": [{"path": "event.user", "operator": "exists"}]}, SLACK),
)
check(
    "exists filter rejects absent field",
    not et.matches({"filters": [{"path": "event.nope", "operator": "exists"}]}, SLACK),
)
check(
    "regex filter matches",
    et.matches(
        {"filters": [{"path": "event.text", "operator": "regex", "value": "^deploy"}]},
        SLACK,
    ),
)
check(
    "AND combinator requires all",
    not et.matches(
        {
            "combinator": "AND",
            "filters": [
                {"path": "event.type", "operator": "equals", "value": "message"},
                {"path": "event.user", "operator": "equals", "value": "OTHER"},
            ],
        },
        SLACK,
    ),
)
check(
    "OR combinator requires any",
    et.matches(
        {
            "combinator": "OR",
            "filters": [
                {"path": "event.type", "operator": "equals", "value": "nope"},
                {"path": "event.user", "operator": "equals", "value": "U123"},
            ],
        },
        SLACK,
    ),
)

# --- extract_params ---------------------------------------------------------
params = et.extract_params(
    {
        "parameters": {"channel": "default", "priority": "low"},
        "param_mappings": [
            {"source_path": "event.user", "parameter": "requester"},
            {"source_path": "event.text", "parameter": "message"},
            {"source_path": "event.missing", "parameter": "priority"},
        ],
    },
    SLACK,
)
check("mapped value extracted", params.get("requester") == "U123")
check("second mapped value extracted", params.get("message") == "deploy please")
check("fixed fallback preserved", params.get("channel") == "default")
check("missing mapping falls back to fixed default", params.get("priority") == "low")

# --- verify_signature -------------------------------------------------------
body = b'{"hello":"world"}'
secret = "s3cr3t"
sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
check("no secret -> always verifies", et.verify_signature(None, body, None))
check("valid signature verifies", et.verify_signature(secret, body, sig))
check("valid signature with sha256= prefix", et.verify_signature(secret, body, f"sha256={sig}"))
check("wrong signature rejected", not et.verify_signature(secret, body, "deadbeef"))
check("missing signature rejected when secret set", not et.verify_signature(secret, body, None))

print()
if failures:
    print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
    sys.exit(1)
print("All external-trigger matching checks passed.")
