/**
 * Delete INSTANCE by parameterized id: a MATCH that binds exactly one entity has only
 * one possible DELETE target, so soleDeleteTargetVariable must offer it for auto-fill
 * (DeleteSection pre-selects it) instead of blocking creation on the manual picker
 * with "DELETE requires at least one target variable."
 *
 * Ambiguous matches (multi-entity paths) and already-targeted deletes must return null
 * so explicit target selection keeps working unchanged.
 *
 * Run from App/ui: `npx tsx ../../tests/delete-sole-target-autofill.mjs`
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { normalizeForCompose } from "../App/authoring/src/normalize.ts";
import { validateQuery } from "../App/authoring/src/validation.ts";
import { syncParametersFromReferences } from "../App/authoring/src/parameterRefs.ts";
import { soleDeleteTargetVariable } from "../App/authoring/src/returnProjections.ts";
import { setDeleteTargets } from "../App/ui/src/state/builder/queryHelpers.ts";

function pillarNode() {
  return {
    kind: "node",
    node: {
      variable: "pillar",
      alias_mode: "define",
      attributive_label: "PILLAR",
      properties: [],
      where: {
        operator: "AND",
        items: [{ property_key: "id", operator: "=", value: "$pillarID" }]
      }
    }
  };
}

function deleteQuery({ path, targets = [], operation = "delete" }) {
  return syncParametersFromReferences({
    id: "q1",
    name: "delete pillar",
    operation,
    parameters: [],
    match: [{ label: "INSTANCE", optional: false, patterns: [{ path }] }],
    delete: operation === "delete" ? { detach: false, targets } : undefined,
    skip: null,
    limit: null
  });
}

// Single bound entity, no targets -> auto-fillable.
const single = deleteQuery({ path: [pillarNode()] });
assert.equal(soleDeleteTargetVariable(single), "pillar", "single node is the sole target");

// Blank target rows (e.g. after a reset) still count as "no target chosen".
const blankRow = deleteQuery({ path: [pillarNode()], targets: [""] });
assert.equal(soleDeleteTargetVariable(blankRow), "pillar", "blank rows don't block auto-fill");

// An explicit target wins: no auto-fill.
const chosen = deleteQuery({ path: [pillarNode()], targets: ["pillar"] });
assert.equal(soleDeleteTargetVariable(chosen), null, "explicit target disables auto-fill");

// Multi-entity path is ambiguous: keep the manual picker.
const multi = deleteQuery({
  path: [
    pillarNode(),
    {
      kind: "relationship",
      relationship: {
        variable: "r0",
        attributive_label: "HAS_MANY",
        direction: "outgoing",
        properties: []
      }
    },
    { kind: "node", node: { variable: "value", attributive_label: "VALUE", properties: [] } }
  ]
});
assert.equal(soleDeleteTargetVariable(multi), null, "multi-entity match stays manual");

// Non-delete operations never auto-fill.
const read = deleteQuery({ path: [pillarNode()], operation: "read" });
assert.equal(soleDeleteTargetVariable(read), null, "read op returns null");

// End-to-end: auto-filled target validates clean and composes a parameterized DELETE.
assert.deepEqual(
  validateQuery(single, false),
  ["DELETE requires at least one target variable."],
  "target-less delete still warns before auto-fill"
);
const filled = setDeleteTargets([soleDeleteTargetVariable(single)])(single);
assert.deepEqual(validateQuery(filled, false), [], "auto-filled delete validates clean");
assert.deepEqual(
  filled.parameters.map((p) => p.name),
  ["pillarID"],
  "$pillarID registers as a runtime parameter"
);
const { cypher } = composer.composeQuery(normalizeForCompose(filled));
assert.match(cypher, /WHERE \(pillar\.id = \$pillarID\)/, "WHERE keeps the id parameter");
assert.match(cypher, /DELETE pillar/, "composes DELETE of the matched node");

console.log("delete-sole-target-autofill: ok");
