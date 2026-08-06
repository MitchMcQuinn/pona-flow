"""
Diagnostic test for the MCP gateway (Engine/server/mcp_gateway.py).

Covers the transport-independent core (no live HTTP server, no Neo4j):
  - build_input_schema: value_type -> JSON type mapping, params optional, state_id added;
  - list_runnable_for / _build_tools: RBAC filtering + Tool mapping (name = sequence id);
  - run_tool: delegates to sequence_service.run_sequence_once, strips state_id, sets the
    'mcp' trigger, and denies a sequence the principal may not run.

Sequence_service and permission resolution are stubbed so the test is hermetic.

Run (from repo root, with the project venv so the mcp SDK + FastAPI are importable):
    .venv/bin/python tests/mcp-gateway-smoke.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import auth, mcp_gateway, sequence_service  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def principal(user_id: str, *, is_super: bool = False) -> auth.Principal:
    return auth.Principal(
        user_id=user_id,
        clerk_user_id="",
        email=None,
        is_instance_admin=is_super,
        is_superadmin=is_super,
        can_create_spaces=is_super,
        principal_type="agent",
    )


if not mcp_gateway.MCP_AVAILABLE:
    print("[FAIL] mcp SDK is not importable; install requirements.txt (mcp>=1.27.0,<2)")
    sys.exit(1)


# --- build_input_schema -----------------------------------------------------

schema = mcp_gateway.build_input_schema(
    [
        {"name": "name", "is_required": True, "value_type": "string", "format": "any", "description": "The person's full name"},
        {"name": "count", "is_required": False, "value_type": "integer"},
        {"name": "flag", "is_required": False, "value_type": "boolean"},
    ]
)
props = schema.get("properties", {})
check("schema is an object", schema.get("type") == "object")
check("string param mapped", props.get("name", {}).get("type") == "string")
check("integer param mapped", props.get("count", {}).get("type") == "integer")
check("boolean param mapped", props.get("flag", {}).get("type") == "boolean")
check("required hint surfaced in description", "required" in props.get("name", {}).get("description", ""))
check("authored param description leads", props.get("name", {}).get("description", "").startswith("The person's full name"))
check("no schema-level required (lazy HITL)", "required" not in schema)
check("state_id resume arg added", props.get(mcp_gateway.STATE_ID_ARG, {}).get("type") == "string")


# --- server instructions (space description) --------------------------------

check("instructions fallback when no description", mcp_gateway._space_instructions() == mcp_gateway._DEFAULT_INSTRUCTIONS)
_desc_token = mcp_gateway._space_desc_ctx.set("Customer onboarding workflows for ACME.")
try:
    check("instructions use space description", mcp_gateway._space_instructions() == "Customer onboarding workflows for ACME.")
finally:
    mcp_gateway._space_desc_ctx.reset(_desc_token)


# --- list_runnable_for / _build_tools (RBAC filtering + Tool mapping) -------

SEQS = [
    {"id": "ID_ok", "name": "Onboard", "group_title": "Ops", "description": "Onboard a new customer and provision their account.", "parameters": [{"name": "name", "is_required": True, "value_type": "string"}]},
    {"id": "ID_denied", "name": "Secret", "group_title": "", "parameters": []},
]


def _stub_list(_space_id: str) -> list:
    return [dict(s) for s in SEQS]


orig_list = sequence_service.list_runnable_sequences
orig_eff = auth.effective_permissions
sequence_service.list_runnable_sequences = _stub_list  # type: ignore[assignment]
# Non-superadmin: may run ID_ok only.
auth.effective_permissions = lambda _p, _s: {  # type: ignore[assignment]
    "flows": [],
    "sequences": {"all": False, "ids": ["ID_ok"]},
    "manage_space": False,
}

try:
    agent = principal("agent1")
    runnable = mcp_gateway.list_runnable_for(agent, "TEST")
    check("RBAC filters runnable sequences", [s["id"] for s in runnable] == ["ID_ok"])

    tools = mcp_gateway._build_tools("TEST", agent)
    check("one tool built", len(tools) == 1)
    check("tool name is the sequence id", tools[0].name == "ID_ok")
    check("tool title is the sequence name", tools[0].title == "Onboard")
    check("authored sequence description leads tool description", tools[0].description.startswith("Onboard a new customer and provision their account."))
    check("tool input schema has the param", "name" in tools[0].inputSchema.get("properties", {}))

    # superadmin sees all sequences regardless of the perms stub
    su_tools = mcp_gateway._build_tools("TEST", principal("root", is_super=True))
    check("superadmin sees all sequences", {t.name for t in su_tools} == {"ID_ok", "ID_denied"})

    # --- run_tool: delegation, state_id stripping, mcp trigger, denial ------
    captured: dict = {}

    def _stub_run(space_id, sequence_id, params, state_id=None, owner_id=None, trigger="webhook", principal_id=None):
        captured.update(
            space_id=space_id,
            sequence_id=sequence_id,
            params=dict(params),
            state_id=state_id,
            owner_id=owner_id,
            trigger=trigger,
            principal_id=principal_id,
        )
        return {"status": "inactive", "state_id": "ID_state", "final_result": {"ok": True}}

    orig_run = sequence_service.run_sequence_once
    sequence_service.run_sequence_once = _stub_run  # type: ignore[assignment]
    try:
        result = mcp_gateway.run_tool(
            agent, "TEST", "ID_ok", {"name": "mitchie", "state_id": "ID_prev"}
        )
        check("run_tool returns executor result", result.get("status") == "inactive")
        check("state_id pulled from arguments", captured.get("state_id") == "ID_prev")
        check("state_id stripped from params", "state_id" not in captured.get("params", {}))
        check("sequence param forwarded", captured.get("params", {}).get("name") == "mitchie")
        check("mcp trigger recorded", captured.get("trigger") == "mcp")
        check("principal id forwarded", captured.get("principal_id") == "agent1")

        denied = mcp_gateway.run_tool(agent, "TEST", "ID_denied", {})
        check("run_tool denies unpermitted sequence", denied.get("status") == "error")
    finally:
        sequence_service.run_sequence_once = orig_run  # type: ignore[assignment]
finally:
    sequence_service.list_runnable_sequences = orig_list  # type: ignore[assignment]
    auth.effective_permissions = orig_eff  # type: ignore[assignment]


print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All MCP gateway smoke checks passed.")
