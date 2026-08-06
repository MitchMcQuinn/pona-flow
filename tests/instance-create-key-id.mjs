/**
 * INSTANCE create: graph id comes from is_key property value, not id_binding.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

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
                variable: "emp",
                attributive_label: "EMPLOYEE",
                properties: [
                  {
                    key: "employee_id",
                    value: "E-42",
                    schematic_properties: {
                      value_type: "string",
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

const { cypher } = composer.composeQuery(query);
assert.match(cypher, /MERGE \(emp:INSTANCE \{[^}]*id: 'E-42'/);
assert.match(cypher, /employee_id: 'E-42'/);

console.log("instance-create-key-id: ok");
