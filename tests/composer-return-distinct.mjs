/**
 * Regression: read RETURN with distinct:true must emit RETURN DISTINCT * when empty.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const baseQuery = {
  operation: "read",
  hide_duplicates: false,
  match: [
    {
      label: "STEP",
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "FOO",
                attributive_label: "FOO",
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

const withDistinct = composer.composeQuery({
  ...baseQuery,
  return: { distinct: true, items: [] }
});
assert.match(withDistinct.cypher, /RETURN DISTINCT \*/);

const withoutDistinct = composer.composeQuery({
  ...baseQuery,
  return: { distinct: false, items: [] }
});
assert.match(withoutDistinct.cypher, /RETURN \*/);
assert.doesNotMatch(withoutDistinct.cypher, /RETURN DISTINCT/);

console.log("composer-return-distinct: ok");
