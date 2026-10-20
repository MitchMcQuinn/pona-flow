"""
Diagnostic test for the inbound external-event receiver (POST /api/hooks/{ingest_token}).

Covers the route wiring in Engine/server/app.py end to end against a throwaway SQLite
catalog (no Neo4j, no scheduler, no Clerk — the lifespan is intentionally not run):
  - a matching payload dispatches the event's sequences and returns 'accepted';
  - a non-matching payload returns 'ignored' without dispatching;
  - an unknown ingest token returns 404;
  - a disabled event returns 403;
  - a signed event rejects a missing/invalid signature (401) and accepts a valid one.

dispatch_external_event is stubbed so matching/auth are exercised without running the
real execution engine.

Run (from repo root, with the project venv so FastAPI + httpx are importable):
    .venv/bin/python tests/external-event-ingest.py
"""

import hashlib
import hmac
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from Engine.server import app as app_module  # noqa: E402
from Engine.server import catalog, config, external_triggers  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


tmpdir = tempfile.mkdtemp(prefix="pona-flow-external-ingest-test-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

# catalog_conn() ensures a spaces table exists via spaces.ensure_catalog_space_schema,
# which expects the table present; create it up front like the other catalog tests.
_seed = config.connect_sqlite(tmp_db)
_seed.execute("CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT)")
_seed.commit()
_seed.close()

# A normal matching external event.
catalog.upsert_event(
    "EV_match",
    "demo",
    "Slack deploy hook",
    {},
    ["ID_seq"],
    [],
    type="external",
    enabled=1,
    external_package={
        "ingest_token": "evt_match",
        "combinator": "AND",
        "filters": [{"path": "event.type", "operator": "equals", "value": "message"}],
        "param_mappings": [{"source_path": "event.user", "parameter": "requester"}],
        "parameters": {},
    },
)

# A disabled event.
catalog.upsert_event(
    "EV_off",
    "demo",
    "Disabled hook",
    {},
    ["ID_seq"],
    [],
    type="external",
    enabled=0,
    external_package={"ingest_token": "evt_off", "filters": [], "parameters": {}},
)

# A signed event (no filters -> fires on any verified request).
SECRET = "s3cr3t"
catalog.upsert_event(
    "EV_secret",
    "demo",
    "Signed hook",
    {},
    ["ID_seq"],
    [],
    type="external",
    enabled=1,
    external_package={
        "ingest_token": "evt_secret",
        "secret": SECRET,
        "filters": [],
        "parameters": {},
    },
)

# Stub dispatch so we test routing/matching/auth without the execution engine.
calls: list[dict] = []


def _stub_dispatch(event, payload, trigger="external"):
    calls.append({"event_id": event.get("id"), "payload": payload, "trigger": trigger})
    return {"ran": list(event.get("sequences") or []), "failed": []}


external_triggers.dispatch_external_event = _stub_dispatch  # type: ignore[assignment]

# TestClient WITHOUT a `with` block so the app lifespan (migrations + scheduler) is not
# run; the route uses catalog functions directly against the temp DB above.
client = TestClient(app_module.app, raise_server_exceptions=False)

# --- matching payload -> accepted + dispatched ------------------------------
calls.clear()
r = client.post("/api/hooks/evt_match", json={"event": {"type": "message", "user": "U1"}})
check("matching payload returns 200", r.status_code == 200)
check("matching payload status accepted", r.json().get("status") == "accepted")
check("matching payload dispatches the event", len(calls) == 1 and calls[0]["event_id"] == "EV_match")

# --- non-matching payload -> ignored, no dispatch ---------------------------
calls.clear()
r = client.post("/api/hooks/evt_match", json={"event": {"type": "reaction"}})
check("non-matching payload returns 200", r.status_code == 200)
check("non-matching payload status ignored", r.json().get("status") == "ignored")
check("non-matching payload does not dispatch", len(calls) == 0)

# --- unknown token -> 404 ---------------------------------------------------
r = client.post("/api/hooks/evt_nope", json={})
check("unknown token returns 404", r.status_code == 404)

# --- disabled event -> 403 --------------------------------------------------
r = client.post("/api/hooks/evt_off", json={})
check("disabled event returns 403", r.status_code == 403)

# --- signed event: missing signature -> 401 ---------------------------------
calls.clear()
r = client.post("/api/hooks/evt_secret", json={"hello": "world"})
check("signed event without signature returns 401", r.status_code == 401)
check("unsigned request does not dispatch", len(calls) == 0)

# --- signed event: valid signature -> accepted ------------------------------
calls.clear()
raw = b'{"hello":"world"}'
sig = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
r = client.post(
    "/api/hooks/evt_secret",
    content=raw,
    headers={"Content-Type": "application/json", "X-Pona-Signature": sig},
)
check("signed event with valid signature returns 200", r.status_code == 200)
check("valid signature dispatches", len(calls) == 1 and calls[0]["event_id"] == "EV_secret")

# --- signed event: wrong signature -> 401 -----------------------------------
r = client.post(
    "/api/hooks/evt_secret",
    content=raw,
    headers={"Content-Type": "application/json", "X-Pona-Signature": "deadbeef"},
)
check("signed event with wrong signature returns 401", r.status_code == 401)

# --- test endpoint: capture without dispatch --------------------------------
calls.clear()
r = client.post("/api/hooks/evt_match/test", json={"ping": "pong", "event": {"type": "other"}})
check("test endpoint returns 200", r.status_code == 200)
check("test endpoint status captured", r.json().get("status") == "captured")
check("test endpoint does not dispatch", len(calls) == 0)
stored = catalog.latest_event_test_capture("EV_match")
check(
    "test endpoint stores the payload",
    isinstance(stored, dict) and (stored.get("payload") or {}).get("ping") == "pong",
)

# A second post replaces the stored sample.
r = client.post("/api/hooks/evt_match/test", json={"ping": "again"})
stored = catalog.latest_event_test_capture("EV_match")
check(
    "test endpoint keeps only the latest payload",
    isinstance(stored, dict) and (stored.get("payload") or {}).get("ping") == "again",
)

# Disabled events still capture (so the hook can be inspected before it is enabled).
calls.clear()
r = client.post("/api/hooks/evt_off/test", json={"n": 1})
check("disabled event test captures", r.status_code == 200)
check("disabled event test does not dispatch", len(calls) == 0)
off = catalog.latest_event_test_capture("EV_off")
check("disabled event test stores payload", isinstance(off, dict) and (off.get("payload") or {}).get("n") == 1)

# Non-JSON bodies are kept as raw text.
r = client.post(
    "/api/hooks/evt_match/test",
    content=b"hello",
    headers={"Content-Type": "text/plain"},
)
raw_stored = catalog.latest_event_test_capture("EV_match")
check(
    "non-json test body stored as raw",
    isinstance(raw_stored, dict) and (raw_stored.get("payload") or {}).get("raw") == "hello",
)

# Unknown token and signature rules match the live receiver.
r = client.post("/api/hooks/evt_nope/test", json={})
check("unknown test token returns 404", r.status_code == 404)
calls.clear()
r = client.post("/api/hooks/evt_secret/test", json={"a": 1})
check("signed test without signature returns 401", r.status_code == 401)
check("unsigned test does not store a capture", catalog.latest_event_test_capture("EV_secret") is None)
raw = b'{"a":1}'
sig = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
r = client.post(
    "/api/hooks/evt_secret/test",
    content=raw,
    headers={"Content-Type": "application/json", "X-Pona-Signature": sig},
)
check("signed test with valid signature returns 200", r.status_code == 200)
signed = catalog.latest_event_test_capture("EV_secret")
check(
    "signed test stores the payload",
    isinstance(signed, dict) and (signed.get("payload") or {}).get("a") == 1,
)
check("signed test does not dispatch", len(calls) == 0)

# Oversized bodies are rejected and do not replace the stored sample.
r = client.post("/api/hooks/evt_match/test", content=b"x" * (256 * 1024 + 1))
check("oversized test body returns 413", r.status_code == 413)
kept = catalog.latest_event_test_capture("EV_match")
check(
    "oversized test body does not replace the capture",
    isinstance(kept, dict) and (kept.get("payload") or {}).get("raw") == "hello",
)

# Reading the capture requires a signed-in principal. Auth-disabled dev bypass
# returns the row; otherwise the route refuses.
r = client.get("/api/events/EV_match/test-capture")
if r.status_code == 200:
    check(
        "authenticated test-capture read returns the payload",
        (r.json().get("capture") or {}).get("payload", {}).get("raw") == "hello",
    )
else:
    check("unauthenticated test-capture read is rejected", r.status_code == 401)

catalog.clear_event_test_capture("EV_match")
check("clear removes the stored payload", catalog.latest_event_test_capture("EV_match") is None)

print()
if failures:
    print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
    sys.exit(1)
print("All external-event ingest checks passed.")
