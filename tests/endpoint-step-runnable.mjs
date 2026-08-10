/**
 * Custom-endpoint STEP create model fix:
 *  - isRunnableEndpointStepCreate gates Run for a parameterized custom-endpoint STEP
 *    create with a literal identity (and only then), so its $param tokens persist
 *    verbatim and are substituted at sequence runtime.
 *  - buildStepLabelOptions annotates each STEP attributive_label with its resolved
 *    kind (endpoint / operation / sequence / system) to disambiguate name overlaps.
 */
import assert from "node:assert/strict";

const { isRunnableEndpointStepCreate } = await import(
  "../App/authoring/src/matchMode.ts"
);
const { buildStepLabelOptions } = await import(
  "../App/ui/src/state/builder/attributiveLabelOptions.ts"
);

function endpointStepCreate(overrides = {}) {
  const node = {
    variable: "s",
    attributive_label: "SEND_TO_TEST_FLOW",
    labels: ["STEP"],
    node_source: "new",
    properties: [],
    id_binding: { key: "id", value: "step-send-to-test-flow" },
    sequencial_properties: {
      endpoint: "https://example.test/webhook",
      method: "POST",
      body: { message: "$message", extra: "$secondMessage" }
    },
    ...overrides
  };
  return {
    id: "q-endpoint-step",
    operation: "create",
    match: [{ label: "STEP", patterns: [{ path: [{ kind: "node", node }] }] }],
    parameters: [{ name: "message", data_type: "string", value: "", is_required: true }]
  };
}

// 1. Parameterized custom endpoint with literal identity -> runnable.
assert.equal(isRunnableEndpointStepCreate(endpointStepCreate()), true);

// 2. $param attributive_label -> NOT runnable (identity must be literal to MERGE).
assert.equal(
  isRunnableEndpointStepCreate(endpointStepCreate({ attributive_label: "$label" })),
  false
);

// 3. $param graph id -> NOT runnable.
assert.equal(
  isRunnableEndpointStepCreate(
    endpointStepCreate({ id_binding: { key: "id", value: "$id" } })
  ),
  false
);

// 4. Operation-backed STEP (query_id set) -> NOT a custom endpoint -> NOT runnable here.
assert.equal(
  isRunnableEndpointStepCreate(
    endpointStepCreate({ sequencial_properties: { query_id: "query-abc-1" } })
  ),
  false
);

// 5. Existing-node reference (match, not create) -> NOT runnable as a create.
assert.equal(
  isRunnableEndpointStepCreate(endpointStepCreate({ node_source: "existing" })),
  false
);

// 6. Wrong operation -> NOT runnable.
const asUpdate = { ...endpointStepCreate(), operation: "update" };
assert.equal(isRunnableEndpointStepCreate(asUpdate), false);

// --- buildStepLabelOptions: kind annotation ---
const rows = [
  { attributive_label: "SEND_TO_TEST_FLOW", sequencial_properties: {} },
  { attributive_label: "DO_OPERATION", sequencial_properties: { query_id: "q-op" } },
  { attributive_label: "RUN_SEQUENCE", sequencial_properties: { query_id: "q-seq" } },
  { attributive_label: "SYS_STEP", sequencial_properties: { query_id: "q-sys" } }
];
const savedQueries = [
  { id: "q-op", kind: "operation" },
  { id: "q-seq", kind: "sequence" },
  { id: "q-sys", kind: "system" }
];

const options = buildStepLabelOptions(rows, [], savedQueries, false);
const kindByLabel = Object.fromEntries(options.map((o) => [o.value, o.kind]));
assert.equal(kindByLabel.SEND_TO_TEST_FLOW, "endpoint");
assert.equal(kindByLabel.DO_OPERATION, "operation");
assert.equal(kindByLabel.RUN_SEQUENCE, "sequence");
assert.equal(kindByLabel.SYS_STEP, "system");

// A query_id with no matching catalog row resolves to "unknown".
const orphan = buildStepLabelOptions(
  [{ attributive_label: "ORPHAN", sequencial_properties: { query_id: "missing" } }],
  [],
  savedQueries,
  false
);
assert.equal(orphan[0].kind, "unknown");

// requireSpaceCatalog limits results to labels registered in spaces.labels.
const filtered = buildStepLabelOptions(rows, ["SEND_TO_TEST_FLOW"], savedQueries, true);
assert.deepEqual(
  filtered.map((o) => o.value),
  ["SEND_TO_TEST_FLOW"]
);

console.log("endpoint-step-runnable: ok");
