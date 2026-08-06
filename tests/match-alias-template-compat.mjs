import assert from "node:assert/strict";
import {
  filterAliasReferencesForRequiredAttributiveLabel,
  patchForAliasReference,
} from "../App/ui/src/state/builder/matchAlias.ts";

const query = {
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
                variable: "company",
                alias_mode: "define",
                alias_locked: true,
                attributive_label: "COMPANY",
                properties: [],
              },
            },
            {
              kind: "relationship",
              relationship: {
                variable: "produces",
                alias_mode: "define",
                alias_locked: true,
                attributive_label: "PRODUCES",
                type: "POINTS_TO",
                properties: [],
              },
            },
            {
              kind: "node",
              node: {
                variable: "product",
                alias_mode: "define",
                alias_locked: true,
                attributive_label: "PRODUCT",
                properties: [],
              },
            },
          ],
        },
      ],
    },
  ],
};

assert.deepEqual(
  filterAliasReferencesForRequiredAttributiveLabel(
    query,
    "node",
    ["company", "product"],
    "PRODUCT"
  ),
  ["product"]
);
assert.deepEqual(
  filterAliasReferencesForRequiredAttributiveLabel(
    query,
    "relationship",
    ["produces"],
    "PRODUCES"
  ),
  ["produces"]
);
assert.deepEqual(
  filterAliasReferencesForRequiredAttributiveLabel(query, "node", ["company", "product"], ""),
  []
);

assert.equal(
  patchForAliasReference(query, "node", "company")?.attributive_label,
  "COMPANY"
);

console.log("match-alias-template-compat: ok");
