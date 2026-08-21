/**
 * Composer STEP payload for local_llm kind.
 *
 * Run: ``node tests/local-llm-payload.mjs`` from the repo root.
 */
import assert from "node:assert/strict";
import { isStepLocalLlm, stepEntityPayload } from "../App/composer/src/step/endpoint.ts";

assert.equal(
  isStepLocalLlm({ step_type: "local_llm", local_llm_config_id: "ID_x" }),
  true
);
assert.equal(isStepLocalLlm({ step_type: "http" }), false);
assert.equal(isStepLocalLlm({ step_type: "code" }), false);

const payload = JSON.parse(
  stepEntityPayload({
    step_type: "local_llm",
    local_llm_config_id: "ID_cfg1",
    response_parameters: [{ property_path: "$.response", parameter: "answer" }],
  })
);

assert.equal(payload.kind, "local_llm");
assert.equal(payload.config_id, "ID_cfg1");
assert.ok(Array.isArray(payload.response_parameters));
assert.equal(payload.response_parameters[0].parameter, "answer");
assert.equal(payload.endpoint, undefined);
assert.equal(payload.resource_id, undefined);

console.log("All local-llm-payload checks passed.");
