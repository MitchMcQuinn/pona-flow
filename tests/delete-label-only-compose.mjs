/**
 * Delete STEP / SCHEMA is identified by attributive_label only: normalizeForCompose must
 * (1) replace the DELETE clause with a DETACH DELETE of every MATCH variable and
 * (2) strip any residual per-path WHERE filters — while leaving INSTANCE deletes untouched.
 *
 * Run from App/ui: `npx tsx ../../tests/delete-label-only-compose.mjs`
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { normalizeForCompose } from "../App/authoring/src/normalize.ts";

function deleteQuery(label) {
  const nodeWhere = {
    operator: "AND",
    items: [{ property_key: "status", operator: "=", value: "active" }]
  };
  return {
    id: "q1",
    name: "del",
    operation: "delete",
    parameters: [],
    match: [
      {
        label,
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "n0",
                  attributive_label: "Thing",
                  properties: [],
                  where: nodeWhere,
                  where_enabled: true
                }
              },
              {
                kind: "relationship",
                relationship: {
                  variable: "r0",
                  attributive_label: "LINK",
                  direction: "outgoing",
                  properties: [],
                  where: nodeWhere,
                  where_enabled: true
                }
              },
              {
                kind: "node",
                node: { variable: "n1", attributive_label: "Other", properties: [] }
              }
            ]
          }
        ]
      }
    ],
    delete: { detach: false, targets: [] }
  };
}

for (const label of ["STEP", "SCHEMA"]) {
  const normalized = normalizeForCompose(deleteQuery(label));
  assert.deepEqual(
    normalized.delete,
    { detach: true, targets: ["n0", "r0", "n1"] },
    `${label}: DETACH DELETE all matched variables`
  );
  const { cypher } = composer.composeQuery(normalized);
  assert.match(cypher, /DETACH DELETE n0, r0, n1/, `${label}: composes DETACH DELETE`);
  assert.doesNotMatch(cypher, /WHERE/, `${label}: strips residual WHERE`);
}

// INSTANCE delete keeps the regular graph DELETE flow (no auto clause, WHERE preserved).
const inst = normalizeForCompose(deleteQuery("INSTANCE"));
assert.deepEqual(
  inst.delete,
  { detach: false, targets: [] },
  "INSTANCE: delete clause left untouched"
);
const instPath = inst.match[0].patterns[0].path[0];
assert.ok(instPath.node.where, "INSTANCE: per-path WHERE preserved");

console.log("delete-label-only-compose: ok");
