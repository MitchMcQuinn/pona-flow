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
  attributiveLabelRequiresUniqueness,
  buildCreateBodyWithOptions,
  collectCreateAttributiveLabels,
  collectCreateCatalogLabels,
  collectCreateEntityIds,
  DEFAULT_STEP_RELATIONSHIP_LABEL,
  isSingleNewStepCreate,
  newQuery,
} from "../App/authoring/src/index.ts";
import { buildStepTransitionQuery } from "../App/mcp/src/intent.ts";

assert.equal(attributiveLabelRequiresUniqueness("STEP", true), true);
assert.equal(attributiveLabelRequiresUniqueness("STEP", false), false);
assert.equal(attributiveLabelRequiresUniqueness("SCHEMA", true), true);
assert.equal(attributiveLabelRequiresUniqueness("SCHEMA", false), true);
assert.equal(attributiveLabelRequiresUniqueness("INSTANCE", false), false);

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

function newNode(label, id) {
  return {
    variable: id,
    alias_mode: "define",
    node_source: "new",
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
  assert.equal(body.catalog_labels, undefined);
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
// STEP-to-STEP labels (NEXT, ON_APPROVAL, …) are reusable — they register in the
// space catalog but are not uniqueness-claimed.

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
    [],
    "STEP relationship labels are not uniqueness-claimed"
  );
  assert.deepEqual(
    collectCreateCatalogLabels(query),
    ["ON_APPROVAL"],
    "STEP relationship labels still register in the space catalog"
  );
  assert.deepEqual(collectCreateEntityIds(query), ["rel-1"]);

  const body = buildCreateBodyWithOptions(
    { spaceId: "space-1", query, runtimeEnabled: false },
    { includeQueriesCatalog: false }
  );
  assert.equal(body.attributive_labels, undefined);
  assert.deepEqual(body.catalog_labels, ["ON_APPROVAL"]);
}

{
  const query = buildStepTransitionQuery(
    {
      from: { id: "step-a", attributive_label: "STEP_A" },
      to: { id: "step-b", attributive_label: "STEP_B" },
      relationship_label: DEFAULT_STEP_RELATIONSHIP_LABEL,
    },
    { queryId: "q-next", entityIds: ["rel-2"] }
  );
  assert.deepEqual(collectCreateAttributiveLabels(query), []);
  assert.deepEqual(collectCreateCatalogLabels(query), ["NEXT"]);
}

// New STEP node plus a NEXT edge: only the node label is uniqueness-claimed.

{
  const query = newQuery("create");
  query.match = [
    {
      label: "STEP",
      optional: false,
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "a1",
                alias_mode: "define",
                node_source: "new",
                attributive_label: "STEP_A",
                id_binding: { key: "id", value: "ent-step-a" },
                properties: [],
              },
            },
            {
              kind: "relationship",
              relationship: {
                variable: "rel1",
                alias_mode: "define",
                type: "POINTS_TO",
                attributive_label: "NEXT",
                id_binding: { key: "id", value: "ent-next" },
                properties: [],
              },
            },
            {
              kind: "node",
              node: {
                variable: "b1",
                alias_mode: "define",
                node_source: "existing",
                attributive_label: "STEP_B",
                id_binding: { key: "id", value: "ent-step-b" },
                properties: [],
              },
            },
          ],
        },
      ],
    },
  ];
  assert.deepEqual(collectCreateAttributiveLabels(query), ["STEP_A"]);
  assert.deepEqual(collectCreateCatalogLabels(query), ["STEP_A", "NEXT"]);
  const body = buildCreateBodyWithOptions(
    { spaceId: "space-1", query, runtimeEnabled: false },
    { includeQueriesCatalog: false }
  );
  assert.deepEqual(body.attributive_labels, ["STEP_A"]);
  assert.deepEqual(body.catalog_labels, ["STEP_A", "NEXT"]);
  assert.equal(isSingleNewStepCreate(query), false, "a hop is not a single new STEP");
}

{
  const query = newQuery("create");
  query.match = [
    {
      label: "STEP",
      optional: false,
      patterns: [{ path: [{ kind: "node", node: newNode("PING_WEBHOOK", "ent-ping") }] }],
    },
  ];
  assert.equal(isSingleNewStepCreate(query), true, "one new STEP with no hops can publish");
}

{
  const query = newQuery("create");
  query.match = [
    {
      label: "STEP",
      optional: false,
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "n1",
                alias_mode: "define",
                attributive_label: "UNSET_SOURCE",
                properties: [],
              },
            },
          ],
        },
      ],
    },
  ];
  assert.equal(
    isSingleNewStepCreate(query),
    false,
    "a STEP without node_source new (no + ADD NEW NODE) cannot publish"
  );
}

{
  const query = newQuery("create");
  query.match = [
    {
      label: "STEP",
      optional: false,
      patterns: [
        { path: [{ kind: "node", node: newNode("STEP_A", "ent-a") }] },
        { path: [{ kind: "node", node: newNode("STEP_B", "ent-b") }] },
      ],
    },
  ];
  assert.equal(isSingleNewStepCreate(query), false, "two new STEPs cannot publish as one sequence");
}

{
  const query = newQuery("create");
  query.match = [
    {
      label: "STEP",
      optional: false,
      patterns: [{ path: [{ kind: "node", node: existingNode("STEP_A", "ent-a") }] }],
    },
  ];
  assert.equal(isSingleNewStepCreate(query), false, "picking an existing STEP cannot publish");
}

console.log("create-attributive-labels: ok");
