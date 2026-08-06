/**
 * OPTIONAL MATCH must not lead a read/update/delete query (Neo4j syntax rule).
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const instanceRead = {
  id: "q-optional-instance",
  name: "Read persons",
  operation: "read",
  match: [
    {
      label: "INSTANCE",
      optional: true,
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "PERSON",
                attributive_label: "PERSON",
                properties: [],
              },
            },
          ],
        },
      ],
    },
  ],
  parameters: [],
};

const soloOptional = composer.composeQuery(instanceRead);
assert.equal(
  soloOptional.cypher,
  "MATCH (PERSON:INSTANCE { attributive_label: 'PERSON' })\nRETURN *",
  "sole optional clause degrades to MATCH"
);
assert.ok(
  !soloOptional.cypher.includes("OPTIONAL MATCH"),
  "must not emit OPTIONAL MATCH without a prior MATCH"
);

const twoClauses = {
  ...instanceRead,
  match: [
    {
      label: "INSTANCE",
      optional: false,
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "A",
                attributive_label: "PERSON",
                properties: [],
              },
            },
          ],
        },
      ],
    },
    {
      label: "SCHEMA",
      optional: true,
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "S",
                attributive_label: "PERSON",
                properties: [],
              },
            },
          ],
        },
      ],
    },
  ],
};

const chainedOptional = composer.composeQuery(twoClauses);
assert.equal(
  chainedOptional.cypher,
  "MATCH (A:INSTANCE { attributive_label: 'PERSON' })\nOPTIONAL MATCH (S:SCHEMA { attributive_label: 'PERSON' })\nRETURN *",
  "second optional clause may use OPTIONAL MATCH after a MATCH"
);

console.log("composer-optional-match: ok");
