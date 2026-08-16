/**
 * Vector-search opt-in flags in the composed SCHEMA payload.
 *
 * Two flags, at two levels:
 *   - `is_embedded` is per property (which values make up the embedded text);
 *   - `is_vectorized` is per SCHEMA, written beside `schemata` in the payload — the shape a
 *     relationship's `condition_type` already uses, since it describes the type not a property.
 *
 * Both are written only when on, so a SCHEMA that does not use vector search composes to
 * exactly the payload it always has. That "no drift" property is what these assertions pin.
 */

import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { newSchematicProperties, propertiesFromSchemata } from "../App/authoring/src/index.ts";

function schemaNodeQuery({ properties, isVectorized }) {
  return {
    operation: "create",
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
                  ...(isVectorized === undefined ? {} : { is_vectorized: isVectorized })
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

function payloadOf(statements) {
  const insert = statements.find((s) => s.includes("INSERT INTO entities"));
  assert.ok(insert, "expected an entities INSERT");
  const match = insert.match(/'(\{"schemata".*?\})'/);
  assert.ok(match, `expected a schema payload in: ${insert}`);
  return JSON.parse(match[1]);
}

const nameProp = {
  key: "NAME",
  value: "",
  schematic_properties: { ...newSchematicProperties(), is_label: true }
};
const notesProp = {
  key: "NOTES",
  value: "",
  schematic_properties: { ...newSchematicProperties(), is_embedded: true }
};

// --- nothing opted in: the payload is unchanged from before vector search existed ---
const plain = payloadOf(
  composer.composeEntitySqlite(schemaNodeQuery({ properties: [nameProp] }), "create")
);
assert.equal("is_vectorized" in plain, false, "is_vectorized must not appear when off");
const plainName = plain.schemata.find((e) => e.property_schema.name === "NAME").property_schema;
assert.equal("is_embedded" in plainName, false, "is_embedded must not appear when off");
assert.deepEqual(Object.keys(plain), ["schemata"]);

// --- opted in at both levels ---
const vectorized = payloadOf(
  composer.composeEntitySqlite(
    schemaNodeQuery({ properties: [nameProp, notesProp], isVectorized: true }),
    "create"
  )
);
assert.equal(vectorized.is_vectorized, true);
const byName = Object.fromEntries(
  vectorized.schemata.map((e) => [e.property_schema.name, e.property_schema])
);
assert.equal(byName.NOTES.is_embedded, true);
assert.equal("is_embedded" in byName.NAME, false, "an unmarked property stays unmarked");
assert.equal("is_embedded" in byName.id, false, "the implicit key is never embedded");

// --- explicit false is the same as absent (no drift from a toggle switched back off) ---
const toggledOff = payloadOf(
  composer.composeEntitySqlite(
    schemaNodeQuery({ properties: [nameProp], isVectorized: false }),
    "create"
  )
);
assert.deepEqual(toggledOff, plain);

// --- relationship SCHEMA carries the flag alongside condition_type ---
const relQuery = {
  operation: "create",
  match: [
    {
      label: "SCHEMA",
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "a",
                attributive_label: "CUSTOMER",
                node_source: "existing",
                id_binding: { key: "id", value: "ID_a" },
                properties: []
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "r",
                type: "POINTS_TO",
                attributive_label: "PLACED",
                direction: "outgoing",
                id_binding: { key: "id", value: "ID_rel" },
                properties: [notesProp],
                is_vectorized: true
              }
            },
            {
              kind: "node",
              node: {
                variable: "b",
                attributive_label: "ORDER",
                node_source: "existing",
                id_binding: { key: "id", value: "ID_b" },
                properties: []
              }
            }
          ]
        }
      ]
    }
  ]
};
const relStatements = composer.composeEntitySqlite(relQuery, "create");
const relInsert = relStatements.find((s) => s.includes("ID_rel"));
assert.ok(relInsert, "expected an INSERT for the relationship SCHEMA");
assert.match(relInsert, /"is_vectorized":true/);
assert.match(relInsert, /"is_embedded":true/);

// --- round trip: a stored constraint becomes an editable binding and back again ---
const bindings = propertiesFromSchemata([
  { key: "NAME", value_type: "string", is_required: true, is_key: false, is_label: true, is_indexed: false },
  {
    key: "NOTES",
    value_type: "string",
    is_required: false,
    is_key: false,
    is_label: false,
    is_indexed: false,
    is_embedded: true
  }
]);
const notesBinding = bindings.find((b) => b.key === "NOTES");
assert.equal(notesBinding.schematic_properties.is_embedded, true, "is_embedded survives loading");
const nameBinding = bindings.find((b) => b.key === "NAME");
assert.equal(nameBinding.schematic_properties.is_embedded, false);

console.log("schema-embedding-flags: ok");
