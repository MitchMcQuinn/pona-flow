/**
 * Hand-declared parameters survive reference sync.
 *
 * Parameters used to exist only as a projection of the $name tokens found in a query, so
 * anything not referenced was deleted on the next builder render. A `declared` parameter is
 * one the author added deliberately — typically an input collected at a sequence's entry
 * step for a later step to read — so it must persist unreferenced, and it must not trip the
 * STEP body rule that requires every required parameter to appear in the body.
 *
 * Run:  npx tsx tests/declared-parameters.mjs   (tsx lives in App/ui)
 */
import assert from "node:assert/strict";

import { syncParametersFromReferences } from "../App/authoring/src/parameterRefs.ts";
import { validateStepBodyParameters } from "../App/authoring/src/stepBodyParams.ts";
import {
  addParameter,
  removeParameterAt
} from "../App/ui/src/state/builder/queryHelpers.ts";

function parameter(name, overrides = {}) {
  return { name, data_type: "string", value: "", is_required: false, ...overrides };
}

/** read + INSTANCE returning one property — no $name tokens anywhere. */
function readQuery(parameters = []) {
  return {
    id: "query-read",
    name: "people",
    operation: "read",
    parameters,
    match: [
      {
        label: "INSTANCE",
        optional: false,
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "n1",
                  alias_mode: "define",
                  attributive_label: "PERSON",
                  properties: []
                }
              }
            ]
          }
        ]
      }
    ],
    return: { distinct: false, items: [{ expression: "n1.NAME" }] }
  };
}

const names = (query) => query.parameters.map((p) => p.name);

// --- declared survives; an unreferenced orphan does not ---
{
  const query = readQuery([
    parameter("reviewer", { declared: true }),
    parameter("stale")
  ]);
  assert.deepEqual(names(syncParametersFromReferences(query)), ["reviewer"]);
}

// --- a blank-named row lives long enough to be named ---
{
  const query = readQuery([parameter("", { declared: true })]);
  const synced = syncParametersFromReferences(query);
  assert.equal(synced.parameters.length, 1);
  assert.equal(synced.parameters[0].declared, true);
  // Sync normalizes it, so the schematic defaults the card's selects read are present.
  assert.equal(synced.parameters[0].schematic_properties.value_type, "string");
}

// --- declared metadata (type, default, required, description) round-trips ---
{
  const query = readQuery([
    parameter("threshold", {
      declared: true,
      is_required: true,
      value: "5",
      description: "How many to keep.",
      schematic_properties: { value_type: "integer", is_required: true }
    })
  ]);
  const [synced] = syncParametersFromReferences(query).parameters;
  assert.equal(synced.is_required, true);
  assert.equal(synced.value, "5");
  assert.equal(synced.description, "How many to keep.");
  assert.equal(synced.schematic_properties.value_type, "integer");
}

// --- a declared parameter that is also referenced appears exactly once, still declared ---
{
  const query = readQuery([parameter("limitTo", { declared: true })]);
  query.return.items = [{ expression: "n1.NAME", property_key: "$limitTo" }];
  const synced = syncParametersFromReferences(query);
  assert.deepEqual(names(synced), ["limitTo"]);
  assert.equal(synced.parameters[0].declared, true);
  // The origin still applies: a RETURN field parameter is required and locked.
  assert.equal(synced.parameters[0].is_required, true);
}

// --- idempotent: the builder re-runs sync on every query change ---
{
  const query = readQuery([
    parameter("reviewer", { declared: true }),
    parameter("", { declared: true })
  ]);
  const once = syncParametersFromReferences(query);
  const twice = syncParametersFromReferences(once);
  assert.equal(twice, once, "a second pass must return the same object (no render loop)");
}

// --- add/remove helpers ---
{
  const added = addParameter()(readQuery());
  assert.equal(added.parameters.length, 1);
  assert.equal(added.parameters[0].declared, true);
  // Two unnamed rows: removal is positional so it cannot take both.
  const two = addParameter()(added);
  const left = removeParameterAt(0)(two);
  assert.equal(left.parameters.length, 1);
}

// --- STEP body rule: a declared required input need not appear in the body ---
{
  const body = '{ "message": "$message" }';
  assert.deepEqual(
    validateStepBodyParameters(body, [
      parameter("message", { is_required: true }),
      parameter("reviewer", { is_required: true, declared: true })
    ]),
    []
  );
  // A discovered (non-declared) required parameter still has to be referenced.
  assert.deepEqual(
    validateStepBodyParameters(body, [
      parameter("message", { is_required: true }),
      parameter("reviewer", { is_required: true })
    ]),
    ['Required parameter "$reviewer" is not referenced in the body.']
  );
  // And an unknown $token in the body is still flagged, declared rows notwithstanding.
  assert.deepEqual(
    validateStepBodyParameters('{ "message": "$mystery" }', [
      parameter("reviewer", { declared: true })
    ]),
    ['Body references unknown parameter "$mystery".']
  );
}

console.log("declared-parameters: ok");
