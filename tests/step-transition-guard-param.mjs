/**
 * STEP transition guard parameters are not query inputs.
 *
 * A POINTS_TO edge whose condition_type is "parameter" names a value the *sequence*
 * resolves at run time (from an earlier step's response — see
 * execution_run._enqueue_transitions), so it must not register as a parameter of the
 * create query that wires the edge. Collecting it used to flip queryUsesParameters,
 * which hid the "Create step" button and added a phantom parameter row. The headless
 * equivalent (buildStepTransitionQuery) has always declared none.
 *
 * Run:  npx tsx tests/step-transition-guard-param.mjs   (tsx lives in App/ui)
 */
import assert from "node:assert/strict";

import {
  collectReferencedParameterNames,
  queryUsesParameters,
  syncParametersFromReferences
} from "../App/authoring/src/parameterRefs.ts";
import { builderSelectors } from "../App/ui/src/state/builder/selectors.ts";

function existingStepNode(variable, attributiveLabel, id) {
  return {
    kind: "node",
    node: {
      variable,
      alias_mode: "define",
      node_source: "existing",
      attributive_label: attributiveLabel,
      id_binding: { key: "id", value: id },
      properties: []
    }
  };
}

/** create + STEP wiring APPROVE -> NOTIFY, gated on a guard parameter. */
function transitionQuery(relationshipOverrides = {}) {
  return {
    id: "query-transition",
    name: "APPROVE -> NOTIFY",
    operation: "create",
    parameters: [],
    match: [
      {
        label: "STEP",
        optional: false,
        patterns: [
          {
            path: [
              existingStepNode("a1", "APPROVE", "step-approve"),
              {
                kind: "relationship",
                relationship: {
                  variable: "rel1",
                  alias_mode: "define",
                  type: "POINTS_TO",
                  attributive_label: "ON_APPROVAL",
                  id_binding: { key: "id", value: "rel-on-approval" },
                  properties: [],
                  ...relationshipOverrides
                }
              },
              existingStepNode("b1", "NOTIFY", "step-notify")
            ]
          }
        ]
      }
    ]
  };
}

function builderState(query) {
  return {
    spaceId: "space-1",
    runtimeEnabled: false,
    query,
    checks: {},
    run: { status: "idle", error: null, result: null }
  };
}

// --- a parameter guard is invisible to reference collection ---
{
  const query = transitionQuery({
    condition_type: "parameter",
    condition: "$approved",
    condition_expected: true
  });
  assert.deepEqual(collectReferencedParameterNames(query), []);
  assert.equal(queryUsesParameters(query), false);
  assert.equal(
    builderSelectors.showRunButton(builderState(query)),
    true,
    '"Create step" must stay visible for a guarded transition'
  );
  // No phantom row is synced into the parameters card either.
  assert.deepEqual(syncParametersFromReferences(query).parameters, []);
}

// --- a guard written without the leading $ (the engine lstrips it) behaves the same ---
{
  const query = transitionQuery({ condition_type: "parameter", condition: "approved" });
  assert.deepEqual(collectReferencedParameterNames(query), []);
  assert.equal(builderSelectors.showRunButton(builderState(query)), true);
}

// --- other condition types still collect their $tokens ---
{
  const query = transitionQuery({
    condition_type: "implicit",
    condition: "when $reviewer signs off"
  });
  assert.deepEqual(collectReferencedParameterNames(query), ["reviewer"]);
  assert.equal(queryUsesParameters(query), true);
}

// --- no condition at all: unchanged ---
{
  const query = transitionQuery({ condition_type: "null", condition: "" });
  assert.deepEqual(collectReferencedParameterNames(query), []);
  assert.equal(builderSelectors.showRunButton(builderState(query)), true);
}

console.log("step-transition-guard-param: ok");
