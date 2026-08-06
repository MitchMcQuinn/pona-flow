/**
 * Golden master: representative query fixtures with exact expected composeQuery output.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const readWithLimit = {
  id: "q1",
  name: "Read",
  operation: "read",
  match: [
    {
      label: "STEP",
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: { variable: "N", attributive_label: "FOO", properties: [] },
            },
          ],
        },
      ],
    },
  ],
  parameters: [{ name: "limit", data_type: "integer", value: 10 }],
  limit: { parameter: "limit" },
};

assert.deepEqual(composer.composeQuery(readWithLimit), {
  cypher: "MATCH (N:STEP { attributive_label: 'FOO' })\nRETURN *\nLIMIT $limit",
  sqlite: [],
  parameters: { limit: 10 },
  operation: "read",
});

const readDistinct = {
  ...readWithLimit,
  limit: undefined,
  parameters: [],
  return: { distinct: true, items: [] },
};

assert.deepEqual(composer.composeQuery(readDistinct), {
  cypher: "MATCH (N:STEP { attributive_label: 'FOO' })\nRETURN DISTINCT *",
  sqlite: [],
  parameters: {},
  operation: "read",
});

const schemaCreate = {
  id: "q2",
  name: "Schema",
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
                variable: "S",
                attributive_label: "PERSON",
                id_binding: { key: "id", value: "ID_person" },
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

const schemaResult = composer.composeQuery(schemaCreate);
assert.equal(schemaResult.operation, "create");
assert.match(schemaResult.cypher, /^MERGE \(S:SCHEMA/);
assert.match(schemaResult.cypher, /RETURN \*$/);
assert.equal(schemaResult.sqlite.length, 1);
assert.match(schemaResult.sqlite[0], /INSERT INTO entities/);

const pathWhere = {
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
                  items: [{ property_key: "status", operator: "=", value: "active" }],
                },
              },
            },
          ],
        },
      ],
    },
  ],
  parameters: [],
};

assert.match(
  composer.composeQuery(pathWhere).cypher,
  /WHERE \(FOO\.status = 'active'\)/
);

const catalogSql = composer.composeQueriesCatalogUpsertSql(
  {
    id: "ID_test",
    name: "Test",
    operation: "create",
    node_label: "STEP",
    cypher: "MERGE (n:STEP) RETURN n",
    sqlite: [],
    parameters: [],
  },
  true
);
assert.ok(catalogSql);
assert.match(catalogSql, /INSERT INTO queries/);

console.log("composer-golden: ok");
