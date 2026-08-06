/**
 * attributive_label $param: discovered as an "attributive label" parameter (locked,
 * required) and composed as a Cypher parameter rather than a quoted literal.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const {
  collectReferencedParameterNames,
  syncParametersFromReferences,
  collectLockedParameterNames,
  ATTRIBUTIVE_LABEL_VALUE_TYPE
} = await import("../App/ui/src/state/builder/parameterRefs.ts");

const query = {
  id: "q-attr-label-param",
  operation: "read",
  match: [
    {
      label: "SCHEMA",
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "n",
                attributive_label: "$companyType",
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

assert.deepEqual(collectReferencedParameterNames(query), ["companyType"]);

const synced = syncParametersFromReferences(query);
assert.equal(synced.parameters.length, 1);
const param = synced.parameters[0];
assert.equal(param.name, "companyType");
assert.equal(param.schematic_properties.value_type, ATTRIBUTIVE_LABEL_VALUE_TYPE);
assert.equal(param.is_required, true);
assert.equal(param.schematic_properties.format, undefined);

assert.ok(collectLockedParameterNames(query).has("companyType"));

// Composer emits attributive_label as a Cypher parameter, not a quoted literal.
const result = composer.composeQuery(synced);
assert.match(result.cypher, /attributive_label: \$companyType/);
assert.doesNotMatch(result.cypher, /attributive_label: '\$companyType'/);

console.log("attributive-label-params: ok");
