import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const query = {
  id: "q-param-serialization",
  name: "Param serialization",
  operation: "read",
  match: [
    {
      label: "INSTANCE",
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "n",
                attributive_label: "COMPANY",
                properties: [],
              },
            },
          ],
        },
      ],
    },
  ],
  parameters: [
    {
      name: "companyName",
      data_type: "string",
      value: "Acme",
      is_required: true,
      description: "  Legal name of the company  ",
      schematic_properties: {
        value_type: "string",
        format: "any",
        is_required: true,
        is_key: false,
        is_label: false,
        is_indexed: false,
      },
    },
    {
      name: "limit",
      data_type: "integer",
      value: 10,
      is_required: false,
      schematic_properties: {
        value_type: "integer",
        is_required: false,
        is_key: false,
        is_label: false,
        is_indexed: false,
      },
    },
  ],
};

const rows = composer.queryParametersForQueriesCatalog(query);
assert.deepEqual(rows[0], {
  name: "companyName",
  value_type: "string",
  format: "any",
  value: "Acme",
  is_required: true,
  description: "Legal name of the company",
});
assert.deepEqual(rows[1], {
  name: "limit",
  value_type: "integer",
  value: 10,
  is_required: false,
});
// An empty/whitespace-only description is omitted entirely (no noisy empty key).
assert.ok(!("description" in rows[1]), "blank description must be omitted");

console.log("composer-parameter-serialization: ok");
