/**
 * Composer STEP payload for operation kind.
 *
 * Run: ``npx tsx tests/operation-step-payload.mjs`` from the repo root (or ``npm run test:composer`` in App/ui).
 */
import assert from "node:assert/strict";
import { isStepJoin, isStepOperation, stepEntityPayload } from "../App/composer/src/step/endpoint.ts";

assert.equal(isStepOperation({ step_type: "operation" }), true);
assert.equal(isStepOperation({ step_type: "join" }), false);
assert.equal(isStepOperation({ step_type: "http" }), false);
assert.equal(isStepJoin({ step_type: "operation" }), false);

const payload = JSON.parse(
  stepEntityPayload({
    step_type: "operation",
    operation_evaluation: {
      name: " account_tier_routing ",
      collision: "skip",
      group_junction: "OR",
      groups: [
        {
          statement_junction: "AND",
          statements: [
            { x: "$user.email", operator: "ENDS WITH", y: "@corp.example.com" },
            { x: "$user.tenure_months", operator: "EXISTS", y: "ignored" },
          ],
        },
      ],
    },
    operation_assignments: [
      { when: "true", type: "boolean", key: " has_seniority ", value: true },
    ],
  })
);

assert.equal(payload.kind, "operation");
assert.equal(payload.endpoint, undefined);
assert.equal(payload.evaluation.name, "account_tier_routing");
assert.equal(payload.evaluation.collision, "skip");
assert.equal(payload.evaluation.group_junction, "OR");
assert.equal(payload.evaluation.groups[0].statements[1].y, undefined);
assert.equal(payload.assignments[0].key, "has_seniority");
assert.equal(payload.assignments[0].value, true);

console.log("All operation-step-payload checks passed.");
