/**
 * Composer STEP payload for wait kind (duration / until / event).
 *
 * Run: ``npx tsx tests/wait-step-payload.mjs`` from the repo root (or ``npm run test:composer`` in App/ui).
 */
import assert from "node:assert/strict";
import { isStepWait, stepEntityPayload } from "../App/composer/src/step/endpoint.ts";

assert.equal(isStepWait({ step_type: "wait", wait_mode: "duration" }), true);
assert.equal(isStepWait({ step_type: "http" }), false);
assert.equal(isStepWait({ step_type: "local_llm" }), false);

const duration = JSON.parse(
  stepEntityPayload({
    step_type: "wait",
    wait_mode: "duration",
    wait_duration_seconds: 90
  })
);
assert.equal(duration.kind, "wait");
assert.equal(duration.mode, "duration");
assert.equal(duration.duration_seconds, 90);
assert.equal(duration.until, undefined);
assert.equal(duration.event_id, undefined);
assert.equal(duration.endpoint, undefined);
assert.equal(duration.response_parameters, undefined);

const paramDuration = JSON.parse(
  stepEntityPayload({
    step_type: "wait",
    wait_mode: "duration",
    wait_duration_seconds: "$hold"
  })
);
assert.equal(paramDuration.duration_seconds, "$hold");

const until = JSON.parse(
  stepEntityPayload({
    step_type: "wait",
    wait_mode: "until",
    wait_until: "2026-09-06T12:00:00.000Z"
  })
);
assert.equal(until.mode, "until");
assert.equal(until.until, "2026-09-06T12:00:00.000Z");
assert.equal(until.duration_seconds, undefined);

const event = JSON.parse(
  stepEntityPayload({
    step_type: "wait",
    wait_mode: "event",
    wait_event_id: "ID_evt1"
  })
);
assert.equal(event.mode, "event");
assert.equal(event.event_id, "ID_evt1");
assert.equal(event.duration_seconds, undefined);

console.log("All wait-step-payload checks passed.");
