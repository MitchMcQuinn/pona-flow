/**
 * READ UNWIND: stack several MATCH-scoped expressions into rows under one alias.
 *
 * MATCH node aliases stay unique. The composer emits `UNWIND [a, b] AS alias` before
 * RETURN, and empty RETURN projects the unwind alias so a for_each loop can iterate it.
 *
 * Run from App/ui: `npx tsx ../../tests/composer-unwind.mjs`
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { cypherStatementsForExecution } from "../App/authoring/src/packages.ts";

function twoEntityRead(extra = {}) {
  return {
    id: "q1",
    name: "stack-ids",
    operation: "read",
    parameters: [],
    match: [
      {
        label: "INSTANCE",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: { variable: "subject", attributive_label: "ENTITY", properties: [] }
              },
              {
                kind: "relationship",
                relationship: {
                  variable: "r0",
                  attributive_label: "PREDICATE",
                  type: "POINTS_TO",
                  properties: []
                }
              },
              {
                kind: "node",
                node: { variable: "object", attributive_label: "ENTITY", properties: [] }
              }
            ]
          }
        ]
      }
    ],
    return: { distinct: false, items: [] },
    ...extra
  };
}

const stacked = composer.composeQuery(
  twoEntityRead({
    unwind: {
      alias: "entityId",
      items: [
        { expression: "subject.id", path_variable: "subject", property_key: "id" },
        { expression: "object.id", path_variable: "object", property_key: "id" }
      ]
    }
  })
);
assert.match(stacked.cypher, /UNWIND \[subject\.id, object\.id\] AS entityId/);
assert.match(stacked.cypher, /RETURN entityId/);
assert.ok(
  stacked.cypher.indexOf("UNWIND") < stacked.cypher.indexOf("RETURN"),
  "UNWIND is emitted before RETURN"
);
assert.doesNotMatch(stacked.cypher, /RETURN \*/);
assert.equal(
  cypherStatementsForExecution(stacked.cypher).length,
  1,
  "UNWIND must not be split off the MATCH statement at save/run time"
);

const withExtraReturn = composer.composeQuery(
  twoEntityRead({
    unwind: {
      alias: "entityId",
      items: [{ expression: "subject.id" }, { expression: "object.id" }]
    },
    return: {
      distinct: false,
      items: [{ expression: "true", alias: "hasConnection" }]
    }
  })
);
assert.match(
  withExtraReturn.cypher,
  /UNWIND \[subject\.id, object\.id\] AS entityId\nRETURN entityId, true AS hasConnection/
);

const alreadyProjected = composer.composeQuery(
  twoEntityRead({
    unwind: {
      alias: "entityId",
      items: [{ expression: "subject.id" }, { expression: "object.id" }]
    },
    return: {
      distinct: false,
      items: [{ expression: "entityId" }]
    }
  })
);
assert.match(alreadyProjected.cypher, /RETURN entityId$/);
assert.doesNotMatch(alreadyProjected.cypher, /RETURN entityId, entityId/);

const distinctEmpty = composer.composeQuery(
  twoEntityRead({
    unwind: {
      alias: "entityId",
      items: [{ expression: "subject.id" }, { expression: "object.id" }]
    },
    return: { distinct: true, items: [] }
  })
);
assert.match(distinctEmpty.cypher, /RETURN DISTINCT entityId/);

const incomplete = composer.composeQuery(
  twoEntityRead({
    unwind: {
      alias: "entityId",
      items: [{ expression: "subject.id" }]
    }
  })
);
assert.doesNotMatch(incomplete.cypher, /UNWIND/);
assert.match(incomplete.cypher, /RETURN \*/);

const noAlias = composer.composeQuery(
  twoEntityRead({
    unwind: {
      alias: "",
      items: [{ expression: "subject.id" }, { expression: "object.id" }]
    }
  })
);
assert.doesNotMatch(noAlias.cypher, /UNWIND/);

const updateIgnores = composer.composeQuery({
  ...twoEntityRead({
    unwind: {
      alias: "entityId",
      items: [{ expression: "subject.id" }, { expression: "object.id" }]
    }
  }),
  operation: "update",
  set: [{ expression: "subject.x = 1" }],
  return: undefined
});
assert.doesNotMatch(updateIgnores.cypher, /UNWIND/);

console.log("composer-unwind: ok");
