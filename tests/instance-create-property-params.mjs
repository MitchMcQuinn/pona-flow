/**
 * INSTANCE create: typing an exact $name into a SCHEMA-adopted property's value is
 * auto-recognized as a run-time parameter that inherits and conforms to that property's
 * configuration (value_type / format / is_required / choice options).
 */
import assert from "node:assert/strict";

const { collectReferencedParameterNames, syncParametersFromReferences } = await import(
  "../App/authoring/src/parameterRefs.ts"
);

const baseQuery = {
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
                attributive_label: "EMPLOYEE",
                node_source: "new",
                // Parameters are entered by typing an exact $name into the value field —
                // the same convention as the other builder flows (no separate binding UI).
                properties: [
                  {
                    key: "employee_id",
                    value: "E-1",
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
                  },
                  {
                    key: "department",
                    value: "$employeeDept",
                    schematic_properties: {
                      value_type: "radio",
                      is_required: false,
                      is_key: false,
                      is_label: false,
                      is_indexed: false,
                      options: ["sales", "eng", "ops"]
                    }
                  },
                  {
                    key: "title",
                    value: "$employeeTitle",
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
assert.deepEqual(refs, ["employeeDept", "employeeEmail", "employeeTitle"]);

const synced = syncParametersFromReferences(baseQuery);
const byName = Object.fromEntries(synced.parameters.map((p) => [p.name, p]));

// String + format + required inherited from the SCHEMA property.
assert.equal(byName.employeeEmail.schematic_properties.value_type, "string");
assert.equal(byName.employeeEmail.schematic_properties.format, "email");
assert.equal(byName.employeeEmail.is_required, true);
assert.equal(byName.employeeEmail.schematic_properties.is_required, true);

// radio: value_type + options inherited; not required.
assert.equal(byName.employeeDept.schematic_properties.value_type, "radio");
assert.deepEqual(byName.employeeDept.schematic_properties.options, ["sales", "eng", "ops"]);
assert.equal(byName.employeeDept.is_required, false);
// radio maps to a string data_type for legacy serialization.
assert.equal(byName.employeeDept.data_type, "string");

// Exact $name in the value field inherits the same way.
assert.equal(byName.employeeTitle.schematic_properties.value_type, "string");
assert.equal(byName.employeeTitle.is_required, true);

console.log("instance-create-property-params: ok");
