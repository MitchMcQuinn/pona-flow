# Archived from Engine/server/execution_run.py
# Constants near the top plus the full code-execution sandbox client.
# Restore by pasting back into execution_run.py and re-exporting from execution.py.

# Code-step parameter token: same shape as the builder's STEP_BODY_PARAM_REF_RE —
# ``$name`` where name is identifier-shaped (excludes $100 / ${42} / $secret.X which
# has a dot and is handled separately).
_CODE_PARAM_REF_RE = re.compile(r"\$(?![0-9])(?!\{[0-9]+\})([A-Za-z_][A-Za-z0-9_]*)\b")

# RETURN column aliases eligible for auto-binding (see _bind_query_return_columns).
# An unaliased projection comes back keyed by its raw expression text
# ("r.id IS NOT NULL"), which no downstream step could reference as ``$name``.
_RETURN_COLUMN_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

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


