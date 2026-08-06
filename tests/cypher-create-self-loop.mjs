/**
 * Self-loop SCHEMA create: the reference occurrence closing the loop must render
 * bare inside the MERGE pattern, with no MATCH-before-MERGE for the same variable
 * (Neo4j rejects re-binding: "variable already bound ... cannot be modified by MERGE").
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const query = {
  operation: "create",
  allow_duplicates: false,
  match: [
    {
      label: "SCHEMA",
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "n8",
                attributive_label: "PERSON",
                id_binding: { key: "id", value: "ID_person" },
                properties: []
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "r1",
                attributive_label: "KNOWS",
                id_binding: { key: "id", value: "ID_r1" },
                properties: []
              }
            },
            {
              kind: "node",
              node: {
                variable: "n8",
                alias_mode: "reference",
                alias_ref: "n8",
                attributive_label: "PERSON",
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

const { cypher } = composer.composeQuery(query);

assert.doesNotMatch(
  cypher,
  /^MATCH/,
  "self-loop create must not MATCH the node it is about to MERGE"
);
assert.match(
  cypher,
  /^MERGE \(n8:SCHEMA \{ attributive_label: 'PERSON', id: 'ID_person' \}\)-\[r1:[^\]]+\]->\(n8\) RETURN \*$/,
  "loop-closing occurrence must render as a bare (n8) inside the single MERGE"
);

console.log("cypher-create-self-loop: ok");
