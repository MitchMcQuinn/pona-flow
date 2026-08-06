/**
 * INSTANCE create: MATCH existing targets by graph id, not only attributive_label.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const productId = "ID_product_abc123";
const personId = "ID_person_new456";

const query = {
  operation: "create",
  allow_duplicates: false,
  match: [
    {
      label: "INSTANCE",
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: personId,
                attributive_label: "PERSON",
                node_source: "new",
                properties: [
                  {
                    key: "name",
                    value: "Charlie",
                    schematic_properties: {
                      value_type: "string",
                      is_required: true,
                      is_key: false,
                      is_label: true,
                      is_indexed: false
                    }
                  },
                  {
                    key: "id",
                    value: personId,
                    schematic_properties: {
                      value_type: "UID",
                      is_required: true,
                      is_key: true,
                      is_label: false,
                      is_indexed: false
                    }
                  }
                ]
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "ID_rel1",
                attributive_label: "BOUGHT",
                node_source: "new",
                id_binding: { key: "id", value: "ID_rel1" },
                properties: []
              }
            },
            {
              kind: "node",
              node: {
                variable: productId,
                attributive_label: "PRODUCT",
                node_source: "existing",
                id_binding: { key: "id", value: productId },
                properties: []
              }
            }
          ]
        }
      ]
    }
  ],
  parameters: []
};

const { cypher } = composer.composeQuery(query);
assert.match(
  cypher,
  new RegExp(`MATCH \\(${productId}:INSTANCE \\{ id: '${productId}' \\}\\)`),
  "existing INSTANCE must MATCH on graph id"
);
assert.doesNotMatch(
  cypher,
  /MATCH \(ID_product[^)]+\) MERGE[\s\S]*MATCH \(ID_product/,
  "should not MATCH product by label only without id"
);

console.log("instance-create-existing-match: ok");
