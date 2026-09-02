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
  3. Execute the step (query against Neo4j, HTTP endpoint, or local LLM),
     then bind values for downstream steps: a query step's scalar RETURN columns
     fill in names not already resolved, and response_parameter mappings apply
     afterwards so an explicit mapping can still overwrite one.
  4. Follow outgoing transitions whose condition_parameter is empty. When a
     condition_parameter is set, gate on it: with a condition_expected boolean,
     follow only when the parameter's strict boolean value matches it (so two
     sibling edges branch on one parameter); otherwise fall back to truthy gating.

A step runs at most once, so a transition pointing back to an earlier step simply
terminates — unless the package carries a ``loop`` descriptor. Then the enclosed
steps leave ``visited`` at each iteration boundary and the sequence's termination
rule (for / for_while / for_each) decides between the back-edge and the exit edges.
See ``execution_loop`` for the rules and the "looping sequences" section below for
the routing.

Resume progress (remaining queue + resolved values + visited steps, plus loop
iteration state) is stored on the state row so a pending run continues from where
it paused.
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
from . import execution_loop
from . import graph
from . import local_llms
from . import schema_currency

# Credential reference token ``$secret.<NAME>`` (see cypher_utils.SECRET_REF_RE).
_SECRET_REF_RE = cypher_utils.SECRET_REF_RE

# Explicit User-Agent for outbound endpoint calls (see _execute_endpoint_step).
_OUTBOUND_USER_AGENT = "pona-flow/1.0 (+https://github.com/pona-flow)"

# RETURN column aliases eligible for auto-binding (see _bind_query_return_columns).
# An unaliased projection comes back keyed by its raw expression text
# ("r.id IS NOT NULL"), which no downstream step could reference as ``$name``.
_RETURN_COLUMN_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

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
# Legacy code-execution STEPs (archived; see Docs/code-execution/)
# ---------------------------------------------------------------------------
#
# Existing graph nodes may still carry payload kind "code". Do not fall through
# to the HTTP runner (empty endpoint). The sandbox client lives in the archive.


def _execute_code_step(
    _space_id: str, _step: dict[str, Any], _resolved: dict[str, Any]
) -> dict[str, Any]:
    """Refuse leftover code-execution STEPs; the sandbox runner is not shipped."""
    return {
        "_ok": False,
        "_error": "Code-execution STEPs are not supported.",
    }


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


def _bind_query_return_columns(
    step: dict[str, Any],
    response: dict[str, Any],
    resolved: dict[str, Any],
    overwrite: bool = False,
) -> set[str]:
    """Publish a query step's scalar RETURN columns as parameters for later steps.

    A parameter-gated transition is evaluated against ``resolved``, so a boolean a
    read step computed (``... AS hasExistingConnection``) has to land there before
    the branch can see it. Binding is deliberately narrow:

      - query steps only, since endpoint/LLM steps return a caller-shaped body
        whose keys are not authored as parameter names;
      - the first record only, matching the columns already surfaced on the response;
      - scalars only, so the implicit ``RETURN *`` on a create step still feeds the
        visualizer its node/relationship maps without pushing them into run state;
      - nulls are skipped, so an OPTIONAL MATCH that missed cannot erase an input a
        later step binds under the same name;
      - names already resolved win, so caller input and earlier steps are never
        overwritten by a column that happens to share their name.

    ``response_parameters`` stays the way to *overwrite* a name on purpose, and runs
    after this so an explicit mapping always takes precedence.

    ``overwrite`` lifts only that last rule, and the executor sets it for steps inside a
    loop body. Across iterations the body's own output is the freshest fact, so deferring
    would be wrong in the one case that matters most: a ``for_while`` condition seeded by
    the caller (the usual way to make the first pre-test pass) would keep the seed
    forever, and the loop could never terminate.

    Returns the names bound, so a looping run can drop them at the iteration boundary and
    let the next pass re-bind (see ``_clear_iteration_state``).
    """
    bound: set[str] = set()
    if not str(step.get("query_id") or "").strip():
        return bound
    records = response.get("records") or []
    if not records or not isinstance(records[0], dict):
        return bound
    for key, value in records[0].items():
        name = str(key).strip()
        if not _RETURN_COLUMN_NAME_RE.match(name):
            continue
        if name in resolved and not overwrite:
            continue
        # bool covers the branch case; None and collections fall through untouched.
        if value is None or not isinstance(value, (bool, int, float, str)):
            continue
        resolved[name] = value
        bound.add(name)
    return bound


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


def _mint_auto_ids(step: dict[str, Any], resolved: dict[str, Any]) -> set[str]:
    """Mint create-INSTANCE graph ids (auto_generate parameters) once per run.

    Returns the names minted (empty when nothing was) — the caller must persist
    progress *before* the step executes so a crash/retry re-runs the step with the
    same ids (MERGE stays idempotent) instead of minting duplicates. Within one run
    the minted value stays in ``resolved``, so later steps binding the same parameter
    address the same entity.

    Inside a loop body the names are dropped at the iteration boundary, so each pass
    mints fresh ids and creates a distinct entity rather than MERGE-ing repeatedly
    onto the first one.
    """
    minted: set[str] = set()
    for p in step.get("parameters") or []:
        if not isinstance(p, dict) or not p.get("auto_generate"):
            continue
        pname = str(p.get("name") or "").strip()
        if pname and pname not in resolved:
            resolved[pname] = config.generate_entity_id()
            minted.add(pname)
    return minted


def _passing_targets(step: dict[str, Any], resolved: dict[str, Any]) -> list[str]:
    """The executed step's outgoing transition targets whose condition holds."""
    targets: list[str] = []
    for transition in step.get("next") or []:
        if not isinstance(transition, dict):
            continue
        target = str(transition.get("id") or "").strip()
        if not target:
            continue
        condition_parameter = str(transition.get("condition_parameter") or "").strip()
        if not condition_parameter:
            targets.append(target)
            continue
        value = resolved.get(condition_parameter)
        expected = transition.get("condition_expected")
        if isinstance(expected, bool):
            # Branch on the parameter's strict boolean value: this transition
            # fires only when it matches the expected result, letting a sibling
            # relationship take the opposite branch.
            if _coerce_bool(value) == expected:
                targets.append(target)
        elif _truthy(value):
            # Legacy gating (no expected result configured): follow when truthy.
            targets.append(target)
    return targets


def _enqueue_transitions(
    step: dict[str, Any], resolved: dict[str, Any], queue: list[str]
) -> None:
    """Advance the executed step's outgoing transitions onto the queue."""
    queue.extend(_passing_targets(step, resolved))


# --- looping sequences ---------------------------------------------------------------
# The package's ``loop`` descriptor (built by execution_loop.analyze_loop) names the
# one back-edge in the step graph plus the steps it encloses. Everything below routes
# that back-edge against the sequence's termination rule; a package without a
# descriptor never touches this path and keeps the historical single-pass walk.


def _new_loop_state() -> dict[str, Any]:
    """Fresh iteration bookkeeping for a looping run.

    ``items`` stays None until a for-each source column is seen, which is what lets
    an empty result set skip the body entirely (see _should_enter_loop_body).
    ``inherited`` is the run state as it stood when the loop began, which bounds what
    clearing is allowed to touch (see _clear_iteration_state).
    """
    return {
        "iteration": 0,
        "entered": False,
        "items": None,
        "item_index": 0,
        "derived": [],
        "inherited": [],
    }


def _capture_loop_items(
    loop: dict[str, Any],
    state: dict[str, Any],
    step_id: str,
    response: dict[str, Any],
) -> None:
    """Latch the row set a for-each loop iterates, from the step compose identified.

    Latching an empty list matters as much as a full one: it is what tells the entry
    guard the body has nothing to do. Only the first execution counts — if the source
    sits inside the cycle, re-latching each pass would restart iteration forever.
    """
    if loop.get("type") != "for_each" or state.get("items") is not None:
        return
    if step_id != str(loop.get("source_step") or "").strip():
        return
    records = response.get("records") or []
    state["items"] = [record for record in records if isinstance(record, dict)]


def _bind_loop_item(
    loop: dict[str, Any], state: dict[str, Any], resolved: dict[str, Any]
) -> None:
    """Bind the current for-each row's scalar columns under their aliases.

    Overwrites on purpose: these are the iteration's values, and they are recorded as
    derived so the next pass replaces them rather than inheriting them.
    """
    if loop.get("type") != "for_each":
        return
    items = state.get("items") or []
    index = int(state.get("item_index") or 0)
    if index >= len(items):
        return
    row = items[index]
    if not isinstance(row, dict):
        return
    derived = state.setdefault("derived", [])
    for key, value in row.items():
        name = str(key).strip()
        if not _RETURN_COLUMN_NAME_RE.match(name):
            continue
        if value is None or not isinstance(value, (bool, int, float, str)):
            continue
        resolved[name] = value
        if name not in derived:
            derived.append(name)


def _should_enter_loop_body(
    loop: dict[str, Any], state: dict[str, Any], resolved: dict[str, Any]
) -> bool:
    """Pre-test guard for the *first* pass through the body.

    A for loop of zero, a condition that is already false, and an empty for-each row
    set all skip the body without running it. The one case that cannot be decided up
    front is a for-each whose source step sits *inside* the cycle: its rows are not
    known until it runs, so the first pass goes ahead and the continue guard stops it.
    """
    loop_type = loop.get("type")
    if loop_type == "for":
        return int(loop.get("count") or 0) > 0
    if loop_type == "for_while":
        return execution_loop.condition_holds(loop.get("condition"), resolved)
    if loop_type == "for_each":
        items = state.get("items")
        return items is None or len(items) > 0
    return True


def _should_continue_loop(
    loop: dict[str, Any], state: dict[str, Any], resolved: dict[str, Any]
) -> bool:
    """Whether to traverse the back-edge for another pass."""
    loop_type = loop.get("type")
    if loop_type == "for":
        return int(state.get("iteration") or 0) + 1 < int(loop.get("count") or 0)
    if loop_type == "for_while":
        return execution_loop.condition_holds(loop.get("condition"), resolved)
    if loop_type == "for_each":
        items = state.get("items") or []
        return int(state.get("item_index") or 0) + 1 < len(items)
    return False


def _clear_iteration_state(
    loop: dict[str, Any],
    state: dict[str, Any],
    resolved: dict[str, Any],
    visited: set[str],
) -> None:
    """Reset per-pass state so the next iteration starts clean.

    Derived names (a step's RETURN columns, minted ids, the current for-each row) are
    dropped so they re-bind; caller input and anything accumulated outside the body
    survives. A name the loop *inherited* is never dropped even when a body step also
    binds it: the body overwrites it in place each pass, so clearing would only risk
    leaving it unset for a step that runs before the one that re-binds it.

    Body steps leave ``visited`` so they can run again, while steps outside stay
    visited — that is what keeps a fan-in *before* or *after* the loop running exactly
    once.
    """
    for name in state.get("derived") or []:
        resolved.pop(name, None)
    state["derived"] = []
    for step_id in loop.get("body") or []:
        visited.discard(str(step_id))


def _progress_snapshot(
    queue: list[str],
    resolved: dict[str, Any],
    visited: set[str],
    loop_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The resume payload stored on the state row.

    ``loop`` is omitted for a non-looping run, so those progress rows keep exactly
    the shape they have always had.
    """
    snapshot: dict[str, Any] = {
        "queue": queue,
        "resolved": resolved,
        "visited": list(visited),
    }
    if loop_state is not None:
        snapshot["loop"] = loop_state
    return snapshot


def _loop_exit_targets(
    loop: dict[str, Any], steps_by_id: dict[str, Any], resolved: dict[str, Any]
) -> list[str]:
    """Where the run goes once the loop is done: the tail's non-back-edge targets.

    Also used when the body is skipped entirely, so a zero-iteration loop continues
    into the rest of the chain instead of ending the run.
    """
    back_edge = loop.get("back_edge") or {}
    tail = steps_by_id.get(str(back_edge.get("from") or ""))
    if not tail:
        return []
    entry = str(back_edge.get("to") or "")
    return [target for target in _passing_targets(tail, resolved) if target != entry]


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

    loop = package.get("loop") if isinstance(package.get("loop"), dict) else None
    loop_entry = str(((loop or {}).get("back_edge") or {}).get("to") or "")
    loop_tail = str(((loop or {}).get("back_edge") or {}).get("from") or "")
    loop_body = {str(sid) for sid in (loop or {}).get("body") or []}
    max_iterations = int((loop or {}).get("max_iterations") or 0)

    progress = row.get("progress") or {}
    resolved: dict[str, Any] = dict(progress.get("resolved") or {})
    _merge_caller_params(resolved, params)
    visited: set[str] = set(progress.get("visited") or [])
    loop_state: dict[str, Any] = dict(progress.get("loop") or {}) or _new_loop_state()
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

    loop_progress = loop_state if loop else None

    while queue:
        step_id = queue[0]
        step = steps_by_id.get(step_id)
        if step is None or step_id in visited:
            queue.pop(0)
            continue

        # Pre-test the loop before its first pass. A for of zero, an already-false
        # condition, or an empty for-each row set skips the body without running it
        # (and without prompting for the entry step's inputs), continuing from the
        # tail's exit edges instead.
        if loop and step_id == loop_entry and not loop_state.get("entered"):
            loop_state["entered"] = True
            if not _should_enter_loop_body(loop, loop_state, resolved):
                queue.pop(0)
                queue.extend(_loop_exit_targets(loop, steps_by_id, resolved))
                continue
            # What the loop inherits: caller input plus anything the steps before it
            # resolved. These are off-limits to iteration-boundary clearing.
            loop_state["inherited"] = sorted(resolved)
            _bind_loop_item(loop, loop_state, resolved)

        step_defaults = _collect_step_defaults(step)

        interactive = trigger == "manual"
        unresolved = _unresolved_required_params(
            step, resolved, response_param_names, step_defaults, interactive
        )
        if unresolved:
            catalog.update_state_progress(
                state_id, _progress_snapshot(queue, resolved, visited, loop_progress)
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

        minted = _mint_auto_ids(step, resolved)
        if minted:
            catalog.update_state_progress(
                state_id, _progress_snapshot(queue, resolved, visited, loop_progress)
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
        if loop and step_id in loop_body:
            # A body step appears once per pass; stamp the pass so a repeated entry
            # in the trace is readable.
            executed_entry["iteration"] = int(loop_state.get("iteration") or 0)
        executed.append(executed_entry)
        in_loop_body = bool(loop) and step_id in loop_body
        bound = _bind_query_return_columns(
            step, response, resolved, overwrite=in_loop_body
        )
        _bind_response_parameters(response, response_parameters, resolved)

        if loop:
            _capture_loop_items(
                loop,
                loop_state,
                step_id,
                response if isinstance(response, dict) else {},
            )
            if in_loop_body:
                # Only values a body step *introduced* are dropped at the boundary; a
                # value bound before the loop (or by the caller) has to survive.
                inherited = set(loop_state.get("inherited") or [])
                derived = loop_state.setdefault("derived", [])
                for name in sorted((bound | minted) - inherited):
                    if name not in derived:
                        derived.append(name)

        if loop and step_id == loop_tail:
            passing = _passing_targets(step, resolved)
            # The back-edge's own condition still gates it, so an author can stop the
            # loop with an edge guard as well as with the sequence's rule.
            if loop_entry in passing and _should_continue_loop(
                loop, loop_state, resolved
            ):
                next_iteration = int(loop_state.get("iteration") or 0) + 1
                if next_iteration >= max_iterations:
                    catalog.update_state_progress(
                        state_id,
                        _progress_snapshot(queue, resolved, visited, loop_progress),
                    )
                    catalog.update_state_status(state_id, "inactive")
                    return {
                        "status": "error",
                        "state_id": state_id,
                        "message": (
                            f"Loop exceeded its limit of {max_iterations} iterations "
                            "without terminating. Check the loop's exit condition, or "
                            "raise the sequence's maximum iterations."
                        ),
                        "resolved": resolved,
                        "executed": executed,
                    }
                _clear_iteration_state(loop, loop_state, resolved, visited)
                loop_state["iteration"] = next_iteration
                if loop.get("type") == "for_each":
                    loop_state["item_index"] = (
                        int(loop_state.get("item_index") or 0) + 1
                    )
                _bind_loop_item(loop, loop_state, resolved)
                queue.append(loop_entry)
            else:
                queue.extend(
                    target for target in passing if target != loop_entry
                )
        else:
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
