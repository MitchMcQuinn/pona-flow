"""
Diagnostic test for consoles.

Covers trigger validation, cross-space simulation links, refresh fan-out from
time and external fires, form sequence runs, and the tic payload's console id.

Run (from repo root, with the project venv so FastAPI is importable):
    .venv/bin/python tests/consoles.py
"""

import queue
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


def queued(subscriber: queue.Queue[str]) -> str | None:
    try:
        return subscriber.get(timeout=0.4)
    except queue.Empty:
        return None


tmpdir = tempfile.mkdtemp(prefix="pona-flow-consoles-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

_seed = sqlite3.connect(tmp_db)
_seed.execute("CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)")
_seed.execute("INSERT INTO spaces (id, name) VALUES ('demo', 'demo')")
_seed.execute("INSERT INTO spaces (id, name) VALUES ('other', 'other')")
_seed.commit()
_seed.close()

from Engine.server import catalog, console_hub, console_service, external_triggers, scheduler, simulation  # noqa: E402

# Opening the catalog creates consoles, events, and audit tables.
catalog.list_consoles("demo")
_conn = config.connect_sqlite(tmp_db)
_conn.executescript((config.ROOT / "Engine" / "schema" / "queries-table.sql").read_text(encoding="utf-8"))
_conn.execute(
    "INSERT INTO queries (id, name, kind, operation) VALUES ('SEQ_form', 'Form sequence', 'sequence', 'read')"
)
_conn.execute(
    "INSERT INTO queries (id, name, kind, operation) VALUES ('Q_read', 'Plain query', 'user', 'read')"
)
_conn.execute(
    "INSERT INTO queries (id, name, kind, operation) VALUES ('OP_world', 'READ_WORLD_GRAPH', 'operation', 'read')"
)
_conn.execute(
    "INSERT INTO queries (id, name, kind, operation) VALUES ('SEQ_named', 'Named sequence', 'sequence', 'read')"
)
_conn.execute(
    "INSERT INTO queries (id, name, kind, operation) VALUES ('OP_write', 'SIMULATE_WORLD_TICK', 'operation', 'update')"
)
_conn.commit()
_conn.close()

named = console_service.resolve_console_target("Named sequence")
check("a module can name a sequence", named.get("id") == "SEQ_named" and named.get("kind") == "sequence")
world = console_service.resolve_console_target("READ_WORLD_GRAPH")
check("a module can name a read operation", world.get("id") == "OP_world" and world.get("kind") == "operation")
try:
    console_service.resolve_console_target("missing sequence")
    check("unknown sequence name is rejected", False)
except console_service.ConsoleRunError:
    check("unknown sequence name is rejected", True)

linked = console_service.link_console_document(
    {
        "views": [
            {
                "id": "overview",
                "kind": "live",
                "modules": [
                    {
                        "id": "mod_step",
                        "type": "form",
                        "dataSource": "url",
                        "dataSequenceId": "",
                        "actionSource": "sequence",
                        "actionSequenceId": "SIMULATE_WORLD_TICK",
                    }
                ],
            }
        ]
    }
)
form = linked["views"][0]["modules"][0]
check(
    "a form takes its data sequence from the submit sequence",
    form["dataSequenceId"] == "OP_write"
    and form["dataSource"] == "sequence"
    and form["actionSequenceId"] == "OP_write",
)

DOC = {"views": [{"id": "view-1", "kind": "live", "name": "Live", "modules": []}], "activeViewId": "view-1"}

catalog.upsert_event("EV_time", "demo", "Hourly", {}, [], [], type="time")
catalog.upsert_event("EV_external", "demo", "Inbound", {}, [], [], type="external")
catalog.upsert_event(
    "EV_sim",
    "demo",
    "World",
    {},
    [],
    [],
    type="simulated",
    simulation_package={"tic_unit": "minutes", "tic_duration": 1, "sequence_id": "", "probabilities": []},
)
catalog.upsert_event("EV_other", "other", "Elsewhere", {}, [], [], type="time")

try:
    catalog.upsert_console(
        "CON_bad",
        "demo",
        "Bad trigger",
        trigger_kind="event",
        trigger_event_id="EV_sim",
        document=DOC,
    )
    check("simulated event is rejected as a console trigger", False)
except ValueError as err:
    check("simulated event is rejected as a console trigger", "time or external" in str(err))

try:
    catalog.upsert_console(
        "CON_cross",
        "demo",
        "Cross space",
        trigger_kind="event",
        trigger_event_id="EV_other",
        document=DOC,
    )
    check("trigger event from another space is rejected", False)
except ValueError as err:
    check("trigger event from another space is rejected", "not found in this space" in str(err))

saved = catalog.upsert_console(
    "CON_time",
    "demo",
    "Ops",
    trigger_kind="event",
    trigger_event_id="EV_time",
    listen_url="https://example.test/ignore",
    document=DOC,
)
check("event trigger clears a listen url", saved.get("listen_url") == "" and saved.get("trigger_event_id") == "EV_time")

url_console = catalog.upsert_console(
    "CON_url",
    "demo",
    "Listen",
    trigger_kind="url",
    listen_url="https://example.test/events",
    trigger_event_id="EV_time",
    document=DOC,
)
check(
    "url trigger clears the event id",
    url_console.get("trigger_kind") == "url" and url_console.get("trigger_event_id") == "",
)

# --- refresh fan-out --------------------------------------------------------
time_listener = console_hub.subscribe("CON_time")
check("quiet listener is not notified early", queued(time_listener) is None)

scheduler._fire_event({"id": "EV_time", "space_id": "demo", "sequences": [], "event_package": {}}, "event")
check("time fire notifies the bound console", queued(time_listener) == "refresh")
check("time fire does not notify twice", queued(time_listener) is None)

catalog.upsert_console(
    "CON_ext",
    "demo",
    "Inbound board",
    trigger_kind="event",
    trigger_event_id="EV_external",
    document=DOC,
)
ext_listener = console_hub.subscribe("CON_ext")
external_triggers.dispatch_external_event(
    {"id": "EV_external", "space_id": "demo", "sequences": [], "external_package": {}},
    {"hello": "world"},
)
check("external fire notifies the bound console", queued(ext_listener) == "refresh")
check("external fire leaves the other console quiet", queued(time_listener) is None)

# A simulated tic must not publish. The client refreshes from the tic payload.
other_console = catalog.upsert_console("CON_other", "other", "Other board", document=DOC)
sim_listener = console_hub.subscribe("CON_time")
event = catalog.get_event("EV_sim")
assert event is not None
event = {
    **event,
    "simulation_package": {**event["simulation_package"], "console_id": "CON_time"},
}
session = simulation.create_session(event, "2026-06-01T00:00:00Z")
advanced = simulation.advance_session(event, session["id"])
check("tic payload includes the console id", advanced.get("console_id") == "CON_time")
check("a simulated tic does not publish a console refresh", queued(sim_listener) is None)
check("tic without a console id is blank", simulation.advance_session(catalog.get_event("EV_sim"), session["id"]).get("console_id") == "")

# --- form sequence runs -----------------------------------------------------
script: list[dict] = []
resumed: list = []


def _stub_run(space_id, sequence_id, params=None, state_id=None, **kwargs):
    resumed.append(state_id)
    if script:
        return script.pop(0)
    return {"status": "inactive", "final_result": {"note": "kept", "space_id": space_id}}


console_service.sequence_service.run_sequence_once = _stub_run  # type: ignore[assignment]
console = catalog.get_console("CON_time")
assert console is not None

ran = console_service.execute_console_sequence(console, "SEQ_form", "view-1", "data", {"note": "a"}, "user_1")
check(
    "inactive run returns final_result",
    ran.get("status") == "inactive" and isinstance(ran.get("final_result"), dict) and ran["final_result"].get("note") == "kept",
)

script.append({"status": "pending", "state_id": "ST_pause", "step_id": "step-2", "parameters": [{"name": "owner"}]})
paused = console_service.execute_console_sequence(console, "SEQ_form", "view-1", "action", {}, "user_1")
check(
    "pending run returns the next parameters",
    paused.get("status") == "pending"
    and paused.get("state_id") == "ST_pause"
    and paused.get("parameters") == [{"name": "owner"}],
)

script.append({"status": "error", "message": "sequence failed"})
try:
    console_service.execute_console_sequence(console, "SEQ_form", "view-1", "action", {}, "user_1")
    check("error run is 400", False)
except console_service.ConsoleRunError as err:
    check("error run is 400", err.status_code == 400 and "sequence failed" in str(err))

try:
    console_service.execute_console_sequence(console, "Q_read", "view-1", "data", {}, "user_1")
    check("non-sequence query is rejected", False)
except console_service.ConsoleRunError as err:
    check("non-sequence query is rejected", err.status_code == 400)

try:
    console_service.execute_console_sequence(console, "OP_write", "view-1", "data", {}, "user_1")
    check("a write operation is not module data", False)
except console_service.ConsoleRunError as err:
    check("a write operation is not module data", err.status_code == 400)

# --- HTTP -------------------------------------------------------------------
from fastapi.testclient import TestClient  # noqa: E402

from Engine.server import app as app_module  # noqa: E402
from Engine.server import auth  # noqa: E402
from Engine.server.auth import Principal  # noqa: E402

app_module.app.dependency_overrides[auth.current_principal_or_agent] = lambda: Principal(
    user_id="user_http",
    clerk_user_id="clerk_http",
    email="http@example.com",
    is_instance_admin=True,
    is_superadmin=True,
)
client = TestClient(app_module.app, raise_server_exceptions=False)

r = client.post(
    "/api/events/upsert",
    json={
        "id": "EV_link",
        "space_id": "demo",
        "name": "Linked world",
        "type": "simulated",
        "enabled": True,
        "event_package": {},
        "simulation_package": {
            "tic_unit": "minutes",
            "tic_duration": 1,
            "sequence_id": "",
            "probabilities": [],
            "console_id": other_console["id"],
        },
        "sequences": [],
        "recovery_sequences": [],
    },
)
check(
    "cross-space console is rejected on save",
    r.status_code == 400 and "not found in this space" in str(r.json().get("error") or ""),
)

r = client.post(
    "/api/events/upsert",
    json={
        "id": "EV_link",
        "space_id": "demo",
        "name": "Linked world",
        "type": "simulated",
        "enabled": True,
        "event_package": {},
        "simulation_package": {
            "tic_unit": "minutes",
            "tic_duration": 1,
            "sequence_id": "",
            "probabilities": [],
            "console_id": "CON_time",
        },
        "sequences": [],
        "recovery_sequences": [],
    },
)
check("same-space console is saved", r.status_code == 200)
linked = catalog.get_event("EV_link")
check(
    "saved simulation keeps the console id",
    (linked or {}).get("simulation_package", {}).get("console_id") == "CON_time",
)

r = client.post("/api/events/EV_link/sessions", json={"world_start_at": "2026-07-01T00:00:00Z"})
check("linked session is created", r.status_code == 201)
session_id = r.json()["id"]
r = client.post(f"/api/events/EV_link/sessions/{session_id}/tic")
check("authenticated tic payload includes console_id", r.status_code == 200 and r.json().get("console_id") == "CON_time")

r = client.post(
    "/api/consoles/CON_time/run",
    json={"sequenceId": "SEQ_form", "viewId": "view-1", "role": "data", "params": {}},
)
check(
    "/run returns final_result",
    r.status_code == 200 and (r.json().get("final_result") or {}).get("note") == "kept",
)

script.append({"status": "pending", "state_id": "ST_http", "step_id": "step-2", "parameters": [{"name": "owner"}]})
r = client.post(
    "/api/consoles/CON_time/run",
    json={"sequenceId": "SEQ_form", "viewId": "view-1", "role": "action", "params": {}, "stateId": "ST_http"},
)
body = r.json()
check(
    "/run pending returns parameters and resumes that state",
    r.status_code == 200
    and body.get("status") == "pending"
    and body.get("state_id") == "ST_http"
    and resumed[-1] == "ST_http",
)

catalog.delete_event("EV_time")
cleared = catalog.get_console("CON_time")
check(
    "deleting a trigger event clears the console trigger",
    (cleared or {}).get("trigger_kind") == "" and (cleared or {}).get("trigger_event_id") == "",
)

console_hub.unsubscribe("CON_time", time_listener)
console_hub.unsubscribe("CON_time", sim_listener)
console_hub.unsubscribe("CON_ext", ext_listener)

print()
if failures:
    print(f"{len(failures)} failed:")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("all console checks passed")
