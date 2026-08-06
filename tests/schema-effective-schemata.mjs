/**
 * SCHEMA schemata defaults: implicit UID is_key when none declared.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

function payloadSchemata(json) {
  const parsed = JSON.parse(json);
  return (parsed.schemata || []).map((e) => e.property_schema || e);
}

const emptyNodePayload = composer.composeEntitySqlite(
  {
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
                  variable: "n1",
                  attributive_label: "Widget",
                  id_binding: { key: "id", value: "ID_test" },
                  properties: []
                }
              }
            ]
          }
        ]
      }
    ]
  },
  "create"
);

assert.ok(emptyNodePayload.some((s) => s.includes("INSERT INTO entities")));
const insertLine = emptyNodePayload.find((s) => s.includes("INSERT INTO entities"));
const payloadMatch = insertLine.match(/payload.*?'(\{[^']+\})'/);
assert.ok(payloadMatch, "expected payload in INSERT");
const schemata = payloadSchemata(payloadMatch[1].replace(/''/g, "'"));
assert.equal(schemata.length, 1);
assert.equal(schemata[0].name, "id");
assert.equal(schemata[0].value_type, "UID");
assert.ok(schemata[0].is_key);

const withCustomKey = {
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
                variable: "n1",
                attributive_label: "Widget",
                id_binding: { key: "id", value: "ID_test2" },
                properties: [
                  {
                    key: "sku",
                    value: "",
                    schematic_properties: {
                      value_type: "string",
                      format: "any",
                      is_required: true,
                      is_key: true,
                      is_label: false,
                      is_indexed: false
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ],
  parameters: []
};

const customPayload = composer.composeEntitySqlite(withCustomKey, "create");
const customInsert = customPayload.find((s) => s.includes("INSERT INTO entities"));
const customMatch = customInsert.match(/payload.*?'(\{[^']+\})'/);
const customSchemata = payloadSchemata(customMatch[1].replace(/''/g, "'"));
assert.equal(customSchemata.filter((s) => s.is_key).length, 1);
assert.equal(customSchemata.find((s) => s.is_key).name, "id");
assert.ok(customSchemata.some((s) => s.name === "sku" && !s.is_key));

console.log("schema-effective-schemata: ok");
