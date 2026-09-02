/**
 * Code-execution STEP composer payloads:
 *  - isStepCodeExecution identifies code steps (step_type === "code", no query_id);
 *  - stepEntityPayload serializes code steps as { kind: "code", resource_id } —
 *    the code text itself must NEVER land in the entity payload;
 *  - response_parameters survive on code payloads so $bindings keep working;
 *  - HTTP and operation-backed steps are untouched (kind defaults to HTTP).
 */
import assert from "node:assert/strict";

const { isStepCodeExecution, isStepCustomEndpoint, stepEntityPayload } = await import(
  "../App/composer/src/step/endpoint.ts"
);

const codeSp = {
  step_type: "code",
  resource_id: "ID_res123",
  resource_name: "My Script",
  resource_description: "adds numbers",
  language: "python",
  code: "total = $amount\nresult = {'total': total}",
  response_parameters: [{ property_path: "$.total", parameter: "total" }]
};

// --- detection -------------------------------------------------------------------
assert.equal(isStepCodeExecution(codeSp), true);
assert.equal(isStepCodeExecution({ endpoint: "https://x.test", method: "POST" }), false);
assert.equal(isStepCodeExecution({ step_type: "http" }), false);
assert.equal(isStepCodeExecution(undefined), false);
// An operation-backed step is never a code step, even with a stray step_type.
assert.equal(isStepCodeExecution({ query_id: "q1", step_type: "code" }), false);
// Code steps are still "custom" steps (not operation-backed).
assert.equal(isStepCustomEndpoint(codeSp), true);

// --- code payload -----------------------------------------------------------------
const payload = JSON.parse(stepEntityPayload(codeSp));
assert.deepEqual(payload, {
  kind: "code",
  resource_id: "ID_res123",
  response_parameters: [{ property_path: "$.total", parameter: "total" }]
});

// The raw code, name, description, and language never leak into the entity payload.
const raw = stepEntityPayload(codeSp);
assert.equal(raw.includes("total = $amount"), false);
assert.equal(raw.includes("My Script"), false);
assert.equal(raw.includes("adds numbers"), false);
assert.equal(raw.includes("python"), false);

// Without response parameters the payload is minimal.
assert.deepEqual(
  JSON.parse(stepEntityPayload({ step_type: "code", resource_id: "ID_r2" })),
  { kind: "code", resource_id: "ID_r2" }
);

// Missing resource_id serializes as empty string (engine surfaces a clear step error).
assert.equal(JSON.parse(stepEntityPayload({ step_type: "code" })).resource_id, "");

// --- HTTP / operation payloads unchanged (kind defaults to HTTP when absent) -------
const httpPayload = JSON.parse(
  stepEntityPayload({
    endpoint: "https://example.test/hook",
    method: "PUT",
    headers: { "X-K": "v" },
    body: { message: "$message" }
  })
);
assert.deepEqual(httpPayload, {
  endpoint: "https://example.test/hook",
  method: "PUT",
  headers: { "X-K": "v" },
  body: { message: "$message" }
});
assert.equal(httpPayload.kind, undefined);

assert.deepEqual(JSON.parse(stepEntityPayload({ query_id: "q-op-1" })), {
  query_id: "q-op-1"
});

console.log("code-step-payload: ok");
