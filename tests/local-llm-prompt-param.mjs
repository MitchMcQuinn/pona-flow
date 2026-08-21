/**
 * Local LLM STEP declares a required ``prompt`` parameter plus the optional setting
 * overrides via authoring sync.
 *
 * Run: ``npx tsx ../../tests/local-llm-prompt-param.mjs`` from App/ui.
 */
import assert from "node:assert/strict";
import {
  collectParameterOriginMeta,
  collectReferencedParameterNames,
  syncParametersFromReferences
} from "../App/authoring/src/parameterRefs.ts";

function localLlmQuery(overrides = {}) {
  return {
    id: "q-llm",
    name: "llm",
    operation: "create",
    parameters: [],
    match: [
      {
        label: "STEP",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "n1",
                  attributive_label: "ASK_LLM",
                  node_source: "new",
                  properties: [],
                  sequencial_properties: {
                    step_type: "local_llm",
                    local_llm_config_id: "ID_cfg1"
                  },
                  ...overrides
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

const refs = collectReferencedParameterNames(localLlmQuery());
assert.ok(refs.includes("prompt"), "local_llm references prompt");

const meta = collectParameterOriginMeta(localLlmQuery());
assert.equal(meta.get("prompt")?.is_required, true);
assert.equal(meta.get("prompt")?.locked, true);

const synced = syncParametersFromReferences(localLlmQuery());
const prompt = synced.parameters.find((p) => p.name === "prompt");
assert.ok(prompt, "sync adds prompt");
assert.equal(prompt.is_required, true);
assert.equal(prompt.schematic_properties?.is_required, true);

// Optional overrides: every saved setting can be replaced for a single run.
const OVERRIDES = {
  system_prompt: "string",
  response_format: "radio",
  json_schema: "string",
  temperature: "number",
  top_p: "number",
  top_k: "integer",
  min_p: "number",
  repeat_penalty: "number",
  num_ctx: "integer",
  num_predict: "integer",
  seed: "integer",
  stop: "array"
};

for (const [name, valueType] of Object.entries(OVERRIDES)) {
  assert.ok(refs.includes(name), `local_llm references ${name}`);
  assert.equal(meta.get(name)?.is_required, false, `${name} is optional`);
  assert.equal(meta.get(name)?.locked, true, `${name} is locked`);
  assert.equal(meta.get(name)?.value_type, valueType, `${name} value_type`);

  const param = synced.parameters.find((p) => p.name === name);
  assert.ok(param, `sync adds ${name}`);
  assert.equal(param.is_required, false);
  assert.equal(param.schematic_properties?.value_type, valueType);
}

assert.deepEqual(meta.get("response_format")?.options, ["text", "json_schema"]);
assert.deepEqual(
  synced.parameters.find((p) => p.name === "response_format")?.schematic_properties?.options,
  ["text", "json_schema"]
);

const existingSkip = localLlmQuery({ node_source: "existing" });
const existingRefs = collectReferencedParameterNames(existingSkip);
assert.equal(
  existingRefs.includes("prompt"),
  false,
  "existing STEP create does not pull prompt from the target node"
);
for (const name of Object.keys(OVERRIDES)) {
  assert.equal(
    existingRefs.includes(name),
    false,
    `existing STEP create does not pull ${name} from the target node`
  );
}

console.log("All local-llm-prompt-param checks passed.");
