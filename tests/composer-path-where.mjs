/**
 * Per-path WHERE filters merge into a single WHERE line with AND between paths.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const query = {
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
                properties: [],
                where: {
                  operator: "AND",
                  items: [
                    {
                      property_key: "status",
                      operator: "=",
                      value: "active"
                    }
                  ]
                }
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "NEXT",
                attributive_label: "NEXT",
                properties: [],
                where: {
                  operator: "OR",
                  items: [
                    {
                      property_key: "rel_al",
                      operator: "=",
                      value: "link"
                    },
                    {
                      property_key: "rel_al",
                      operator: "IS NULL"
                    }
                  ]
                }
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
  /WHERE \(FOO\.status = 'active'\) AND \(NEXT\.rel_al = 'link' OR NEXT\.rel_al IS NULL\)/
);

console.log("composer-path-where: ok");
