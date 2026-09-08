/**
 * Composer STEP payload for join kind.
 *
 * Run: ``npx tsx tests/join-step-payload.mjs`` from the repo root (or ``npm run test:composer`` in App/ui).
 */
import assert from "node:assert/strict";
import { isStepJoin, isStepWait, stepEntityPayload } from "../App/composer/src/step/endpoint.ts";

assert.equal(isStepJoin({ step_type: "join" }), true);
assert.equal(isStepJoin({ step_type: "wait" }), false);
assert.equal(isStepJoin({ step_type: "http" }), false);
assert.equal(isStepWait({ step_type: "join" }), false);

const payload = JSON.parse(stepEntityPayload({ step_type: "join" }));
assert.equal(payload.kind, "join");
assert.equal(payload.endpoint, undefined);
assert.equal(payload.mode, undefined);
assert.equal(payload.duration_seconds, undefined);

console.log("All join-step-payload checks passed.");
