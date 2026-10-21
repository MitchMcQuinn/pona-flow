"""
On-demand simulated events.

A catalog event with ``type = 'simulated'`` is a tic timeline (the old "world").
Each tic is requested over HTTP. Due probabilities pick a weighted outcome and
run the event's sequence in-process. Session history lives in the catalog
SQLite database (``simulation_sessions`` / ``simulation_emissions``).

Weights are a static number, or a ``$parameter`` read from a per-outcome weight
sequence's resolved parameter map. An unresolved weight becomes that parameter's
authored default, then ``0``. A weight or emission sequence that fails stops the
session: the tic still commits, and further tics are refused until the error is
cleared.
"""

from __future__ import annotations

import random
import secrets
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from . import catalog, config, execution, execution_operation, scheduler, sequence_service

_TOKEN_PREFIX = "sim_"

_UNIT_SECONDS = {
    "seconds": 1,
    "minutes": 60,
    "hours": 3600,
    "days": 86400,
}

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class SimulationHalt(Exception):
    """A tic hit an engine error. The tic still commits and the session stops."""


class SimulationRejected(Exception):
    """The caller asked for something the event or session state forbids."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def generate_simulation_token() -> str:
    """Mint the unguessable token embedded in the public session-control URLs."""
    return _TOKEN_PREFIX + secrets.token_urlsafe(32)


def _session_lock(session_id: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(session_id)
        if lock is None:
            lock = threading.Lock()
            _locks[session_id] = lock
        return lock


def _format_utc(dt: datetime) -> str:
    utc = dt.astimezone(timezone.utc)
    ms = int(utc.microsecond / 1000)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms:03d}Z"


def canonicalize_world_start(value: str) -> str:
    """Parse an ISO-8601 datetime and return a UTC timestamp with milliseconds."""
    text = (value or "").strip()
    if not text:
        raise ValueError("world_start_at is required")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as err:
        raise ValueError("world_start_at must be an ISO-8601 datetime") from err
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return _format_utc(parsed)


def world_time_at(
    world_start_at: str, tic: int, tic_unit: str, tic_duration: float
) -> str:
    """In-world timestamp at ``tic`` (tic 0 is ``world_start_at``)."""
    start = canonicalize_world_start(world_start_at)
    # canonicalize returns a string; reparse so arithmetic stays on a datetime.
    start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    unit = _UNIT_SECONDS.get((tic_unit or "").strip())
    if unit is None:
        raise ValueError(f"Invalid tic unit: {tic_unit}")
    try:
        duration = float(tic_duration)
    except (TypeError, ValueError) as err:
        raise ValueError("tic_duration must be a number") from err
    return _format_utc(start_dt + timedelta(seconds=duration * unit * tic))


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _finite_number(value: Any) -> float | None:
    """A finite int/float or numeric string. Booleans are not numbers."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    else:
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _clamp_weight(number: float) -> float:
    return 0.0 if number < 0 else number


def _is_param_ref(weight: Any) -> bool:
    return isinstance(weight, str) and weight.strip().startswith("$")


def is_probability_eligible(probability: dict[str, Any], tic: int) -> bool:
    """Whether a probability should attempt to run on this tic, before a random roll."""
    schedule = probability.get("schedule") if isinstance(probability.get("schedule"), dict) else {}
    kind = str(schedule.get("type") or "")
    if kind == "recurring":
        every = _number(schedule.get("every_x"))
        delay = _number(schedule.get("delay_y"))
        if every <= 0 or tic < delay:
            return False
        return (tic - delay) % every == 0
    if kind == "scheduled":
        tics = schedule.get("tics") if isinstance(schedule.get("tics"), list) else []
        return tic in [int(_number(item)) for item in tics]
    if kind == "random":
        every = _number(schedule.get("every_x"))
        if every <= 0:
            return False
        return tic > 0 and tic % every == 0
    return False


def is_probability_due(probability: dict[str, Any], tic: int) -> bool:
    """Eligibility plus the random-percent roll."""
    if not is_probability_eligible(probability, tic):
        return False
    schedule = probability.get("schedule") if isinstance(probability.get("schedule"), dict) else {}
    if schedule.get("type") == "random":
        return random.random() * 100 < _number(schedule.get("percent"))
    return True


def _ordered_due(probabilities: list[Any], tic: int) -> list[dict[str, Any]]:
    """Due probabilities, priority ascending, ties shuffled."""
    groups: dict[int, list[dict[str, Any]]] = {}
    for item in probabilities:
        if not isinstance(item, dict) or not is_probability_due(item, tic):
            continue
        try:
            priority = int(item.get("priority"))
        except (TypeError, ValueError):
            priority = 1
        groups.setdefault(priority, []).append(item)
    ordered: list[dict[str, Any]] = []
    for priority in sorted(groups):
        group = groups[priority]
        random.shuffle(group)
        ordered.extend(group)
    return ordered


def pick_outcome(outcomes: list[Any], weights: list[float]) -> dict[str, Any] | None:
    """Pick an outcome by normalized weights. None when the sum is 0 (cancelled)."""
    rows = [item for item in outcomes if isinstance(item, dict)]
    if not rows or len(weights) != len(rows):
        return None
    total = sum(weights)
    if total <= 0:
        return None
    cursor = random.random() * total
    for outcome, weight in zip(rows, weights):
        cursor -= weight
        if cursor <= 0:
            return outcome
    return rows[-1]


def _read_ref(expr: str, resolved: dict[str, Any]) -> tuple[Any, bool]:
    """``$name`` / ``$a.b`` against a parameter map. ``$secret`` is unresolved."""
    try:
        return execution_operation.resolve_operand(expr, resolved)
    except ValueError:
        return None, True


def _parameter_default(space_id: str, sequence_id: str, expr: str) -> Any:
    """Authored ``default_value`` for the parameter named by a ``$`` reference.

    Dotted references walk into a dict default. Compose failures mean there is
    no default (the caller then uses 0).
    """
    name = expr.strip()[1:]
    root = name.split(".", 1)[0]
    if not root:
        return None
    try:
        package = execution.compose_execution_package(space_id, sequence_id)
    except Exception:
        return None
    default: Any = None
    found = False
    for step in package.get("steps") or []:
        if not isinstance(step, dict):
            continue
        for param in step.get("parameters") or []:
            if not isinstance(param, dict):
                continue
            if str(param.get("name") or "").strip() == root and "default_value" in param:
                default = param.get("default_value")
                found = True
                break
        if found:
            break
    if not found:
        for binding in package.get("response_parameters") or []:
            if not isinstance(binding, dict):
                continue
            if str(binding.get("parameter") or "").strip() != root:
                continue
            if binding.get("default_value") is None:
                continue
            default = binding.get("default_value")
            found = True
            break
    if not found or "." not in name:
        return default if found else None
    current = default
    for part in name.split(".")[1:]:
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def _weight_from_number(number: float | None) -> float:
    if number is None:
        return 0.0
    return _clamp_weight(number)


def _resolve_param_weight(
    space_id: str,
    event_id: str,
    session: dict[str, Any],
    probability: dict[str, Any],
    outcome: dict[str, Any],
    expr: str,
    tic: int,
    world_time: str,
    principal_id: str | None,
) -> float:
    """Run the outcome's weight sequence and read ``expr`` from its parameter map."""
    sequence_id = str(outcome.get("weight_sequence_id") or "").strip()
    if not sequence_id:
        return 0.0
    root = expr.strip()[1:].split(".", 1)[0]
    context = {
        "tic": tic,
        "world_time": world_time,
        "session_id": session["id"],
        "simulated_event_id": event_id,
        "probability_id": probability.get("id"),
        "probability_name": probability.get("name"),
        "outcome_label": outcome.get("label"),
    }
    # Don't pre-seed the weight parameter; the sequence is what resolves it.
    params = {key: value for key, value in context.items() if key != root and value is not None}
    detail = {"session_id": session["id"], "tic": tic, "role": "weight"}
    try:
        result = sequence_service.run_sequence_once(
            space_id,
            sequence_id,
            params,
            trigger="simulated",
            event_id=event_id,
            principal_id=principal_id,
            audit_detail=detail,
        )
    except Exception as err:
        raise SimulationHalt(str(err)) from err
    status = str(result.get("status") or "")
    state_id = str(result.get("state_id") or "").strip()
    if status == "error":
        raise SimulationHalt(str(result.get("message") or "Weight sequence failed"))
    value: Any = None
    if status == "inactive":
        resolved = result.get("resolved") if isinstance(result.get("resolved"), dict) else {}
        read, missing = _read_ref(expr, resolved)
        value = None if missing else read
    elif status in ("pending", "waiting") and state_id:
        try:
            execution.stop_execution(space_id, state_id)
        except Exception:
            pass
    number = _finite_number(value)
    if number is None:
        number = _finite_number(_parameter_default(space_id, sequence_id, expr))
    return _weight_from_number(number)


def resolve_weights(
    space_id: str,
    event_id: str,
    session: dict[str, Any],
    probability: dict[str, Any],
    tic: int,
    world_time: str,
    principal_id: str | None,
) -> list[float]:
    """One weight per outcome. Static numbers skip the weight sequence."""
    outcomes = probability.get("outcomes") if isinstance(probability.get("outcomes"), list) else []
    weights: list[float] = []
    for outcome in outcomes:
        if not isinstance(outcome, dict):
            weights.append(0.0)
            continue
        raw = outcome.get("weight")
        if _is_param_ref(raw):
            weights.append(
                _resolve_param_weight(
                    space_id,
                    event_id,
                    session,
                    probability,
                    outcome,
                    str(raw).strip(),
                    tic,
                    world_time,
                    principal_id,
                )
            )
        else:
            weights.append(_weight_from_number(_finite_number(raw)))
    return weights


def _require_simulated(event: dict[str, Any]) -> None:
    if str(event.get("type") or "") != "simulated":
        raise SimulationRejected("Event is not a simulated event", 409)


def _require_enabled(event: dict[str, Any]) -> None:
    if not int(event.get("enabled") or 0):
        raise SimulationRejected("Event is disabled", 403)


def _require_session(event_id: str, session_id: str) -> dict[str, Any]:
    session = catalog.get_simulation_session(session_id, event_id)
    if session is None:
        raise LookupError("Session not found")
    return session


def create_session(event: dict[str, Any], world_start_at: str) -> dict[str, Any]:
    """Open a session at tic 0. Refuses a disabled or non-simulated event."""
    _require_simulated(event)
    _require_enabled(event)
    start = canonicalize_world_start(world_start_at)
    session_id = config.generate_entity_id()
    catalog.insert_simulation_session(
        session_id,
        str(event.get("id") or ""),
        str(event.get("space_id") or ""),
        start,
        start,
    )
    created = catalog.get_simulation_session(session_id)
    if created is None:
        raise LookupError("Session not found")
    return created


def delete_session(event: dict[str, Any], session_id: str) -> None:
    """Delete one session and its emissions."""
    _require_simulated(event)
    _require_enabled(event)
    if not catalog.delete_simulation_session(session_id, str(event.get("id") or "")):
        raise LookupError("Session not found")


def clear_session_error(event: dict[str, Any], session_id: str) -> dict[str, Any]:
    """Allow the next tic after a stopped session. Does not roll the clock back."""
    _require_simulated(event)
    session = _require_session(str(event.get("id") or ""), session_id)
    with _session_lock(session["id"]):
        catalog.update_simulation_session(session["id"], status="running", clear_error=True)
        detail = catalog.get_simulation_session_detail(session["id"], str(event.get("id") or ""))
    if detail is None:
        raise LookupError("Session not found")
    return detail


def _outcome_body(outcome: dict[str, Any]) -> dict[str, Any]:
    payload = outcome.get("payload") if isinstance(outcome.get("payload"), dict) else {}
    body = {"label": outcome.get("label") or ""}
    body.update(payload)
    return body


def _emission_params(outcome: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    """Outcome payload wins on key collision so it lines up with sequence inputs."""
    payload = outcome.get("payload") if isinstance(outcome.get("payload"), dict) else {}
    params = dict(payload)
    for key, value in context.items():
        if key not in params:
            params[key] = value
    return params


def _run_emission(
    event: dict[str, Any],
    session: dict[str, Any],
    probability: dict[str, Any],
    outcome: dict[str, Any],
    sequence_id: str,
    tic: int,
    world_time: str,
    emission_id: str,
    principal_id: str | None,
) -> None:
    space_id = str(event.get("space_id") or "")
    event_id = str(event.get("id") or "")
    context = {
        "tic": tic,
        "world_time": world_time,
        "session_id": session["id"],
        "simulated_event_id": event_id,
        "probability_id": probability.get("id"),
        "probability_name": probability.get("name"),
        "outcome_label": outcome.get("label"),
        "cancelled": False,
    }
    params = _emission_params(outcome, context)
    scheduler._resume_event_waiters(event_id, params, trigger="simulated")
    try:
        result = sequence_service.run_sequence_once(
            space_id,
            sequence_id,
            params,
            trigger="simulated",
            event_id=event_id,
            principal_id=principal_id,
            audit_detail={"session_id": session["id"], "tic": tic, "role": "emission"},
        )
    except Exception as err:
        catalog.update_simulation_emission_status(emission_id, "error")
        raise SimulationHalt(str(err)) from err
    status = str(result.get("status") or "")
    if status == "inactive":
        catalog.update_simulation_emission_status(emission_id, "inactive")
        return
    state_id = str(result.get("state_id") or "").strip()
    if status in ("pending", "waiting") and state_id:
        try:
            execution.stop_execution(space_id, state_id)
        except Exception:
            pass
    catalog.update_simulation_emission_status(emission_id, status or "error")
    message = str(result.get("message") or f"Sequence returned {status or 'an unexpected status'}")
    raise SimulationHalt(message)


def _advance_unlocked(
    event: dict[str, Any], session_id: str, principal_id: str | None
) -> dict[str, Any]:
    _require_simulated(event)
    _require_enabled(event)
    event_id = str(event.get("id") or "")
    session = _require_session(event_id, session_id)
    if session.get("status") == "error":
        raise SimulationRejected(
            "Session has an error; clear the error before advancing tics",
            409,
        )
    package = event.get("simulation_package") if isinstance(event.get("simulation_package"), dict) else {}
    probabilities = package.get("probabilities") if isinstance(package.get("probabilities"), list) else []
    tic_unit = str(package.get("tic_unit") or "minutes")
    tic_duration = package.get("tic_duration")
    sequence_id = str(package.get("sequence_id") or "").strip()
    next_tic = int(session.get("current_tic") or 0) + 1
    next_time = str(session.get("current_world_time") or session.get("world_start_at") or "")
    space_id = str(event.get("space_id") or "")
    try:
        try:
            next_time = world_time_at(
                str(session.get("world_start_at") or ""),
                next_tic,
                tic_unit,
                float(tic_duration) if tic_duration is not None else 0.0,
            )
        except ValueError as err:
            raise SimulationHalt(str(err)) from err
        for probability in _ordered_due(probabilities, next_tic):
            outcomes = (
                probability.get("outcomes")
                if isinstance(probability.get("outcomes"), list)
                else []
            )
            weights = resolve_weights(
                space_id,
                event_id,
                session,
                probability,
                next_tic,
                next_time,
                principal_id,
            )
            # pick_outcome drops non-dicts, so weights must match that filter.
            paired = [(item, weight) for item, weight in zip(outcomes, weights) if isinstance(item, dict)]
            selected = pick_outcome(
                [item for item, _weight in paired],
                [weight for _item, weight in paired],
            )
            cancelled = selected is None
            prob_id = str(probability.get("id") or "")
            prob_name = str(probability.get("name") or "")
            emission_id = config.generate_entity_id()
            if cancelled:
                catalog.insert_simulation_emission(
                    emission_id,
                    session["id"],
                    event_id,
                    space_id,
                    prob_id,
                    prob_name,
                    next_tic,
                    next_time,
                    None,
                    True,
                    sequence_id or None,
                    "cancelled",
                )
                continue
            catalog.insert_simulation_emission(
                emission_id,
                session["id"],
                event_id,
                space_id,
                prob_id,
                prob_name,
                next_tic,
                next_time,
                _outcome_body(selected),
                False,
                sequence_id or None,
                None,
            )
            if not sequence_id:
                catalog.update_simulation_emission_status(emission_id, "recorded")
                continue
            _run_emission(
                event,
                session,
                probability,
                selected,
                sequence_id,
                next_tic,
                next_time,
                emission_id,
                principal_id,
            )
        catalog.update_simulation_session(
            session["id"],
            status="running",
            current_tic=next_tic,
            current_world_time=next_time,
            clear_error=True,
        )
    except SimulationHalt as err:
        catalog.update_simulation_session(
            session["id"],
            status="error",
            current_tic=next_tic,
            current_world_time=next_time,
            error_message=str(err),
        )
    detail = catalog.get_simulation_session_detail(session["id"], event_id)
    if detail is None:
        raise LookupError("Session not found")
    return detail


def advance_session(
    event: dict[str, Any], session_id: str, principal_id: str | None = None
) -> dict[str, Any]:
    """Advance one tic. Concurrent calls for the same session run one at a time."""
    session = _require_session(str(event.get("id") or ""), session_id)
    with _session_lock(session["id"]):
        return _advance_unlocked(event, session["id"], principal_id)
