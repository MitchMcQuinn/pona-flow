"""
HTTP / Local LLM call policy: timeout, retry budget, and backoff.

Authoring stores these on the STEP payload. This module is the runtime side:
resolve ``$parameter`` values, apply caps, and decide the default timeout for a
step kind. Parking a retry lives in ``execution_wait.park_spec_for_retry_backoff``.
"""

from __future__ import annotations

from typing import Any

from . import execution_wait

HTTP_DEFAULT_TIMEOUT_SECONDS = 30
LLM_DEFAULT_TIMEOUT_SECONDS = 300
MIN_TIMEOUT_SECONDS = 1
MAX_TIMEOUT_SECONDS = 300
DEFAULT_MAX_ATTEMPTS = 1
MAX_ATTEMPTS = 20


def _resolve_raw(raw: Any, resolved: dict[str, Any]) -> Any:
    name = execution_wait.param_name(raw)
    if name:
        return resolved.get(name)
    return raw


def is_retryable_step(step: dict[str, Any]) -> bool:
    """True for HTTP endpoint and Local LLM steps (not query / wait / leftover code)."""
    if str(step.get("query_id") or "").strip():
        return False
    kind = str(step.get("kind") or "").strip()
    if kind == "local_llm":
        return True
    if kind in ("wait", "join", "code"):
        return False
    return bool(str(step.get("endpoint") or "").strip())


def default_timeout_seconds(step: dict[str, Any]) -> int:
    if str(step.get("kind") or "").strip() == "local_llm":
        return LLM_DEFAULT_TIMEOUT_SECONDS
    return HTTP_DEFAULT_TIMEOUT_SECONDS


def timeout_seconds(
    step: dict[str, Any],
    resolved: dict[str, Any],
    default: int | None = None,
) -> int:
    """Seconds the call may run. ``default`` is the kind's default when the field is omitted."""
    fallback = default if default is not None else default_timeout_seconds(step)
    raw = step.get("timeout_seconds")
    if raw is None or raw == "":
        return fallback
    value = _resolve_raw(raw, resolved)
    if value is None or value == "":
        raise ValueError("Call timeout must be a number of seconds (or $parameter).")
    try:
        seconds = int(float(str(value).strip()))
    except (TypeError, ValueError) as e:
        raise ValueError("Call timeout must be a number of seconds (or $parameter).") from e
    if seconds < MIN_TIMEOUT_SECONDS or seconds > MAX_TIMEOUT_SECONDS:
        raise ValueError(
            f"Call timeout must be between {MIN_TIMEOUT_SECONDS} and "
            f"{MAX_TIMEOUT_SECONDS} seconds."
        )
    return seconds


def max_attempts(step: dict[str, Any]) -> int:
    raw = step.get("max_attempts")
    if raw is None or raw == "":
        return DEFAULT_MAX_ATTEMPTS
    try:
        attempts = int(raw)
    except (TypeError, ValueError) as e:
        raise ValueError("max_attempts must be an integer.") from e
    if attempts < 1:
        raise ValueError("max_attempts must be at least 1.")
    if attempts > MAX_ATTEMPTS:
        return MAX_ATTEMPTS
    return attempts


def backoff_seconds(step: dict[str, Any], resolved: dict[str, Any]) -> int:
    raw = step.get("backoff_seconds")
    if raw is None or raw == "":
        return 0
    value = _resolve_raw(raw, resolved)
    if value is None or value == "":
        return 0
    try:
        seconds = int(float(str(value).strip()))
    except (TypeError, ValueError) as e:
        raise ValueError("Retry backoff must be a number of seconds (or $parameter).") from e
    if seconds < 0:
        raise ValueError("Retry backoff cannot be negative.")
    if seconds > execution_wait.MAX_WAIT_SECONDS:
        raise ValueError("Retry backoff cannot exceed 30 days.")
    return seconds
