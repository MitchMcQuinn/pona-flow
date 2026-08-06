"""
MCP gateway — serve each space's sequences as Model Context Protocol tools.

Purpose in the project
----------------------
This is the per-space MCP server promised in Docs/DECISIONS.md. It is a thin transport
wrapper over ``sequence_service`` (the same primitive the inbound webhook uses), so the
protocol layer adds no new domain logic:

  - ``tools/list`` -> ``sequence_service.list_runnable_sequences`` (filtered by RBAC)
  - ``tools/call`` -> ``sequence_service.run_sequence_once``

Transport is the official MCP SDK's **Streamable HTTP** in **stateless** mode (each
request is independent — ideal behind Cloudflare / multi-instance hosting). One MCP
endpoint is mounted per space at ``/api/spaces/{space_id}/mcp``.

Authentication mirrors the webhook: an ``stg_`` agent key (``X-Pona-Flow-Key`` header or
Bearer) or a Clerk JWT, resolved to a principal that must be a member of the space. The
agent's role decides which sequences appear as tools and which it may call.

The human-in-the-loop pause is surfaced as the tool result: when a sequence needs more
input, the result is the executor's ``pending`` payload (required parameters + a
``state_id``); the caller invokes the tool again with that ``state_id`` to resume.

If the ``mcp`` package is not installed, this module degrades gracefully: ``MCP_AVAILABLE``
is ``False`` and the route/lifespan hooks become no-ops, leaving the rest of the API intact.
"""

from __future__ import annotations

import contextlib
import json
import os
from contextvars import ContextVar
from typing import Any

from starlette.requests import Request

from . import auth, rbac, sequence_service, spaces
from .auth import Principal

try:  # The MCP SDK is an optional dependency (see requirements.txt).
    import mcp.types as mcp_types
    from mcp.server.lowlevel import Server
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    from mcp.server.transport_security import TransportSecuritySettings

    MCP_AVAILABLE = True
except Exception:  # pragma: no cover - import guard
    MCP_AVAILABLE = False


# Per-request context, set by the ASGI handler before delegating to the session manager.
# Stateless Streamable HTTP processes each request in the context active when
# ``handle_request`` is awaited, so the tool handlers read these reliably.
_space_ctx: ContextVar[str] = ContextVar("mcp_space_id", default="")
_principal_ctx: ContextVar[Principal | None] = ContextVar("mcp_principal", default=None)
# The active space's prose description, surfaced as the MCP server's ``instructions`` so
# a client has overall context for the toolset before listing tools.
_space_desc_ctx: ContextVar[str] = ContextVar("mcp_space_description", default="")

# Built once in :func:`mount`; entered for the app's lifetime by :func:`lifespan`.
_session_manager: Any = None


# ---------------------------------------------------------------------------
# Pure helpers (transport-independent; unit-testable without a live server)
# ---------------------------------------------------------------------------

# Sequence parameter value_type -> JSON Schema type. ``UID`` is an opaque id string;
# ``radio`` is a single enum string; ``checkbox`` is an array of enum strings.
_VALUE_TYPE_TO_JSON = {
    "string": "string",
    "number": "number",
    "integer": "integer",
    "boolean": "boolean",
    "array": "array",
    "UID": "string",
    "radio": "string",
    "checkbox": "array",
}

# Optional resume token the caller passes back to continue a paused (human-in-the-loop)
# run. Reserved across all sequence tools; never a sequence parameter name.
STATE_ID_ARG = "state_id"


def build_input_schema(parameters: list[dict[str, Any]]) -> dict[str, Any]:
    """Build a tool ``inputSchema`` from a sequence's aggregated parameters.

    All parameters are modelled as **optional** at the schema level (not ``required``):
    the executor resolves inputs lazily and pauses for whatever is still missing, and a
    resume call supplies only the newly requested value plus ``state_id``. Requiredness is
    surfaced in each property's description instead so a one-shot caller still sees it.
    """
    properties: dict[str, Any] = {}
    for p in parameters:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        value_type = str(p.get("value_type") or "string")
        prop: dict[str, Any] = {"type": _VALUE_TYPE_TO_JSON.get(value_type, "string")}
        hint = "required" if p.get("is_required") else "optional"
        fmt = str(p.get("format") or "").strip()
        # radio/checkbox constrain the agent to the configured options. radio -> one enum
        # string; checkbox -> an array of enum strings honoring the min/max selection counts.
        if value_type in ("radio", "checkbox"):
            options = [str(o) for o in (p.get("options") or []) if str(o).strip()]
            if value_type == "radio":
                if options:
                    prop["enum"] = options
                meta = f"({hint}, choose one)"
            else:
                items: dict[str, Any] = {"type": "string"}
                if options:
                    items["enum"] = options
                prop["items"] = items
                prop["uniqueItems"] = True
                min_choices = p.get("min_choices")
                max_choices = p.get("max_choices")
                if isinstance(min_choices, int) and min_choices >= 0:
                    prop["minItems"] = min_choices
                if isinstance(max_choices, int) and max_choices >= 0:
                    prop["maxItems"] = max_choices
                meta = f"({hint}, choose multiple)"
        elif fmt and fmt.lower() != "any":
            meta = f"({hint}, format: {fmt})"
        else:
            meta = f"({hint})"
        # An author-written parameter description leads (what the agent reads first); the
        # required/format metadata is appended so a one-shot caller still sees both.
        human = str(p.get("description") or "").strip()
        prop["description"] = f"{human} {meta}".strip() if human else meta
        properties[name] = prop

    properties[STATE_ID_ARG] = {
        "type": "string",
        "description": (
            "Resume token from a prior pending result. Omit on the first call; pass it "
            "back (with the requested parameters) to continue a paused run."
        ),
    }
    return {"type": "object", "properties": properties}


def _allowed_to_run(principal: Principal, space_id: str, sequence_id: str) -> bool:
    """Whether a principal may run a sequence in a space (superadmin bypasses)."""
    if principal.is_superadmin:
        return True
    perms = auth.effective_permissions(principal, space_id)
    return rbac.perms_allow_sequence(perms, sequence_id)


def list_runnable_for(principal: Principal, space_id: str) -> list[dict[str, Any]]:
    """The sequences (with parameters) a principal may run in a space."""
    sequences = sequence_service.list_runnable_sequences(space_id)
    return [s for s in sequences if _allowed_to_run(principal, space_id, str(s.get("id") or ""))]


def run_tool(
    principal: Principal, space_id: str, sequence_id: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    """Execute (or resume) a sequence for a tool call. Returns the executor result dict."""
    seq_id = (sequence_id or "").strip()
    if not seq_id:
        return {"status": "error", "message": "missing sequence id"}
    if not _allowed_to_run(principal, space_id, seq_id):
        return {"status": "error", "message": "You are not permitted to run this sequence."}
    args = dict(arguments or {})
    state_id = args.pop(STATE_ID_ARG, None)
    state_id = str(state_id).strip() if state_id else None
    return sequence_service.run_sequence_once(
        space_id,
        seq_id,
        args,
        state_id=state_id,
        owner_id=principal.user_id,
        trigger="mcp",
        principal_id=principal.user_id,
    )


# ---------------------------------------------------------------------------
# MCP server (tool handlers) + Streamable HTTP transport
# ---------------------------------------------------------------------------


def _build_tools(space_id: str, principal: Principal) -> list[Any]:
    """Map a principal's runnable sequences to MCP Tool objects."""
    tools: list[Any] = []
    for seq in list_runnable_for(principal, space_id):
        seq_id = str(seq.get("id") or "")
        if not seq_id:
            continue
        name = str(seq.get("name") or seq_id)
        group = str(seq.get("group_title") or "").strip()
        # Lead with the author's description (the primary text an LLM uses to choose a
        # tool); fall back to a generic line naming the sequence.
        authored = str(seq.get("description") or "").strip()
        description = authored or f"Run the '{name}' sequence."
        if group:
            description += f" (group: {group})"
        description += (
            " Returns the final result, or a 'pending' payload listing the parameters "
            "still required plus a state_id to resume with."
        )
        tools.append(
            mcp_types.Tool(
                name=seq_id,
                title=name,
                description=description,
                inputSchema=build_input_schema(list(seq.get("parameters") or [])),
            )
        )
    return tools


_DEFAULT_INSTRUCTIONS = (
    "Each tool runs one of this pona flow space's sequences. Call a tool with its "
    "parameters; if the response status is 'pending', supply the listed parameters and "
    "the returned state_id on a follow-up call to resume."
)


def _space_instructions() -> str:
    """Per-request MCP ``instructions``: the space description, else a generic fallback.

    Read from a ContextVar (set by the ASGI handler) so the single shared Server can
    return space-specific guidance without a race across concurrent stateless requests.
    """
    desc = _space_desc_ctx.get()
    return desc.strip() if desc and desc.strip() else _DEFAULT_INSTRUCTIONS


def _build_server() -> Any:
    """Construct the low-level MCP Server whose handlers read the per-request context."""
    # ``create_initialization_options`` reads ``self.instructions``; overriding it as a
    # ContextVar-backed property lets one shared server emit per-space instructions.
    class _SpaceAwareServer(Server):
        @property
        def instructions(self) -> str:  # type: ignore[override]
            return _space_instructions()

        @instructions.setter
        def instructions(self, value: Any) -> None:
            self._base_instructions = value

    server = _SpaceAwareServer("pona-flow")

    @server.list_tools()
    async def _list_tools() -> list[Any]:  # noqa: ANN401 - SDK type
        principal = _principal_ctx.get()
        space_id = _space_ctx.get()
        if principal is None or not space_id:
            return []
        return _build_tools(space_id, principal)

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> list[Any]:
        principal = _principal_ctx.get()
        space_id = _space_ctx.get()
        if principal is None or not space_id:
            result: dict[str, Any] = {"status": "error", "message": "unauthenticated"}
        else:
            result = run_tool(principal, space_id, name, arguments or {})
        return [mcp_types.TextContent(type="text", text=json.dumps(result, default=str))]

    return server


def _security_settings() -> Any:
    """Resolve transport DNS-rebinding protection from the environment.

    Disabled by default: the app sits behind Cloudflare (which validates Host) and agent
    keys are the real gate. Set ``PONA_FLOW_MCP_ALLOWED_HOSTS`` (comma-separated) to
    enable strict Host-header validation in front of the gateway.
    """
    raw = (os.environ.get("PONA_FLOW_MCP_ALLOWED_HOSTS") or "").strip()
    if not raw:
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)
    hosts = [h.strip() for h in raw.split(",") if h.strip()]
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True, allowed_hosts=hosts
    )


async def _send_json(send: Any, status_code: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status_code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def _handle_mcp(scope: Any, receive: Any, send: Any) -> None:
    """ASGI entry: authenticate + scope to a space, then delegate to the session manager.

    ``space_id`` is taken from the mount path param. Authentication reads only headers
    (never the body), so the unread ``receive`` stream is handed intact to the transport.
    """
    if scope.get("type") != "http":
        return
    space_id = str((scope.get("path_params") or {}).get("space_id") or "").strip()
    request = Request(scope, receive)
    principal = auth.authenticate_request(request)
    if principal is None:
        await _send_json(send, 401, {"error": "Invalid or missing credentials."})
        return
    if not space_id:
        await _send_json(send, 400, {"error": "space_id is required"})
        return
    # Reuse the same membership gate as the rest of the API (agents are members of exactly
    # their own space, so a mismatched path space is rejected here).
    if not (principal.is_superadmin or auth.is_space_member(principal.user_id, space_id)):
        await _send_json(send, 403, {"error": "You do not have access to this space."})
        return

    try:
        description = spaces.fetch_space_description(space_id)
    except Exception:  # description is non-essential; never block a request on it
        description = ""

    space_token = _space_ctx.set(space_id)
    principal_token = _principal_ctx.set(principal)
    desc_token = _space_desc_ctx.set(description)
    try:
        await _session_manager.handle_request(scope, receive, send)
    finally:
        _space_ctx.reset(space_token)
        _principal_ctx.reset(principal_token)
        _space_desc_ctx.reset(desc_token)


# ---------------------------------------------------------------------------
# Integration hooks (called from app.py)
# ---------------------------------------------------------------------------


def mount(app: Any) -> None:
    """Build the MCP server/transport and mount the per-space route. No-op without the SDK."""
    global _session_manager
    if not MCP_AVAILABLE:
        return
    from starlette.routing import Mount

    server = _build_server()
    _session_manager = StreamableHTTPSessionManager(
        app=server,
        event_store=None,
        json_response=True,
        stateless=True,
        security_settings=_security_settings(),
    )
    app.router.routes.append(Mount("/api/spaces/{space_id}/mcp", app=_handle_mcp))


@contextlib.asynccontextmanager
async def lifespan() -> Any:
    """Run the Streamable HTTP session manager for the app's lifetime (no-op without SDK)."""
    if not MCP_AVAILABLE or _session_manager is None:
        yield
        return
    async with _session_manager.run():
        yield
