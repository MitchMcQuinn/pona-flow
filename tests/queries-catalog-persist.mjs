/**
 * queries table: only STEP create packages get catalog upsert SQL.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const basePkg = {
  id: "ID_test_query",
  name: "Test",
  operation: "create",
  cypher: "MERGE (n:STEP { id: 'x' }) RETURN n",
  sqlite: [],
  parameters: []
};

assert.ok(
  composer.composeQueriesCatalogUpsertSql({ ...basePkg, node_label: "STEP" }, true),
  "STEP create should produce queries upsert SQL"
);
assert.equal(
  composer.composeQueriesCatalogUpsertSql({ ...basePkg, node_label: "INSTANCE" }, true),
  null,
  "INSTANCE create should not upsert queries table"
);
assert.equal(
  composer.composeQueriesCatalogUpsertSql({ ...basePkg, node_label: "SCHEMA" }, true),
  null,
  "SCHEMA create should not upsert queries table"
);
assert.equal(
  composer.composeQueriesCatalogUpsertSql(
    { ...basePkg, node_label: "STEP", operation: "read" },
    true
  ),
  null,
  "read packages use API save, not composeQueriesCatalogUpsertSql"
);

console.log("queries-catalog-persist: ok");
