/**
 * Delete STEP / SCHEMA is identified by attributive_label only: normalizeForCompose must
 * (1) strip residual per-path WHERE filters
 * (2) fill the DELETE clause — a hop MATCH deletes only the relationship (nodes stay);
 *     a single-node MATCH DETACH DELETEs that node
 * (3) leave INSTANCE deletes untouched
 * (4) keep an explicit Delete-card / MCP target list instead of overwriting it
 * (5) pin a hop MATCH to the relationship's graph id so a second NEXT is not also deleted
 *
 * Run from App/ui: `npx tsx ../../tests/delete-label-only-compose.mjs`
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { matchHasRelationshipHop, showsDeleteSection } from "../App/authoring/src/matchMode.ts";
import { normalizeForCompose } from "../App/authoring/src/normalize.ts";

const nodeWhere = {
  operator: "AND",
  items: [{ property_key: "status", operator: "=", value: "active" }]
};

function hopDeleteQuery(label) {
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

function nodeDeleteQuery(label) {
  return {
    id: "q-node",
    name: "del-node",
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
                node: { variable: "n0", attributive_label: "Thing", properties: [] }
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
  const hop = hopDeleteQuery(label);
  assert.equal(matchHasRelationshipHop(hop), true, `${label} hop MATCH is a relationship hop`);
  assert.equal(
    showsDeleteSection(hop),
    label === "STEP",
    `${label}: Delete card lists MATCH targets only for STEP hops (SCHEMA still cascades)`
  );
  const normalized = normalizeForCompose(hop);
  assert.deepEqual(
    normalized.delete,
    { detach: false, targets: ["r0"] },
    `${label}: hop MATCH deletes only the relationship`
  );
  const { cypher, sqlite } = composer.composeQuery(normalized);
  assert.match(cypher, /\bDELETE r0\b/, `${label}: composes DELETE of the relationship`);
  assert.doesNotMatch(cypher, /DETACH DELETE/, `${label}: does not DETACH DELETE the endpoint nodes`);
  assert.doesNotMatch(cypher, /WHERE/, `${label}: strips residual WHERE`);
  assert.equal(
    sqlite.filter((s) => /common_label = 'Thing'|common_label = 'Other'/.test(s)).length,
    0,
    `${label}: sqlite does not drop the endpoint node rows`
  );

  const nodeQuery = nodeDeleteQuery(label);
  assert.equal(matchHasRelationshipHop(nodeQuery), false, `${label} lone node is not a hop`);
  assert.equal(
    showsDeleteSection(nodeQuery),
    false,
    `${label}: lone node delete hides the Delete card (cascade)`
  );
  const nodeNorm = normalizeForCompose(nodeQuery);
  assert.deepEqual(
    nodeNorm.delete,
    { detach: true, targets: ["n0"] },
    `${label}: lone node MATCH DETACH DELETEs that node`
  );
  const nodeComposed = composer.composeQuery(nodeNorm);
  assert.match(nodeComposed.cypher, /DETACH DELETE n0/, `${label}: composes DETACH DELETE of the node`);
  assert.equal(nodeComposed.sqlite.length, 1, `${label}: one entities DELETE for the node`);
  assert.match(
    nodeComposed.sqlite[0],
    /DELETE FROM entities WHERE node_label = '[A-Z]+' AND common_label = 'Thing'/,
    `${label}: sqlite deletes the node by common_label`
  );
}

// A STEP hop whose relationship has a graph id must delete that entities row by id,
// never by the reusable common_label (NEXT), and MATCH must pin the same id so a
// second NEXT between the same STEPs is not also removed from the graph.
{
  const hop = hopDeleteQuery("STEP");
  hop.match[0].patterns[0].path[1].relationship.id_binding = {
    key: "id",
    value: "ID_rel_next"
  };
  hop.match[0].patterns[0].path[1].relationship.attributive_label = "NEXT";
  const normalized = normalizeForCompose(hop);
  const { cypher, sqlite } = composer.composeQuery(normalized);
  assert.deepEqual(sqlite, ["DELETE FROM entities WHERE id = 'ID_rel_next';"]);
  assert.match(cypher, /id: ['"]ID_rel_next['"]/, "STEP hop MATCH includes the relationship id");
  assert.match(cypher, /\bDELETE r0\b/, "STEP hop with id still deletes only the relationship");
}

// Explicit Delete-card / MCP targets must not be overwritten by the hop default.
{
  const hop = hopDeleteQuery("STEP");
  hop.delete = { detach: true, targets: ["n0"] };
  const normalized = normalizeForCompose(hop);
  assert.deepEqual(
    normalized.delete,
    { detach: true, targets: ["n0"] },
    "STEP hop: explicit node target is kept"
  );
  const { cypher } = composer.composeQuery(normalized);
  assert.match(cypher, /DETACH DELETE n0/, "explicit node target composes DETACH DELETE of that node");
  assert.doesNotMatch(cypher, /\bDELETE r0\b/, "explicit node target does not also delete the hop");
}

{
  const hop = hopDeleteQuery("STEP");
  hop.delete = { detach: false, targets: ["r0", ""] };
  const normalized = normalizeForCompose(hop);
  assert.deepEqual(
    normalized.delete,
    { detach: false, targets: ["r0"] },
    "blank extra target rows are dropped but the chosen target stays"
  );
}

// INSTANCE delete keeps the regular graph DELETE flow (no auto clause, WHERE preserved).
const inst = normalizeForCompose(hopDeleteQuery("INSTANCE"));
assert.deepEqual(
  inst.delete,
  { detach: false, targets: [] },
  "INSTANCE: delete clause left untouched"
);
assert.equal(showsDeleteSection(hopDeleteQuery("INSTANCE")), true, "INSTANCE: Delete card stays visible");
const instPath = inst.match[0].patterns[0].path[0];
assert.ok(instPath.node.where, "INSTANCE: per-path WHERE preserved");

console.log("delete-label-only-compose: ok");
