"""
EXECUTION package executor.

Runs a stored EXECUTION package (built by ``execution_compose``) as a resumable
state machine:
  1. Walk steps in chain order starting from the first step.
  2. Before a step runs, gate on its required parameters. A parameter blocks
     execution only when it is required, not yet resolved, and not provided by
     any response_parameter mapping (i.e. it can only come from a human). In
     that case the run pauses as "pending" and returns *all* of the step's fields
     to prompt (optional included), so the operator can review/override them.
  3. Execute the step (query against Neo4j, HTTP endpoint, or sandboxed code),
     then bind any response_parameter values for downstream steps.
  4. Follow outgoing transitions whose condition_parameter is empty. When a
     condition_parameter is set, gate on it: with a condition_expected boolean,
     follow only when the parameter's strict boolean value matches it (so two
     sibling edges branch on one parameter); otherwise fall back to truthy gating.

Resume progress (remaining queue + resolved values + visited steps) is stored
on the state row so a pending run continues from where it paused.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from . import catalog
from . import config
from . import credentials
from . import cypher_utils
from . import embeddings
from . import graph
from . import local_llms
from . import resources
from . import schema_currency

# Credential reference token ``$secret.<NAME>`` (see cypher_utils.SECRET_REF_RE).
_SECRET_REF_RE = cypher_utils.SECRET_REF_RE

# Explicit User-Agent for outbound endpoint calls (see _execute_endpoint_step).
_OUTBOUND_USER_AGENT = "pona-flow/1.0 (+https://github.com/pona-flow)"

# Code-step parameter token: same shape as the builder's STEP_BODY_PARAM_REF_RE —
# ``$name`` where name is identifier-shaped (excludes $100 / ${42} / $secret.X which
# has a dot and is handled separately).
_CODE_PARAM_REF_RE = re.compile(r"\$(?![0-9])(?!\{[0-9]+\})([A-Za-z_][A-Za-z0-9_]*)\b")

# Input/output validation limits for code-execution steps.
_CODE_PARAM_MAX_BYTES = 64 * 1024  # per substituted parameter value (encoded)
_CODE_JSON_MAX_DEPTH = 32
_CODE_JSON_MAX_ARRAY = 10_000
_CODE_OUTPUT_MAX_BYTES = 1024 * 1024  # cap on the runner's returned payload
_CODE_EXEC_TIMEOUT_SECONDS = 30


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truthy(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "null", "none")
    if isinstance(value, (list, dict, tuple, set)):
        return len(value) > 0
    return bool(value)


def _coerce_bool(value: Any) -> bool:
    """Strict boolean coercion for a transition's expected-result branch.

    Returns True only for the boolean True, the number 1, or the strings "true"
    (case-insensitive) and "1". Everything else — including "false", "0", an
    unresolved (None) parameter, or any unrelated value — coerces to False.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    return str(value).strip().lower() in ("true", "1")


def _extract_path(obj: Any, path: str) -> Any:
    """Navigate a dotted/indexed JSON path (``$.data.id`` or ``items[0].name``)."""
    p = (path or "").strip()
    if p.startswith("$"):
        p = p[1:]
    p = p.lstrip(".")
    if not p:
        return obj
    p = re.sub(r"\[(\d+)\]", r".\1", p)
    cur = obj
    for token in p.split("."):
        if token == "":
            continue
        if isinstance(cur, list):
            try:
                idx = int(token)
            except ValueError:
                return None
            if 0 <= idx < len(cur):
                cur = cur[idx]
            else:
                return None
        elif isinstance(cur, dict):
            if token in cur:
                cur = cur[token]
            else:
                return None
        else:
            return None
    return cur


def _substitute(obj: Any, resolved: dict[str, Any]) -> Any:
    """Replace ``$name`` string placeholders with resolved values (recursively)."""
    if isinstance(obj, dict):
        return {k: _substitute(v, resolved) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_substitute(v, resolved) for v in obj]
    if isinstance(obj, str):
        s = obj.strip()
        if s.startswith("$"):
            name = s[1:]
            if name in resolved:
                return resolved[name]
    return obj


def _resolve_secrets(obj: Any, space_id: str, cache: dict[str, str | None]) -> Any:
    """Resolve ``$secret.<NAME>`` references from the per-space credential store.

    Works on whole-string tokens and tokens embedded in a larger string (e.g.
    ``"Bearer $secret.API_KEY"``). Unknown references are left untouched. Resolved values
    are returned for immediate use only — they are NEVER merged into ``resolved`` or
    persisted into run state, so secrets stay out of the EXECUTION package and audit log.
    """
    if isinstance(obj, dict):
        return {k: _resolve_secrets(v, space_id, cache) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_resolve_secrets(v, space_id, cache) for v in obj]
    if isinstance(obj, str) and "$secret." in obj:
        def _sub(match: "re.Match[str]") -> str:
            name = match.group(1)
            if name not in cache:
                cache[name] = credentials.resolve(space_id, name)
            value = cache[name]
            return value if value is not None else match.group(0)

        return _SECRET_REF_RE.sub(_sub, obj)
    return obj


def _coerce_declared_boolean_params(
    parameters: list[Any] | None, resolved: dict[str, Any]
) -> dict[str, Any]:
    """Convert boolean-declared parameter values to real booleans before Cypher binding.

    Run-panel forms (and webhook callers) submit every value as a string, so a
    parameter declared ``value_type: "boolean"`` would otherwise be stored in the
    graph as the string ``'true'``/``'false'`` — which never equals a Cypher boolean
    literal in a WHERE filter. Unrecognized values pass through untouched.
    """
    out = dict(resolved)
    for p in parameters or []:
        if not isinstance(p, dict):
            continue
        if str(p.get("value_type") or "").strip() != "boolean":
            continue
        name = str(p.get("name") or "").strip()
        if not name or name not in out or isinstance(out[name], bool):
            continue
        text = str(out[name]).strip().lower()
        if text in ("true", "1"):
            out[name] = True
        elif text in ("false", "0"):
            out[name] = False
    return out


def _execute_query_step(
    space_id: str, query_id: str, resolved: dict[str, Any]
) -> dict[str, Any]:
    """Run a referenced query's stored cypher with resolved params; return its response."""
    referenced = catalog.fetch_query_for_compose(query_id)
    if not referenced:
        return {}
    # Runtime policy is enforced at compose time for the top-level sequence only;
    # check it here too so a disabled query cannot run via a step's query_id reference.
    if not int(referenced.get("runtime_enabled", 1)):
        raise PermissionError(
            f"Referenced query {query_id!r} is not runtime-enabled and cannot be run."
        )
    # A suspended operation no longer matches its SCHEMA pattern (a SCHEMA was changed) and
    # must not run until re-saved — including when invoked as a step within a sequence.
    if int(referenced.get("suspended", 0)):
        raise PermissionError(
            f"Referenced query {query_id!r} is suspended: a SCHEMA change invalidated it. "
            "Re-save it to match the new SCHEMA pattern."
        )
    cypher = referenced.get("cypher") or []
    if isinstance(cypher, str):
        cypher = [cypher]
    operation = str(referenced.get("operation") or "read").strip().lower()
    resolved = _coerce_declared_boolean_params(referenced.get("parameters"), resolved)
    # Vector-search operations store CALL db.index.vector.queryNodes; embed the query
    # text here so sequences re-run the stored Cypher without a separate search step.
    # The declared rows say which parameter holds that text when the author named it.
    resolved = embeddings.resolve_search_params(
        space_id, cypher, resolved, referenced.get("parameters")
    )
    records: list[Any] = []
    last_graph: Any = None
    nodes_deleted = 0
    relationships_deleted = 0
    # Collect the INSTANCE labels touched by an update step so we can release stale currency
    # markers from any instance that now conforms (mirrors the /api/execute-query "Run" path).
    instance_labels: set[str] = set()
    for stmt in cypher:
        stmt_text = str(stmt or "").strip()
        if not stmt_text:
            continue
        result = graph.run_cypher_for_space(space_id, stmt_text, dict(resolved))
        records.extend(result.get("records") or [])
        last_graph = result.get("graph")
        counters = (result.get("summary") or {}).get("counters") or {}
        nodes_deleted += int(counters.get("nodes_deleted") or 0)
        relationships_deleted += int(counters.get("relationships_deleted") or 0)
        if operation == "update" and ":INSTANCE" in stmt_text:
            for m in cypher_utils.ATTR_LABEL_RE.finditer(stmt_text):
                label = m.group(1).strip()
                if label:
                    instance_labels.add(label)
    schema_currency.reconcile_labels(
        space_id, instance_labels, log_context=f"step {query_id}"
    )
    embeddings.mark_labels_stale(
        space_id, instance_labels, log_context=f"step {query_id}"
    )
    response: dict[str, Any] = {"records": records}
    # Surface delete counters so a DELETE that matched nothing (0 deleted) is visibly
    # different from a successful delete instead of both reporting an empty response.
    if operation == "delete":
        response["nodes_deleted"] = nodes_deleted
        response["relationships_deleted"] = relationships_deleted
    if records and isinstance(records[0], dict):
        for key, val in records[0].items():
            response.setdefault(key, val)
    if last_graph is not None:
        response["_graph"] = last_graph
    return response


def _outbound_allowlist() -> list[str]:
    """Optional comma-separated host allowlist from PONA_FLOW_OUTBOUND_ALLOWLIST."""
    raw = (os.environ.get("PONA_FLOW_OUTBOUND_ALLOWLIST") or "").strip()
    if not raw:
        return []
    return [h.strip().lower() for h in raw.split(",") if h.strip()]


def _validate_outbound_url(endpoint: str) -> None:
    """SSRF guard: only http(s), no private/loopback/link-local targets, optional allowlist.

    Raises ValueError when the endpoint is not allowed. See Docs/DECISIONS.md (D7).
    Disable host-range checks for trusted self-hosted targets only via
    PONA_FLOW_ALLOW_PRIVATE_OUTBOUND=1.
    """
    parts = urlsplit(endpoint)
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"Endpoint scheme {parts.scheme!r} is not allowed (use http/https).")
    host = (parts.hostname or "").strip()
    if not host:
        raise ValueError("Endpoint host is missing.")

    allowlist = _outbound_allowlist()
    if allowlist and host.lower() not in allowlist:
        raise ValueError(f"Endpoint host {host!r} is not in the outbound allowlist.")

    if os.environ.get("PONA_FLOW_ALLOW_PRIVATE_OUTBOUND", "").strip() in ("1", "true", "TRUE"):
        return

    # Resolve and reject private / loopback / link-local / reserved addresses.
    try:
        infos = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as e:
        raise ValueError(f"Could not resolve endpoint host {host!r}: {e}")
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise ValueError(
                f"Endpoint host {host!r} resolves to a blocked address ({addr})."
            )


def _execute_endpoint_step(
    space_id: str, step: dict[str, Any], resolved: dict[str, Any]
) -> dict[str, Any]:
    """Invoke a custom endpoint with the configured method/headers/body.

    ``$secret.<NAME>`` references in the headers and body are resolved from the space's
    credential store immediately before the request and are never persisted or logged.
    """
    endpoint = str(step.get("endpoint") or "").strip()
    if not endpoint:
        return {}
    _validate_outbound_url(endpoint)
    method = str(step.get("method") or "POST").upper()
    secret_cache: dict[str, str | None] = {}
    headers = step.get("headers")
    req_headers = {
        str(k): str(v) for k, v in headers.items() if isinstance(headers, dict)
    } if isinstance(headers, dict) else {}
    req_headers = _resolve_secrets(req_headers, space_id, secret_cache)
    body = step.get("body")
    body = _substitute(body if isinstance(body, dict) else {}, resolved)
    body = _resolve_secrets(body, space_id, secret_cache)

    data = None
    if method not in ("GET", "DELETE"):
        data = json.dumps(body).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/json")
    # Some hosts (notably Discord behind Cloudflare) reject urllib's default
    # User-Agent with HTTP 403 "error code: 1010", so always send an explicit one
    # unless the step already defines its own.
    if not any(k.lower() == "user-agent" for k in req_headers):
        req_headers["User-Agent"] = _OUTBOUND_USER_AGENT

    request = urllib.request.Request(
        endpoint, data=data, method=method, headers=req_headers
    )
    raw = ""
    status = 0
    error: str | None = None
    try:
        with urllib.request.urlopen(request, timeout=30) as resp:
            status = int(getattr(resp, "status", 0) or 0)
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        status = int(getattr(e, "code", 0) or 0)
        try:
            raw = e.read().decode("utf-8")
        except Exception:
            raw = ""
    except Exception as e:
        error = str(e)

    # Meta keys (``_``-prefixed) carry transport outcome for the visualizer; they are
    # filtered out of any response-parameter binding and the visible response body.
    ok = error is None and 200 <= status < 300
    meta: dict[str, Any] = {"_status": status, "_ok": ok}
    if error is not None:
        meta["_error"] = error
        return meta

    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        # Non-JSON payloads (raw text / XML) are surfaced verbatim.
        return {**meta, "_raw_text": raw}
    if isinstance(parsed, list):
        return {**meta, "records": parsed, "_raw_text": raw}
    if isinstance(parsed, dict):
        out = dict(parsed)
        out.update(meta)
        out["_raw_text"] = raw
        return out
    return {**meta, "value": parsed, "_raw_text": raw}


# ---------------------------------------------------------------------------
# Code-execution steps (sandbox runner)
# ---------------------------------------------------------------------------
#
# The main app NEVER executes user code in-process. A code step ships
# {language, code} to the separate low-privilege runner service (Engine/runner),
# which runs it in a hardened, disposable Docker container and returns a JSON
# envelope. Everything that enters or leaves the sandbox is validated here.


def _validate_json_shape(value: Any, depth: int = 0) -> str | None:
    """Enforce max depth / array length on values entering or leaving the sandbox."""
    if depth > _CODE_JSON_MAX_DEPTH:
        return f"JSON nesting exceeds the maximum depth of {_CODE_JSON_MAX_DEPTH}"
    if isinstance(value, dict):
        for key, item in value.items():
            err = _validate_json_shape(item, depth + 1)
            if err:
                return err
    elif isinstance(value, (list, tuple)):
        if len(value) > _CODE_JSON_MAX_ARRAY:
            return f"array exceeds the maximum length of {_CODE_JSON_MAX_ARRAY}"
        for item in value:
            err = _validate_json_shape(item, depth + 1)
            if err:
                return err
    return None


def _encode_code_literal(value: Any, language: str) -> str:
    """Encode a parameter value as a literal in the target language.

    Values are injected as data, never as code: ``repr`` (Python) and ``json.dumps``
    (JavaScript) both produce quoted/escaped literals that cannot break out of the
    expression position the ``$param`` token occupied.
    """
    if language == "python":
        if isinstance(value, (dict, list, tuple)):
            # Round-trip through JSON first so only JSON-shaped data is injected.
            value = json.loads(json.dumps(value))
        return repr(value)
    return json.dumps(value)


def _substitute_code_params(
    code: str, resolved: dict[str, Any], language: str
) -> tuple[str, str | None]:
    """Replace ``$name`` tokens in code with literal parameter values.

    Mirrors the body-field UX: known parameters are substituted, unknown tokens are
    left untouched (they may be ordinary identifiers in the user's code). Returns
    ``(code, error)``; error is set when a value fails input validation.
    """
    error: str | None = None

    def _sub(match: "re.Match[str]") -> str:
        nonlocal error
        if error:
            return match.group(0)
        name = match.group(1)
        if name == "secret" or name not in resolved:
            return match.group(0)
        value = resolved[name]
        shape_err = _validate_json_shape(value)
        if shape_err:
            error = f"parameter ${name}: {shape_err}"
            return match.group(0)
        literal = _encode_code_literal(value, language)
        if len(literal.encode("utf-8")) > _CODE_PARAM_MAX_BYTES:
            error = (
                f"parameter ${name} exceeds the {_CODE_PARAM_MAX_BYTES // 1024} KB limit"
            )
            return match.group(0)
        return literal

    return _CODE_PARAM_REF_RE.sub(_sub, code), error


def _sanitize_code_error(message: str) -> str:
    """Trim runner/sandbox error text before surfacing it to users.

    Drops absolute host paths and caps the length so a hostile script cannot use the
    error channel to exfiltrate large payloads or probe the host layout.
    """
    text = str(message or "").strip()
    text = re.sub(r"/[\w./-]{8,}", "<path>", text)
    if len(text) > 2000:
        text = text[:2000] + "… (truncated)"
    return text


def _record_code_audit(
    space_id: str, step_id: str, resource_id: str, outcome: str, duration_ms: int
) -> None:
    """Audit one code execution (never the code, parameters, output, or secrets)."""
    try:
        catalog.record_audit(
            space_id,
            [],
            trigger="code",
            detail={
                "kind": "code_execution",
                "step_id": step_id,
                "resource_id": resource_id,
                "outcome": outcome,
                "duration_ms": duration_ms,
            },
        )
    except Exception as audit_err:  # never let audit failures break a run
        sys.stderr.write(f"code-exec audit error: {audit_err}\n")


def _call_runner(payload: dict[str, Any], timeout_seconds: int) -> dict[str, Any]:
    """POST an execution request to the sandbox runner and parse its envelope."""
    token = config.runner_token()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{config.runner_url()}/execute",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        # Generous transport buffer over the sandbox wall-clock limit: the runner
        # enforces the real timeout and kills the container itself.
        with urllib.request.urlopen(request, timeout=timeout_seconds + 15) as resp:
            raw = resp.read(_CODE_OUTPUT_MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        try:
            raw = e.read(_CODE_OUTPUT_MAX_BYTES + 1)
        except Exception:
            raw = b""
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError:
            data = {}
        outcome = str(data.get("outcome") or "").strip() or (
            "rate_limited" if e.code == 429 else "error"
        )
        message = str(data.get("error") or f"runner rejected the execution (HTTP {e.code})")
        return {"ok": False, "outcome": outcome, "error": message}
    except Exception as e:
        return {
            "ok": False,
            "outcome": "unavailable",
            "error": f"code execution runner is unavailable: {e}",
        }
    if len(raw) > _CODE_OUTPUT_MAX_BYTES:
        return {
            "ok": False,
            "outcome": "output_limit",
            "error": "runner response exceeded the output limit",
        }
    try:
        data = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {"ok": False, "outcome": "error", "error": "invalid runner response"}
    return data if isinstance(data, dict) else {
        "ok": False,
        "outcome": "error",
        "error": "invalid runner response",
    }


def _execute_code_step(
    space_id: str, step: dict[str, Any], resolved: dict[str, Any]
) -> dict[str, Any]:
    """Execute a code STEP in the sandbox runner and normalize its result.

    The result is always JSON-wrapped: a JSON-object output is merged into the
    response (so response_parameters paths work unchanged); any other output is
    wrapped as ``{"result": <value>}``. ``$secret.<NAME>`` values are resolved
    immediately before dispatch and never persisted or logged.
    """
    step_id = str(step.get("id") or "")
    resource_id = str(step.get("resource_id") or "").strip()
    if not config.code_exec_enabled():
        _record_code_audit(space_id, step_id, resource_id, "disabled", 0)
        return {"_ok": False, "_error": "Code execution is disabled on this instance."}
    if not resource_id:
        return {"_ok": False, "_error": "Code step has no resource_id configured."}

    try:
        resource = resources.load_for_execution(space_id, resource_id)
    except (KeyError, ValueError, OSError) as e:
        _record_code_audit(space_id, step_id, resource_id, "missing_resource", 0)
        return {"_ok": False, "_error": _sanitize_code_error(str(e))}

    language = str(resource.get("language") or "python")
    code = str(resource.get("code") or "")
    code, param_err = _substitute_code_params(code, resolved, language)
    if param_err:
        _record_code_audit(space_id, step_id, resource_id, "invalid_input", 0)
        return {"_ok": False, "_error": f"Invalid code step input: {param_err}"}
    # Secrets resolve exactly like endpoint headers/body: plain-text token replacement
    # (embed inside quotes in your code). The resolved code text exists only for this
    # request — it is never written to disk, state, or logs.
    secret_cache: dict[str, str | None] = {}
    code = _resolve_secrets(code, space_id, secret_cache)

    started = datetime.now(timezone.utc)
    envelope = _call_runner(
        {
            "language": language,
            "code": code,
            "timeout_seconds": _CODE_EXEC_TIMEOUT_SECONDS,
            "space_id": (space_id or "").strip(),
        },
        _CODE_EXEC_TIMEOUT_SECONDS,
    )
    duration_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)

    ok = bool(envelope.get("ok"))
    outcome = str(envelope.get("outcome") or ("ok" if ok else "error"))
    _record_code_audit(space_id, step_id, resource_id, outcome, duration_ms)

    if not ok:
        error = _sanitize_code_error(str(envelope.get("error") or "code execution failed"))
        return {"_ok": False, "_error": error, "_outcome": outcome}

    result = envelope.get("result")
    shape_err = _validate_json_shape(result)
    if shape_err:
        return {
            "_ok": False,
            "_error": f"Code step output rejected: {shape_err}",
            "_outcome": "output_limit",
        }

    meta: dict[str, Any] = {"_ok": True, "_status": 200, "_outcome": outcome}
    if isinstance(result, dict):
        out = dict(result)
        out.update(meta)
        out["_raw_text"] = json.dumps(result)
        return out
    if isinstance(result, list):
        return {**meta, "records": result, "result": result, "_raw_text": json.dumps(result)}
    # Non-JSON-object output (string / number / null) is wrapped so the
    # response-parameters system can still address it (property_path: $.result).
    return {**meta, "result": result, "_raw_text": json.dumps({"result": result})}


def _local_llm_overrides(resolved: dict[str, Any]) -> dict[str, Any]:
    """This run's optional Local LLM settings, taken from the resolved parameters.

    A parameter left blank never reaches ``resolved`` (the resolve loop skips
    empties), so an absent key means "keep the saved config's value".
    """
    out: dict[str, Any] = {}
    for key in local_llms.OVERRIDE_KEYS:
        if key not in resolved:
            continue
        value = resolved[key]
        if value is None or value == "":
            continue
        out[key] = value
    return out


def _execute_local_llm_step(
    space_id: str, step: dict[str, Any], resolved: dict[str, Any]
) -> dict[str, Any]:
    """Run a saved local LLM config against Ollama using the sequence ``prompt`` param."""
    config_id = str(step.get("config_id") or "").strip()
    if not config_id:
        return {"_ok": False, "_error": "Local LLM step has no config_id configured."}
    prompt = resolved.get("prompt")
    if prompt is None or (isinstance(prompt, str) and not prompt.strip()):
        return {
            "_ok": False,
            "_error": "Local LLM step requires a non-empty sequence parameter named 'prompt'.",
        }
    prompt_text = prompt if isinstance(prompt, str) else str(prompt)
    try:
        result = local_llms.run_config(
            space_id, config_id, prompt_text, _local_llm_overrides(resolved)
        )
    except local_llms.ConfigNotFound as e:
        return {"_ok": False, "_error": str(e)}
    except local_llms.LocalLlmUnavailable as e:
        return {"_ok": False, "_error": str(e)}
    except ValueError as e:
        return {"_ok": False, "_error": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"_ok": False, "_error": f"Local LLM step failed: {e}"}
    out = dict(result)
    out["_ok"] = True
    out["_raw_text"] = json.dumps(
        {
            "config_id": result.get("config_id"),
            "model": result.get("model"),
            "response": result.get("response"),
            "parsed": result.get("parsed"),
            "done_reason": result.get("done_reason"),
            "eval_count": result.get("eval_count"),
        }
    )
    return out


def _execute_step(
    space_id: str, step: dict[str, Any], resolved: dict[str, Any]
) -> dict[str, Any]:
    query_id = str(step.get("query_id") or "").strip()
    if query_id:
        return _execute_query_step(space_id, query_id, resolved)
    kind = str(step.get("kind") or "").strip()
    if kind == "code":
        return _execute_code_step(space_id, step, resolved)
    if kind == "local_llm":
        return _execute_local_llm_step(space_id, step, resolved)
    if str(step.get("endpoint") or "").strip():
        return _execute_endpoint_step(space_id, step, resolved)
    return {}


def _bind_response_parameters(
    response: dict[str, Any],
    response_parameters: list[dict[str, Any]],
    resolved: dict[str, Any],
) -> None:
    for rp in response_parameters:
        param = str(rp.get("parameter") or "").strip()
        if not param:
            continue
        value = _extract_path(response, rp.get("property_path") or "")
        if value is not None:
            resolved[param] = value
        elif param not in resolved and rp.get("default_value") is not None:
            resolved[param] = rp.get("default_value")


def _record_columns(records: list[Any]) -> list[str]:
    columns: list[str] = []
    seen: set[str] = set()
    for record in records:
        if isinstance(record, dict):
            for key in record.keys():
                if key not in seen:
                    seen.add(key)
                    columns.append(key)
    return columns


def _node_like_record_value(value: Any) -> dict[str, Any] | None:
    """A property map that came from returning a graph node (``record.data()``).

    Vector-index ``YIELD node AS x`` is a live Node when the driver hydrates it, but
    some CALL shapes only leave the flattened property map in ``records``. The
    visualizer still needs an ``element_id`` + labels to draw a node.
    """
    if not isinstance(value, dict):
        return None
    nid = str(value.get("id") or "").strip()
    if not nid:
        return None
    al = str(value.get("attributive_label") or "").strip()
    labels = ["INSTANCE"] if al else ["NODE"]
    return {"element_id": nid, "labels": labels, "properties": value}


def _graph_from_records(records: list[Any]) -> dict[str, Any]:
    """Rebuild a graph payload from flattened node maps when ``_graph`` is empty."""
    nodes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rec in records:
        if not isinstance(rec, dict):
            continue
        for val in rec.values():
            node = _node_like_record_value(val)
            if not node or node["element_id"] in seen:
                continue
            seen.add(node["element_id"])
            nodes.append(node)
    return {"nodes": nodes, "relationships": []}


def _classify_final_response(
    step: dict[str, Any], response: dict[str, Any]
) -> dict[str, Any]:
    """
    Normalize the final step's response for the visualizer:
      - query steps with graph data -> ``{"kind": "graph", graph, columns, rows}``
      - query steps with tabular records -> ``{"kind": "table", columns, rows}``
      - everything else (JSON / raw text / XML) -> ``{"kind": "response", response}``
    """
    if not isinstance(response, dict):
        return {"kind": "response", "response": json.dumps(response)}

    if str(step.get("query_id") or "").strip():
        graph = response.get("_graph") or {}
        nodes = graph.get("nodes") or [] if isinstance(graph, dict) else []
        rels = graph.get("relationships") or [] if isinstance(graph, dict) else []
        records = response.get("records") or []
        columns = _record_columns(records)
        if not nodes and not rels and records:
            synthesized = _graph_from_records(records)
            nodes = synthesized.get("nodes") or []
            rels = synthesized.get("relationships") or []
        if nodes or rels:
            return {
                "kind": "graph",
                "graph": {"nodes": nodes, "relationships": rels},
                "columns": columns,
                "rows": records,
            }
        # An empty hit list is still a query result — the UI shows "No rows returned"
        # instead of falling back to the sequence design graph.
        return {"kind": "table", "columns": columns, "rows": records}

    # Custom endpoint: surface the raw JSON / text / XML body plus the transport
    # outcome (HTTP status / network error) so a blocked or failed call is visible
    # rather than silently reported as a success.
    status = response.get("_status")
    ok = response.get("_ok")
    out: dict[str, Any] = {"kind": "response"}
    if isinstance(status, int) and status:
        out["status"] = status
    if isinstance(ok, bool):
        out["ok"] = ok
    network_error = response.get("_error")
    if isinstance(network_error, str) and network_error.strip():
        out["response"] = ""
        out["error"] = network_error
        out["ok"] = False
        return out

    raw_text = response.get("_raw_text")
    if isinstance(raw_text, str) and raw_text.strip():
        out["response"] = raw_text
        return out
    visible = {k: v for k, v in response.items() if not str(k).startswith("_")}
    # An empty body (e.g. Discord's HTTP 204 success) has nothing to render; leave
    # the response blank so the UI shows its "no body" hint instead of "{}".
    out["response"] = json.dumps(visible) if visible else ""
    return out


# ---------------------------------------------------------------------------
# run_execution phases
# ---------------------------------------------------------------------------
#
# The loop below used to be one 234-line function; each phase is now a named
# helper with identical control flow.


def _merge_caller_params(resolved: dict[str, Any], params: dict[str, Any] | None) -> None:
    """Overlay caller-supplied values onto resolved state, skipping blanks."""
    if not params:
        return
    for key, val in params.items():
        if val is None or val == "":
            continue
        resolved[str(key)] = val


def _collect_step_defaults(step: dict[str, Any]) -> dict[str, Any]:
    """A parameter's author-supplied default, keyed by name (non-empty only)."""
    step_defaults: dict[str, Any] = {}
    for p in step.get("parameters") or []:
        if not isinstance(p, dict):
            continue
        pname = str(p.get("name") or "").strip()
        if pname and "default_value" in p:
            step_defaults[pname] = p.get("default_value")
    return step_defaults


def _unresolved_required_params(
    step: dict[str, Any],
    resolved: dict[str, Any],
    response_param_names: set[str],
    step_defaults: dict[str, Any],
    interactive: bool,
) -> list[dict[str, Any]]:
    """Required inputs with no resolved value pause for human entry.

    Interactive (manual) runs always pause so the operator can review/edit the
    pre-filled default; non-interactive runs (scheduler) have no operator, so a
    default satisfies the requirement instead of stalling the run forever.
    """
    unresolved = []
    for p in step.get("parameters") or []:
        # auto_generate parameters are minted by the executor and must never
        # pause the run for human input.
        if not isinstance(p, dict) or not p.get("is_required") or p.get("auto_generate"):
            continue
        pname = str(p.get("name") or "").strip()
        if not pname or pname in resolved or pname in response_param_names:
            continue
        if interactive or pname not in step_defaults:
            unresolved.append(p)
    return unresolved


def _pending_step_parameters(
    step: dict[str, Any], response_param_names: set[str]
) -> list[dict[str, Any]]:
    """All of a paused step's human-facing fields (optional included).

    A required-but-empty parameter triggers the pause, but the operator is shown
    every field for review/override. Response-bound parameters stay excluded since
    those are populated from upstream steps, not human input.
    """
    pending_parameters = []
    for p in step.get("parameters") or []:
        if not isinstance(p, dict) or p.get("auto_generate"):
            continue
        pname = str(p.get("name") or "").strip()
        if not pname or pname in response_param_names:
            continue
        pending_parameters.append(p)
    return pending_parameters


def _apply_step_defaults(step_defaults: dict[str, Any], resolved: dict[str, Any]) -> None:
    """No caller value supplied for a parameter -> fall back to its default so
    ``$name`` placeholders substitute to the default instead of the literal token.
    Existing resolved values (caller input, response params) win."""
    for pname, default_value in step_defaults.items():
        if pname not in resolved:
            resolved[pname] = default_value


def _fill_blank_optional_query_params(
    step: dict[str, Any], resolved: dict[str, Any], response_param_names: set[str]
) -> None:
    """Bind a query step's blank optional parameters to the empty string.

    Optional parameters left blank by the caller (the UI sends "" and the resolve
    loop skips empties) still appear as ``$name`` bindings in a query step's stored
    Cypher, and Neo4j rejects a statement whose referenced parameter is unbound.
    Bind them to the empty string — not null, since MERGE refuses null property
    values — so a blank optional input cannot fail the run. Scoped to query steps
    only: code/endpoint steps deliberately leave unknown ``$name`` tokens untouched
    (they may be plain identifiers). Response-bound parameters stay excluded;
    upstream steps populate those.
    """
    if not str(step.get("query_id") or "").strip():
        return
    for p in step.get("parameters") or []:
        if not isinstance(p, dict) or p.get("is_required") or p.get("auto_generate"):
            continue
        pname = str(p.get("name") or "").strip()
        if pname and pname not in resolved and pname not in response_param_names:
            resolved[pname] = ""


def _mint_auto_ids(step: dict[str, Any], resolved: dict[str, Any]) -> bool:
    """Mint create-INSTANCE graph ids (auto_generate parameters) once per run.

    Returns True when anything was minted — the caller must persist progress
    *before* the step executes so a crash/retry re-runs the step with the same ids
    (MERGE stays idempotent) instead of minting duplicates. Within one run the
    minted value stays in ``resolved``, so later steps binding the same parameter
    address the same entity.
    """
    minted = False
    for p in step.get("parameters") or []:
        if not isinstance(p, dict) or not p.get("auto_generate"):
            continue
        pname = str(p.get("name") or "").strip()
        if pname and pname not in resolved:
            resolved[pname] = config.generate_entity_id()
            minted = True
    return minted


def _enqueue_transitions(
    step: dict[str, Any], resolved: dict[str, Any], queue: list[str]
) -> None:
    """Advance the executed step's outgoing transitions onto the queue."""
    for transition in step.get("next") or []:
        if not isinstance(transition, dict):
            continue
        target = str(transition.get("id") or "").strip()
        if not target:
            continue
        condition_parameter = str(transition.get("condition_parameter") or "").strip()
        if not condition_parameter:
            queue.append(target)
            continue
        value = resolved.get(condition_parameter)
        expected = transition.get("condition_expected")
        if isinstance(expected, bool):
            # Branch on the parameter's strict boolean value: this transition
            # fires only when it matches the expected result, letting a sibling
            # relationship take the opposite branch.
            if _coerce_bool(value) == expected:
                queue.append(target)
        elif _truthy(value):
            # Legacy gating (no expected result configured): follow when truthy.
            queue.append(target)


def run_execution(
    space_id: str,
    state_id: str,
    params: dict[str, Any] | None = None,
    trigger: str = "manual",
    event_id: str | None = None,
    principal_id: str | None = None,
) -> dict[str, Any]:
    """
    Run (or resume) a stored EXECUTION package.

    ``trigger`` / ``event_id`` are recorded in the audit log on a fresh run (manual
    UI runs default to ``"manual"``; the scheduler passes ``"event"`` / ``"recovery"``).
    ``principal_id`` identifies the user behind a manual run and is omitted (NULL) for
    scheduler-fired runs, which have no acting principal.

    Returns one of:
      - ``{"status": "pending", "step_id", "parameters": [...], "resolved": {...}}``
        when a step needs human-supplied parameters.
      - ``{"status": "inactive", "resolved": {...}, "executed": [...]}`` when the
        chain has finished.
      - ``{"status": "error", "message": ...}`` when the state row is missing.
    """
    row = catalog.fetch_state_package(state_id)
    if not row:
        return {"status": "error", "message": "state not found"}

    package = row.get("package") or {}
    steps_list = package.get("steps") or []
    steps_by_id = {
        str(s.get("id")): s for s in steps_list if isinstance(s, dict) and s.get("id")
    }
    response_parameters = [
        rp for rp in (package.get("response_parameters") or []) if isinstance(rp, dict)
    ]
    response_param_names = {
        str(rp.get("parameter") or "").strip() for rp in response_parameters
    }

    progress = row.get("progress") or {}
    resolved: dict[str, Any] = dict(progress.get("resolved") or {})
    _merge_caller_params(resolved, params)
    visited: set[str] = set(progress.get("visited") or [])
    stored_queue = progress.get("queue")

    if stored_queue is None:
        queue: list[str] = [str(steps_list[0]["id"])] if steps_list else []
        catalog.update_state_status(
            state_id, "active", run_start_date=_now_iso(), set_run_start=True
        )
        # Audit only on a fresh run (no stored queue yet); resumes of a pending run
        # re-enter with a stored queue and must not double-log.
        sequence_query_id = str(package.get("sequence_query_id") or "").strip()
        try:
            catalog.record_audit(
                space_id,
                [sequence_query_id] if sequence_query_id else [],
                event_id=event_id,
                trigger=trigger,
                principal_id=principal_id,
            )
        except Exception as audit_err:  # never let audit failures break a run
            sys.stderr.write(f"audit-log error: {audit_err}\n")
    else:
        queue = [str(q) for q in stored_queue]
        catalog.update_state_status(state_id, "active")

    executed: list[dict[str, Any]] = []
    final_step: dict[str, Any] | None = None
    final_response: dict[str, Any] | None = None

    while queue:
        step_id = queue[0]
        step = steps_by_id.get(step_id)
        if step is None or step_id in visited:
            queue.pop(0)
            continue

        step_defaults = _collect_step_defaults(step)

        interactive = trigger == "manual"
        unresolved = _unresolved_required_params(
            step, resolved, response_param_names, step_defaults, interactive
        )
        if unresolved:
            catalog.update_state_progress(
                state_id,
                {"queue": queue, "resolved": resolved, "visited": list(visited)},
            )
            catalog.update_state_status(state_id, "pending")
            return {
                "status": "pending",
                "state_id": state_id,
                "step_id": step_id,
                "parameters": _pending_step_parameters(step, response_param_names),
                "resolved": resolved,
            }

        _apply_step_defaults(step_defaults, resolved)
        _fill_blank_optional_query_params(step, resolved, response_param_names)

        if _mint_auto_ids(step, resolved):
            catalog.update_state_progress(
                state_id,
                {"queue": queue, "resolved": resolved, "visited": list(visited)},
            )

        queue.pop(0)
        visited.add(step_id)
        response = _execute_step(space_id, step, resolved)
        final_step = step
        final_response = response if isinstance(response, dict) else {}
        executed_entry = {
            "step_id": step_id,
            "query_id": str(step.get("query_id") or ""),
            "endpoint": str(step.get("endpoint") or ""),
        }
        if str(step.get("kind") or "").strip() == "code":
            executed_entry["kind"] = "code"
            executed_entry["resource_id"] = str(step.get("resource_id") or "")
        elif str(step.get("kind") or "").strip() == "local_llm":
            executed_entry["kind"] = "local_llm"
            executed_entry["config_id"] = str(step.get("config_id") or "")
        executed.append(executed_entry)
        _bind_response_parameters(response, response_parameters, resolved)

        _enqueue_transitions(step, resolved, queue)

    catalog.update_state_progress(state_id, None)
    catalog.update_state_status(state_id, "inactive")
    # This run is now recorded in audit_log, so older finished run packages are
    # dead weight in the state table. Drop them (keeping this row so an immediate
    # re-run can still resolve its state_id) instead of letting them accumulate.
    try:
        catalog.purge_finished_state_packages(exclude_id=state_id)
    except Exception as purge_err:  # cleanup must never break a completed run
        sys.stderr.write(f"state-purge error: {purge_err}\n")
    final_result = (
        _classify_final_response(final_step, final_response)
        if final_step is not None and final_response is not None
        else None
    )
    return {
        "status": "inactive",
        "state_id": state_id,
        "resolved": resolved,
        "executed": executed,
        "final_result": final_result,
    }
