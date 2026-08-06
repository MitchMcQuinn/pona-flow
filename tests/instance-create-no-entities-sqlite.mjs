/**
 * INSTANCE create/update: graph Cypher is composed, but nothing is mirrored into the
 * per-space entities table (STEP/SCHEMA payloads only).
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const query = {
  operation: "create",
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
                node_source: "new",
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
                  },
                  {
                    key: "email",
                    value: "$employeeEmail",
                    schematic_properties: {
                      value_type: "string",
                      format: "email",
                      is_required: true,
                      is_key: false,
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
assert.match(cypher, /MERGE \(emp:INSTANCE/);
assert.match(cypher, /email: \$employeeEmail/);

const sqlite = composer.composeEntitySqlite(query, "create");
assert.equal(sqlite.length, 0, "INSTANCE create must not emit entities-table SQL");

console.log("instance-create-no-entities-sqlite: ok");
