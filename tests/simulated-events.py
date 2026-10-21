"""
Diagnostic test for simulated events.

Covers schedule eligibility, weight fallback, tic advance (with the sequence runner
stubbed), cancel-when-sum-is-0, error blocking the next tic until clear-error,
session delete, the public token API, the authenticated API, and space/event delete
cascades.

Run (from repo root, with the project venv so FastAPI is importable):
    .venv/bin/python tests/simulated-events.py
"""

import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


tmpdir = tempfile.mkdtemp(prefix="pona-flow-simulated-events-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

# Legacy events table (no 'simulated' in the type CHECK, no simulation_package).
# The first catalog connection must rebuild it.
_seed = sqlite3.connect(tmp_db)
_seed.execute("CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)")
_seed.execute("INSERT INTO spaces (id, name) VALUES ('demo', 'demo')")
_seed.execute(
    """
    CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        space_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'time' CHECK (type IN ('time', 'external')),
        enabled INTEGER NOT NULL DEFAULT 1,
        event_package TEXT NOT NULL DEFAULT '{}',
        external_package TEXT NOT NULL DEFAULT '{}',
        sequences TEXT NOT NULL DEFAULT '[]',
        timers TEXT NOT NULL DEFAULT '{}',
        recovery_sequences TEXT NOT NULL DEFAULT '[]',
        creation_date TEXT NOT NULL DEFAULT (datetime('now')),
        modified_date TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """
)
_seed.execute(
    "INSERT INTO events (id, space_id, name, type) VALUES ('EV_old', 'demo', 'legacy', 'time')"
)
_seed.commit()
_seed.close()

from Engine.server import catalog, simulation  # noqa: E402
from Engine.server import migrations  # noqa: E402

# --- audit CHECK rebuild accepts 'simulated' --------------------------------
_audit = sqlite3.connect(":memory:")
_audit.execute(
    """
    CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        run_at TEXT,
        space_id TEXT,
        sequence_ids TEXT,
        event_id TEXT,
        trigger TEXT CHECK (trigger IN ('manual', 'external')),
        principal_id TEXT
    )
    """
)
migrations._ensure_audit_log_trigger_check(_audit)
_audit_sql = _audit.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'"
).fetchone()[0]
check("audit trigger check rebuild includes simulated", "'simulated'" in (_audit_sql or ""))
_audit.close()

# Touching the catalog rebuilds the legacy events table.
rebuilt = catalog.get_event("EV_old")
check("legacy time event survives the type-check rebuild", rebuilt is not None and rebuilt["type"] == "time")
check("rebuilt event exposes simulation_package", isinstance((rebuilt or {}).get("simulation_package"), dict))

# --- schedules --------------------------------------------------------------
recurring = {"schedule": {"type": "recurring", "every_x": 2, "delay_y": 1}}
check("recurring waits out the delay", not simulation.is_probability_eligible(recurring, 0))
check("recurring fires on delay + N*every", simulation.is_probability_eligible(recurring, 1 + 2))
check("recurring skips the in-between tic", not simulation.is_probability_eligible(recurring, 2))

scheduled = {"schedule": {"type": "scheduled", "tics": [2, 5]}}
check("scheduled misses tic 1", not simulation.is_probability_eligible(scheduled, 1))
check("scheduled hits a listed tic", simulation.is_probability_eligible(scheduled, 5))

random_never = {"schedule": {"type": "random", "every_x": 1, "percent": 0}}
random_always = {"schedule": {"type": "random", "every_x": 1, "percent": 100}}
check("random percent 0 is never due", not simulation.is_probability_due(random_never, 1))
check("random percent 100 is due", simulation.is_probability_due(random_always, 1))
check("random does not fire on tic 0", not simulation.is_probability_eligible(random_always, 0))

# --- weights ----------------------------------------------------------------
runs: list[dict] = []
script: list[dict] = []
stopped: list[str] = []
waiters: list[dict] = []


def _stub_run(space_id, sequence_id, params=None, **kwargs):
    runs.append(
        {
            "space_id": space_id,
            "sequence_id": sequence_id,
            "params": dict(params or {}),
            "trigger": kwargs.get("trigger"),
            "event_id": kwargs.get("event_id"),
            "principal_id": kwargs.get("principal_id"),
            "detail": kwargs.get("audit_detail"),
        }
    )
    if script:
        return script.pop(0)
    return {"status": "inactive", "resolved": {}, "state_id": "ST_stub"}


def _stub_stop(space_id, state_id=None, sequence_id=None):
    stopped.append(str(state_id or ""))
    return {"status": "cancelled"}


def _stub_waiters(event_id, params=None, trigger="event"):
    waiters.append({"event_id": event_id, "params": dict(params or {}), "trigger": trigger})


simulation.sequence_service.run_sequence_once = _stub_run  # type: ignore[assignment]
simulation.execution.stop_execution = _stub_stop  # type: ignore[assignment]
simulation.scheduler._resume_event_waiters = _stub_waiters  # type: ignore[assignment]


def _weights(outcomes, resolved_queue, defaults=None):
    script.clear()
    runs.clear()
    for resolved in resolved_queue:
        script.append({"status": "inactive", "resolved": resolved, "state_id": "ST_w"})
    if defaults is not None:
        simulation._parameter_default = lambda *_a, **_k: defaults  # type: ignore[assignment]
    else:
        simulation._parameter_default = lambda *_a, **_k: None  # type: ignore[assignment]
    event_pkg = {"outcomes": outcomes}
    session = {"id": "SES"}
    return simulation.resolve_weights("demo", "EV", session, event_pkg, 1, "t", None)


check("static weight is used as-is", _weights([{"weight": 5}], []) == [5])
check("negative static weight clamps to 0", _weights([{"weight": -3}], []) == [0])
check("numeric string weight is static", _weights([{"weight": "2.5"}], []) == [2.5])
check(
    "$parameter reads the resolved map",
    _weights(
        [{"weight": "$rain_score", "weight_sequence_id": "SEQ_W", "label": "Rain"}],
        [{"rain_score": 4}],
    )
    == [4],
)
check("weight sequence ran once", len(runs) == 1 and runs[0]["sequence_id"] == "SEQ_W")
check("weight run is trigger simulated", runs[0]["detail"]["role"] == "weight")
check(
    "non-numeric resolved value uses the parameter default",
    _weights(
        [{"weight": "$rain_score", "weight_sequence_id": "SEQ_W"}],
        [{"rain_score": "nope"}],
        defaults=7,
    )
    == [7],
)
check(
    "missing parameter with no default is 0",
    _weights(
        [{"weight": "$missing", "weight_sequence_id": "SEQ_W"}],
        [{}],
        defaults=None,
    )
    == [0],
)
check(
    "dotted $path reads a nested resolved value",
    _weights(
        [{"weight": "$score.value", "weight_sequence_id": "SEQ_W"}],
        [{"score": {"value": 9}}],
    )
    == [9],
)
check(
    "$parameter without a sequence is 0",
    _weights([{"weight": "$rain_score"}], []) == [0] and len(runs) == 0,
)

# pending weight: cancel the parked run, then default / 0
script.clear()
runs.clear()
stopped.clear()
script.append({"status": "pending", "state_id": "ST_parked", "resolved": {"rain_score": 99}})
simulation._parameter_default = lambda *_a, **_k: None  # type: ignore[assignment]
pending_weights = simulation.resolve_weights(
    "demo",
    "EV",
    {"id": "SES"},
    {"outcomes": [{"weight": "$rain_score", "weight_sequence_id": "SEQ_W"}]},
    1,
    "t",
    None,
)
check("pending weight falls through to 0", pending_weights == [0])
check("pending weight run is cancelled", stopped == ["ST_parked"])

# weight sequence error stops the caller
script.clear()
script.append({"status": "error", "message": "weight broke", "state_id": "ST_bad"})
try:
    simulation.resolve_weights(
        "demo",
        "EV",
        {"id": "SES"},
        {"outcomes": [{"weight": "$rain_score", "weight_sequence_id": "SEQ_W"}]},
        1,
        "t",
        None,
    )
    check("weight sequence error raises", False)
except simulation.SimulationHalt as err:
    check("weight sequence error raises", "weight broke" in str(err))

# --- tic advance ------------------------------------------------------------
PACKAGE = {
    "tic_unit": "hours",
    "tic_duration": 2,
    "sequence_id": "SEQ_EMIT",
    "probabilities": [
        {
            "id": "prb_late",
            "name": "Later",
            "priority": 2,
            "schedule": {"type": "recurring", "every_x": 1, "delay_y": 0},
            "outcomes": [{"id": "out_b", "label": "B", "weight": 1, "payload": {"kind": "b"}}],
        },
        {
            "id": "prb_first",
            "name": "First",
            "priority": 1,
            "schedule": {"type": "recurring", "every_x": 1, "delay_y": 0},
            "outcomes": [{"id": "out_a", "label": "A", "weight": 3, "payload": {"kind": "a"}}],
        },
        {
            "id": "prb_skip",
            "name": "Skip",
            "priority": 0,
            "schedule": {"type": "scheduled", "tics": [2]},
            "outcomes": [{"id": "out_c", "label": "C", "weight": 1, "payload": {}}],
        },
    ],
}

catalog.upsert_event(
    "EV_sim",
    "demo",
    "Weather world",
    {},
    [],
    [],
    type="simulated",
    enabled=1,
    simulation_package={**PACKAGE, "token": "sim_testtoken"},
)
stored = catalog.get_event("EV_sim")
check("upsert keeps simulated type", stored is not None and stored["type"] == "simulated")
check(
    "upsert keeps the public token",
    (stored or {}).get("simulation_package", {}).get("token") == "sim_testtoken",
)

# Second save without a package preserves the token (route does this; catalog preserves None).
catalog.upsert_event(
    "EV_sim",
    "demo",
    "Weather world",
    {},
    [],
    [],
    type="simulated",
    enabled=1,
    simulation_package=None,
)
preserved = catalog.get_event("EV_sim")
check(
    "omitted simulation package is preserved",
    (preserved or {}).get("simulation_package", {}).get("token") == "sim_testtoken",
)

event = catalog.get_event("EV_sim")
assert event is not None
session = simulation.create_session(event, "2026-01-01T00:00:00Z")
check("session starts at tic 0", session["current_tic"] == 0)
check("session clock is the in-world start", session["world_start_at"].startswith("2026-01-01T00:00:00"))

runs.clear()
waiters.clear()
script.clear()
advanced = simulation.advance_session(event, session["id"], principal_id="user_1")
names = [row["probability_name"] for row in advanced["emissions"]]
check("tic 1 skips the scheduled-only probability", names == ["First", "Later"])
check("priority 1 runs before priority 2", names[0] == "First")
check("in-world clock advanced two hours", advanced["current_world_time"].startswith("2026-01-01T02:00:00"))
check("emission ran the event sequence", len(runs) == 2 and all(row["sequence_id"] == "SEQ_EMIT" for row in runs))
check("outcome payload is a sequence param", runs[0]["params"].get("kind") == "a")
check("payload did not drop the outcome label context", runs[0]["params"].get("outcome_label") == "A")
check("emission context marks cancelled false", runs[0]["params"].get("cancelled") is False)
check("authenticated advance records the principal", runs[0]["principal_id"] == "user_1")
check("waiters resume for a chosen outcome", len(waiters) == 2 and waiters[0]["trigger"] == "simulated")
check("emission audit role is emission", runs[0]["detail"]["role"] == "emission")

# All-zero weights cancel: no sequence, no waiters.
catalog.upsert_event(
    "EV_cancel",
    "demo",
    "Cancels",
    {},
    [],
    [],
    type="simulated",
    enabled=1,
    simulation_package={
        "token": "sim_cancel",
        "tic_unit": "minutes",
        "tic_duration": 1,
        "sequence_id": "SEQ_EMIT",
        "probabilities": [
            {
                "id": "prb_z",
                "name": "Zero",
                "priority": 1,
                "schedule": {"type": "recurring", "every_x": 1, "delay_y": 0},
                "outcomes": [
                    {"id": "o1", "label": "A", "weight": 0, "payload": {}},
                    {"id": "o2", "label": "B", "weight": -4, "payload": {}},
                ],
            }
        ],
    },
)
cancel_event = catalog.get_event("EV_cancel")
assert cancel_event is not None
cancel_session = simulation.create_session(cancel_event, "2026-06-01T00:00:00Z")
runs.clear()
waiters.clear()
cancelled = simulation.advance_session(cancel_event, cancel_session["id"])
check("all-zero weights cancel the emission", cancelled["emissions"][0]["cancelled"] is True)
check("cancelled emission does not run the sequence", runs == [])
check("cancelled emission does not resume waiters", waiters == [])

# Emission error stops the session; the next tic is refused until clear-error.
script.clear()
script.append({"status": "error", "message": "sequence broke", "state_id": "ST_emit"})
broken_event = catalog.get_event("EV_sim")
assert broken_event is not None
broken = simulation.advance_session(broken_event, session["id"])
check("failed emission sets session error", broken["status"] == "error")
check("failed emission still advances the tic", broken["current_tic"] == 2)
check("error message is kept", "sequence broke" in (broken["error_message"] or ""))
try:
    simulation.advance_session(broken_event, session["id"])
    check("error blocks the next tic", False)
except simulation.SimulationRejected as err:
    check("error blocks the next tic", err.status_code == 409)
cleared = simulation.clear_session_error(broken_event, session["id"])
check("clear-error returns the session to running", cleared["status"] == "running" and not cleared["error_message"])

# Disabled event refuses create / advance / delete.
catalog.upsert_event(
    "EV_off",
    "demo",
    "Off",
    {},
    [],
    [],
    type="simulated",
    enabled=0,
    simulation_package={"token": "sim_off", "tic_unit": "minutes", "tic_duration": 1, "probabilities": []},
)
off = catalog.get_event("EV_off")
assert off is not None
try:
    simulation.create_session(off, "2026-01-01T00:00:00Z")
    check("disabled event refuses create", False)
except simulation.SimulationRejected as err:
    check("disabled event refuses create", err.status_code == 403)

# Delete session removes emissions.
simulation.delete_session(cancel_event, cancel_session["id"])
check("deleted session is gone", catalog.get_simulation_session(cancel_session["id"]) is None)
check(
    "deleted session emissions are gone",
    catalog.list_simulation_emissions(cancel_session["id"]) == [],
)

# Event delete cascades history.
kept = simulation.create_session(event, "2026-01-02T00:00:00Z")
catalog.delete_event("EV_sim")
check("event delete removes its sessions", catalog.get_simulation_session(kept["id"]) is None)

# --- HTTP: public token + authenticated ------------------------------------
from fastapi.testclient import TestClient  # noqa: E402

from Engine.server import app as app_module  # noqa: E402
from Engine.server.auth import Principal  # noqa: E402
from Engine.server import auth  # noqa: E402

catalog.upsert_event(
    "EV_http",
    "demo",
    "HTTP world",
    {},
    [],
    [],
    type="simulated",
    enabled=1,
    simulation_package={
        "token": "sim_http",
        "tic_unit": "minutes",
        "tic_duration": 15,
        "sequence_id": "",
        "probabilities": [
            {
                "id": "prb_http",
                "name": "Pulse",
                "priority": 1,
                "schedule": {"type": "recurring", "every_x": 1, "delay_y": 0},
                "outcomes": [{"id": "out_http", "label": "tick", "weight": 1, "payload": {"n": 1}}],
            }
        ],
    },
)

app_module.app.dependency_overrides[auth.current_principal_or_agent] = lambda: Principal(
    user_id="user_http",
    clerk_user_id="clerk_http",
    email="http@example.com",
    is_instance_admin=True,
    is_superadmin=True,
)
client = TestClient(app_module.app, raise_server_exceptions=False)

r = client.post("/api/sim/sim_missing/sessions", json={"world_start_at": "2026-01-01T00:00:00Z"})
check("unknown simulation token is 404", r.status_code == 404)

r = client.post("/api/sim/sim_http/sessions", json={"world_start_at": "not-a-date"})
check("bad world_start_at is 400", r.status_code == 400)

r = client.post("/api/sim/sim_http/sessions", json={"world_start_at": "2026-03-01T12:00:00Z"})
check("public create returns 201", r.status_code == 201)
public_session = r.json()["id"]
check("public create starts at tic 0", r.json()["current_tic"] == 0)

r = client.post(f"/api/sim/sim_http/sessions/{public_session}/tic")
check("public advance returns the emission", r.status_code == 200 and r.json()["current_tic"] == 1)
check(
    "public advance recorded the outcome",
    r.json()["emissions"][0]["outcome"]["label"] == "tick" and r.json()["emissions"][0]["run_status"] == "recorded",
)

r = client.delete(f"/api/sim/sim_http/sessions/{public_session}")
check("public delete returns deleted", r.status_code == 200 and r.json()["deleted"] is True)
r = client.post(f"/api/sim/sim_http/sessions/{public_session}/tic")
check("advance after delete is 404", r.status_code == 404)

r = client.post(
    "/api/events/upsert",
    json={
        "id": "EV_route",
        "space_id": "demo",
        "name": "Route world",
        "type": "simulated",
        "enabled": True,
        "event_package": {},
        "simulation_package": {
            "tic_unit": "minutes",
            "tic_duration": 1,
            "sequence_id": "",
            "probabilities": [],
        },
        "sequences": ["should-be-ignored-by-client"],
        "recovery_sequences": [],
    },
)
check("authenticated upsert mints a simulation token", r.status_code == 200 and str(r.json().get("simulation_token") or "").startswith("sim_"))
minted = r.json()["simulation_token"]
r = client.post(
    "/api/events/upsert",
    json={
        "id": "EV_route",
        "space_id": "demo",
        "name": "Route world",
        "type": "simulated",
        "enabled": True,
        "event_package": {},
        "simulation_package": {"tic_unit": "minutes", "tic_duration": 1, "probabilities": [], "token": "sim_nope"},
        "sequences": [],
        "recovery_sequences": [],
    },
)
check("second save keeps the original token", r.status_code == 200 and r.json().get("simulation_token") == minted)

r = client.post("/api/events/EV_route/sessions", json={"world_start_at": "2026-04-01T00:00:00Z"})
check("authenticated create returns 201", r.status_code == 201)
auth_session = r.json()["id"]
r = client.get("/api/events/EV_route/sessions")
check("authenticated list includes the session", r.status_code == 200 and any(row["id"] == auth_session for row in r.json()["sessions"]))
r = client.post(f"/api/events/EV_route/sessions/{auth_session}/tic")
check("authenticated advance with no probabilities is an empty tic", r.status_code == 200 and r.json()["emissions"] == [])
r = client.delete(f"/api/events/EV_route/sessions/{auth_session}")
check("authenticated delete removes the session", r.status_code == 200)

r = client.post("/api/events/EV_old/sessions", json={"world_start_at": "2026-01-01T00:00:00Z"})
check("time event refuses session create", r.status_code == 409)

# Disabled public token.
r = client.post("/api/sim/sim_off/sessions", json={"world_start_at": "2026-01-01T00:00:00Z"})
check("disabled public create is 403", r.status_code == 403)

# Space delete cascades simulation rows.
from Engine.server import rbac, spaces  # noqa: E402

_conn = config.connect_sqlite(tmp_db)
for _ddl in ("users-table.sql", "agent-keys-table.sql"):
    _conn.executescript((config.ROOT / "Engine" / "schema" / _ddl).read_text(encoding="utf-8"))
rbac.ensure_rbac_schema(_conn)
_conn.close()
catalog.upsert_event(
    "EV_space",
    "demo",
    "Cascade",
    {},
    [],
    [],
    type="simulated",
    enabled=1,
    simulation_package={"token": "sim_space", "tic_unit": "minutes", "tic_duration": 1, "probabilities": []},
)
space_event = catalog.get_event("EV_space")
assert space_event is not None
space_session = simulation.create_session(space_event, "2026-05-01T00:00:00Z")
spaces.delete_space("demo")
check("space delete removes the simulated event", catalog.get_event("EV_space") is None)
check("space delete removes simulation sessions", catalog.get_simulation_session(space_session["id"]) is None)

print()
if failures:
    print(f"{len(failures)} failed:")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("all simulated-event checks passed")
