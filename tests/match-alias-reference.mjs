/**
 * Alias references inherit attributive_label from the defining path entry.
 */
import assert from "node:assert/strict";
import {
  findDefinedAliasAttributiveLabel,
  patchForAliasReference
} from "../App/authoring/src/matchAlias.ts";

const query = {
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
                variable: "PERSON",
                alias_mode: "define",
                alias_locked: true,
                attributive_label: "PERSON",
                properties: []
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "KNOWS",
                alias_mode: "define",
                alias_locked: true,
                attributive_label: "KNOWS",
                type: "POINTS_TO",
                properties: []
              }
            }
          ]
        }
      ]
    }
  ]
};

assert.equal(findDefinedAliasAttributiveLabel(query, "node", "PERSON"), "PERSON");
assert.equal(findDefinedAliasAttributiveLabel(query, "relationship", "KNOWS"), "KNOWS");
assert.equal(findDefinedAliasAttributiveLabel(query, "node", "MISSING"), null);

assert.deepEqual(patchForAliasReference(query, "node", "PERSON"), {
  alias_mode: "reference",
  alias_ref: "PERSON",
  variable: "PERSON",
  alias_locked: true,
  attributive_label: "PERSON",
  properties: []
});

console.log("match-alias-reference: ok");
