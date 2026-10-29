# Simulated Events — Developer Guide

A simulated event is an on-demand tic timeline. It replaces pointing the world simulation
engine at a pona flow webhook: each tic picks a weighted outcome and runs a sequence in
this instance.

> **One-sentence version:** An event of type `simulated` holds a tic clock and one or more
> probabilities. `POST` a session, then `POST .../tic` to step it. A chosen outcome runs the
> event's sequence with that outcome's payload as parameters.

Time events and external events are unchanged. See [EXTERNAL-EVENTS.md](EXTERNAL-EVENTS.md)
for inbound webhooks.

---

## 1. What a tic does

A session starts at tic 0 on an in-world datetime you choose. Each advance moves to the next
tic and adds the event's tic duration (seconds, minutes, hours, or days) to that clock. Wall
time does not matter; nothing runs until something calls the advance endpoint.

On the new tic, each **probability** that is due runs:

1. **Schedule.** Recurring (every X tics after a Y tic delay), scheduled (an explicit list of
   tic numbers), or random (a percent chance every X tics).
2. **Weights.** Each outcome has a static number, or a `$parameter` name. A `$parameter`
   runs that outcome's weight sequence and reads the parameter from the run's resolved map.
   A missing or non-numeric value uses the parameter's authored default, then `0`. Negative
   weights become `0`. If every weight is `0`, the probability is cancelled: the emission is
   stored, the event sequence does not run, and Wait steps are not released.
3. **Priority.** Lower numbers run first. Equal priorities are shuffled.
4. **Sequence.** The chosen outcome runs the event's sequence. The outcome payload is the
   parameter map. These keys are added when the payload did not set them: `tic`,
   `world_time`, `session_id`, `simulated_event_id`, `probability_id`, `probability_name`,
   `outcome_label`, `cancelled` (`false`), and `emissions`. `emissions` is every emission
   recorded on this tic so far, including this one, in run order. Each item has `id`,
   `session_id`, `event_id`, `space_id`, `probability_id`, `probability_name`, `tic`,
   `world_time`, `outcome`, `cancelled`, `sequence_id`, and `run_status` (`null` until
   that emission's sequence has finished).

Leave **Sequence to run** empty to record the emission without running a sequence.

A weight sequence or the event sequence that returns `error` stops the session. The tic still
commits. Further tics return `409` until `clear-error`. A weight sequence that pauses
(`pending` or `waiting`) does not stop the session: that run is cancelled and the weight
falls through to the default, then `0`. An event sequence that pauses for input (`pending`)
does not stop the session either: that run is cancelled and the emission is recorded as
`pending`. An event sequence that waits (`waiting`) does stop the session.

Random schedules are not seeded, so replaying a session is not guaranteed to pick the same
outcomes.

---

## 2. Session API

The builder shows four public URLs after the first save. The `sim_` token in the path is the
secret, the same idea as an external event's ingest token. No login header is required.

```bash
# Create a session. world_start_at is ISO-8601.
curl -X POST "$BASE/api/sim/$TOKEN/sessions" \
  -H "Content-Type: application/json" \
  -d '{ "world_start_at": "2026-01-01T00:00:00Z" }'

# Step one tic. The body is the session plus its emissions.
curl -X POST "$BASE/api/sim/$TOKEN/sessions/$SESSION_ID/tic"

# Delete a session and its emissions.
curl -X DELETE "$BASE/api/sim/$TOKEN/sessions/$SESSION_ID"

# Allow another tic after a stopped session. The clock does not roll back.
curl -X POST "$BASE/api/sim/$TOKEN/sessions/$SESSION_ID/clear-error"
```

| Status | Cause |
|--------|-------|
| `201` | Session created. |
| `400` | `world_start_at` is missing or not ISO-8601. |
| `403` | The event is disabled. |
| `404` | Unknown token, or the session is not on this event. |
| `409` | The session is in `error` (clear it before the next tic), or the event is not simulated. |

The same actions are available to a signed-in user or an agent key:

- `GET /api/events/{event_id}/sessions`
- `GET /api/events/{event_id}/sessions/{session_id}`
- `POST /api/events/{event_id}/sessions`
- `DELETE /api/events/{event_id}/sessions/{session_id}`
- `POST /api/events/{event_id}/sessions/{session_id}/tic`
- `POST /api/events/{event_id}/sessions/{session_id}/clear-error`

Those routes need space access. Saving the event still needs permission to manage the space.
History (sessions and emissions) is stored in the catalog SQLite database and removed when
the event or its space is deleted.

Sequence runs are audited with trigger `simulated`. `detail` carries `session_id`, `tic`, and
`role` (`weight` or `emission`) and does not carry parameters or outputs.
