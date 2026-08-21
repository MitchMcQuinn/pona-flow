/**
 * Create packages must claim attributive_labels only for entities they actually write.
 *
 * Selecting an existing SCHEMA (or STEP) as a relationship endpoint puts that node's
 * attributive_label on the path so the composer can MATCH it. That label is already owned
 * by the selected node. Sending it as a "new" label makes the server uniqueness gate
 * reject the create as a collision — which is exactly how a self-referential SCHEMA
 * relationship (MESSAGE)-[:FOLLOWS_MESSAGE]->(MESSAGE) used to fail.
 */

import assert from "node:assert/strict";

import {
  buildCreateBodyWithOptions,
  collectCreateAttributiveLabels,
  collectCreateEntityIds,
  newQuery,
} from "../App/authoring/src/index.ts";
import { buildStepTransitionQuery } from "../App/mcp/src/intent.ts";

function schemaRelCreate({ from, rel, to }) {
  const query = newQuery("create");
  query.id = "q-rel";
  query.name = "rel-create";
  query.match = [
    {
      label: "SCHEMA",
      optional: false,
      patterns: [
        {
          path: [
            { kind: "node", node: from },
            { kind: "relationship", relationship: rel },
            { kind: "node", node: to },
          ],
        },
      ],
    },
  ];
  return query;
}

function existingNode(label, id) {
  return {
    variable: id,
    alias_mode: "define",
    node_source: "existing",
    attributive_label: label,
    id_binding: { key: "id", value: id },
    properties: [],
  };
}

function newRel(label, id, extra = {}) {
  return {
    variable: id,
    alias_mode: "define",
    type: "POINTS_TO",
    attributive_label: label,
    id_binding: { key: "id", value: id },
    properties: [],
    ...extra,
  };
}

// --- Self-referential SCHEMA relationship onto an existing node ---

{
  const query = schemaRelCreate({
    from: existingNode("MESSAGE", "ent-message"),
    rel: newRel("FOLLOWS_MESSAGE", "ent-follows"),
    to: existingNode("MESSAGE", "ent-message"),
  });

  assert.deepEqual(
    collectCreateAttributiveLabels(query),
    ["FOLLOWS_MESSAGE"],
    "existing MESSAGE endpoints must not be claimed as new labels"
  );
  assert.deepEqual(
    collectCreateEntityIds(query),
    ["ent-follows"],
    "only the new relationship owns the claimed label"
  );

  const body = buildCreateBodyWithOptions(
    { spaceId: "space-1", query, runtimeEnabled: false },
    { includeQueriesCatalog: false }
  );
  assert.deepEqual(body.attributive_labels, ["FOLLOWS_MESSAGE"]);
  assert.deepEqual(body.attributive_label_owner_ids, ["ent-follows"]);
}

// Alias-reference close of the same loop (the builder's self-loop shape).

{
  const query = schemaRelCreate({
    from: existingNode("MESSAGE", "ent-message"),
    rel: newRel("FOLLOWS_MESSAGE", "ent-follows"),
    to: {
      variable: "ent-message",
      alias_mode: "reference",
      alias_ref: "ent-message",
      attributive_label: "MESSAGE",
      properties: [],
    },
  });
  assert.deepEqual(collectCreateAttributiveLabels(query), ["FOLLOWS_MESSAGE"]);
  assert.deepEqual(collectCreateEntityIds(query), ["ent-follows"]);
}

// Two different existing schemas joined by a new relationship type.

{
  const query = schemaRelCreate({
    from: existingNode("PERSON", "ent-person"),
    rel: newRel("WORKS_AT", "ent-works-at"),
    to: existingNode("COMPANY", "ent-company"),
  });
  assert.deepEqual(collectCreateAttributiveLabels(query), ["WORKS_AT"]);
  assert.deepEqual(collectCreateEntityIds(query), ["ent-works-at"]);
}

// Reusing an existing SCHEMA relationship type: the type label is already owned.

{
  const query = schemaRelCreate({
    from: existingNode("PERSON", "ent-person"),
    rel: newRel("HAS", "ent-new-edge", { node_source: "existing" }),
    to: existingNode("CAR", "ent-car"),
  });
  assert.deepEqual(
    collectCreateAttributiveLabels(query),
    [],
    "reused relationship types are not new labels"
  );
  assert.deepEqual(collectCreateEntityIds(query), []);
}

// A brand-new SCHEMA node still claims its own label.

{
  const query = newQuery("create");
  query.match = [
    {
      label: "SCHEMA",
      optional: false,
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "CUSTOMER",
                alias_mode: "define",
                node_source: "new",
                attributive_label: "CUSTOMER",
                id_binding: { key: "id", value: "ent-customer" },
                properties: [],
              },
            },
          ],
        },
      ],
    },
  ];
  assert.deepEqual(collectCreateAttributiveLabels(query), ["CUSTOMER"]);
  assert.deepEqual(collectCreateEntityIds(query), ["ent-customer"]);
}

// STEP transition: existing endpoints, new POINTS_TO edge.

{
  const query = buildStepTransitionQuery(
    {
      from: { id: "step-a", attributive_label: "STEP_A" },
      to: { id: "step-b", attributive_label: "STEP_B" },
      relationship_label: "ON_APPROVAL",
    },
    { queryId: "q-transition", entityIds: ["rel-1"] }
  );
  assert.deepEqual(
    collectCreateAttributiveLabels(query),
    ["ON_APPROVAL"],
    "existing STEP endpoints must not be claimed as new labels"
  );
  assert.deepEqual(collectCreateEntityIds(query), ["rel-1"]);
}

console.log("create-attributive-labels: ok");
