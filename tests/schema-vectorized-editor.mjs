/**
 * The builder-side plumbing for the vector-search toggles.
 *
 * Two behaviours worth pinning, both about what the author does *not* have to do:
 *   - turning on `is_vectorized` seeds `is_embedded` on the is_label property, so a freshly
 *     vectorized type has embeddable text without a second click — but only when nothing else
 *     is already marked, so it never overrides a deliberate choice;
 *   - turning it back off leaves the per-property marks intact, so re-enabling restores the
 *     author's include list instead of silently starting over.
 *
 * Also covers the SCHEMA-update extraction, since the flag rides in the request body beside
 * `schemata` rather than inside it.
 */

import assert from "node:assert/strict";
import { setSchemaVectorized } from "../App/ui/src/state/builder/queryHelpers.ts";
import { extractSchemaUpdateInput } from "../App/ui/src/services/schemaUpdate.ts";
import { newSchematicProperties } from "../App/authoring/src/index.ts";

function prop(key, overrides = {}) {
  return {
    key,
    value: "",
    schematic_properties: { ...newSchematicProperties(), ...overrides }
  };
}

function nodeQuery(properties, extra = {}) {
  return {
    operation: "create",
    parameters: [],
    match: [
      {
        label: "SCHEMA",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "CUSTOMER",
                  attributive_label: "CUSTOMER",
                  id_binding: { key: "id", value: "ID_schema" },
                  properties,
                  ...extra
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

const nodeOf = (query) => query.match[0].patterns[0].path[0].node;
const schematicOf = (query, key) =>
  nodeOf(query).properties.find((p) => p.key === key).schematic_properties;

// --- enabling seeds the is_label property ---
const seeded = setSchemaVectorized(
  0,
  0,
  0,
  true
)(nodeQuery([prop("NAME", { is_label: true, is_required: true }), prop("NOTES")]));
assert.equal(nodeOf(seeded).is_vectorized, true);
assert.equal(schematicOf(seeded, "NAME").is_embedded, true, "is_label seeds the include list");
assert.equal(schematicOf(seeded, "NOTES").is_embedded, false);

// --- an explicit choice is never overridden ---
const chosen = setSchemaVectorized(
  0,
  0,
  0,
  true
)(nodeQuery([prop("NAME", { is_label: true, is_required: true }), prop("NOTES", { is_embedded: true })]));
assert.equal(schematicOf(chosen, "NAME").is_embedded, false, "seeding skips a deliberate list");
assert.equal(schematicOf(chosen, "NOTES").is_embedded, true);

// --- disabling keeps the marks, so re-enabling restores the same list ---
const disabled = setSchemaVectorized(0, 0, 0, false)(chosen);
assert.equal(nodeOf(disabled).is_vectorized, false);
assert.equal(schematicOf(disabled, "NOTES").is_embedded, true, "marks survive a disable");
const reEnabled = setSchemaVectorized(0, 0, 0, true)(disabled);
assert.equal(schematicOf(reEnabled, "NOTES").is_embedded, true);
assert.equal(schematicOf(reEnabled, "NAME").is_embedded, false, "no re-seeding over a real list");

// --- relationships take the same path ---
const relQuery = {
  operation: "create",
  parameters: [],
  match: [
    {
      label: "SCHEMA",
      patterns: [
        {
          path: [
            { kind: "node", node: { variable: "a", attributive_label: "CUSTOMER", properties: [] } },
            {
              kind: "relationship",
              relationship: {
                variable: "r",
                type: "POINTS_TO",
                attributive_label: "PLACED",
                direction: "outgoing",
                id_binding: { key: "id", value: "ID_rel" },
                properties: [prop("WHEN", { is_label: true, is_required: true })]
              }
            },
            { kind: "node", node: { variable: "b", attributive_label: "ORDER", properties: [] } }
          ]
        }
      ]
    }
  ]
};
const relOn = setSchemaVectorized(0, 0, 1, true)(relQuery);
const relationship = relOn.match[0].patterns[0].path[1].relationship;
assert.equal(relationship.is_vectorized, true);
assert.equal(relationship.properties[0].schematic_properties.is_embedded, true);

// --- the update request carries the flag beside the schemata ---
const updateInput = extractSchemaUpdateInput({
  spaceId: "space_a",
  query: nodeQuery([prop("NAME", { is_label: true, is_required: true })], {
    node_source: "existing",
    is_vectorized: true
  })
});
assert.equal(updateInput.isVectorized, true);
assert.equal(updateInput.attributiveLabel, "CUSTOMER");
const notVectorized = extractSchemaUpdateInput({
  spaceId: "space_a",
  query: nodeQuery([prop("NAME", { is_label: true, is_required: true })], {
    node_source: "existing"
  })
});
assert.equal(notVectorized.isVectorized, false, "absent reads as off, never undefined");

console.log("schema-vectorized-editor: ok");
