/**
 * SCHEMA create: $param references in property name fields are discovered and synced.
 */
import assert from "node:assert/strict";

const { collectReferencedParameterNames, syncParametersFromReferences } = await import(
  "../App/authoring/src/parameterRefs.ts"
);

const baseQuery = {
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
                properties: [
                  {
                    key: "$dynamicName",
                    value: "",
                    schematic_properties: {
                      value_type: "string",
                      format: "any",
                      is_required: true,
                      is_key: false,
                      is_label: false,
                      is_indexed: false
                    }
                  },
                  {
                    key: "status",
                    value: "$defaultStatus",
                    schematic_properties: {
                      value_type: "string",
                      format: "any",
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

const refs = collectReferencedParameterNames(baseQuery);
assert.deepEqual(refs, ["defaultStatus", "dynamicName"]);

const synced = syncParametersFromReferences(baseQuery);
assert.equal(synced.parameters.length, 2);

const byName = Object.fromEntries(synced.parameters.map((p) => [p.name, p]));
// Property KEY param: always string / any / required (does NOT inherit the property).
assert.equal(byName.dynamicName.schematic_properties.value_type, "string");
assert.equal(byName.dynamicName.schematic_properties.format, "any");
assert.equal(byName.dynamicName.is_required, true);
// Property default_value param: inherits the property's metadata.
assert.equal(byName.defaultStatus.schematic_properties.value_type, "string");
assert.equal(byName.defaultStatus.is_required, true);

console.log("schema-property-key-params: ok");
