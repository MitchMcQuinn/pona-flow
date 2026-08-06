/**
 * composeStepWrapEntitySql: auto-wraps a saved operation in a STEP entity row.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const sql = composer.composeStepWrapEntitySql({
  entityId: "ID_step_entity",
  operationId: "query-abc-1",
  name: "My Operation"
});

assert.ok(sql, "should produce step-wrap SQL");
assert.equal(sql.length, 2, "returns UPDATE then guarded INSERT");
assert.match(sql[0], /UPDATE entities SET common_label/, "updates existing wrap label on re-save");
assert.match(sql[1], /INSERT INTO entities/, "targets the entities table");
assert.match(sql[1], /'STEP'/, "node_label is STEP");
assert.match(sql[1], /'ID_step_entity'/, "uses the generated entity id");
assert.match(sql[1], /'My Operation'/, "common_label is the operation name");
assert.match(sql[1], /'\[\]'/, "parameters default to empty JSON array");
assert.match(
  sql[1],
  /"query_id":"query-abc-1"/,
  "payload references the wrapped operation via query_id"
);
assert.match(
  sql[1],
  /WHERE NOT EXISTS/i,
  "insert is guarded so re-saving never duplicates the wrapping STEP entity row"
);
assert.match(
  sql[1],
  /json_extract\(payload, '\$\.query_id'\) = 'query-abc-1'/,
  "dedupe guard keys off the wrapped operation id"
);

assert.equal(
  composer.composeStepWrapEntitySql({ entityId: "", operationId: "query-abc-1", name: "X" }),
  null,
  "missing entity id yields no SQL"
);
assert.equal(
  composer.composeStepWrapEntitySql({ entityId: "ID_x", operationId: "", name: "X" }),
  null,
  "missing operation id yields no SQL"
);

const escaped = composer.composeStepWrapEntitySql({
  entityId: "ID_x",
  operationId: "query-1",
  name: "O'Brien's op"
});
assert.match(escaped[1], /'O''Brien''s op'/, "single quotes in the name are escaped");

const cypher = composer.composeStepWrapGraphCypher({
  entityId: "ID_step_entity",
  operationId: "query-abc-1",
  name: "My Operation"
});
assert.ok(cypher, "should produce step-wrap graph Cypher");
assert.equal(cypher.length, 2, "returns stale purge then MERGE");
assert.match(cypher[0], /MATCH \(stale:STEP \{ attributive_label: 'My Operation' \}/, "purges stale nodes by label");
assert.match(cypher[0], /WHERE stale\.id <> 'ID_step_entity' DETACH DELETE stale/, "keeps the canonical id");
assert.match(cypher[1], /^MERGE \(step:STEP \{ id: 'ID_step_entity' \}/, "MERGEs by stable graph id");
assert.match(cypher[1], /SET step\.attributive_label = 'My Operation'/, "sets attributive_label on the canonical node");
assert.match(cypher[1], /RETURN \*$/, "returns the merged node");

assert.equal(
  composer.composeStepWrapGraphCypher({ entityId: "", operationId: "query-1", name: "X" }),
  null,
  "missing entity id yields no Cypher"
);

const cypherEscaped = composer.composeStepWrapGraphCypher({
  entityId: "ID_x",
  operationId: "query-1",
  name: "O'Brien's op"
});
assert.match(cypherEscaped[1], /SET step\.attributive_label = 'O\\'Brien\\'s op'/, "Cypher escapes single quotes");

// composeOneStepSequenceCypher: read package that wraps the lone STEP node in a sequence.
const seqCypher = composer.composeOneStepSequenceCypher({ name: "My Operation" });
assert.ok(seqCypher, "should produce one-step sequence Cypher");
assert.match(seqCypher, /^MATCH \(step:STEP \{/, "MATCHes a STEP node");
assert.match(
  seqCypher,
  /attributive_label: 'My Operation'/,
  "matches the wrapping STEP node by attributive_label"
);
assert.match(seqCypher, /RETURN \*$/, "returns the matched node");

assert.equal(
  composer.composeOneStepSequenceCypher({ name: "" }),
  null,
  "missing name yields no sequence Cypher"
);

const seqEscaped = composer.composeOneStepSequenceCypher({ name: "O'Brien's op" });
assert.match(
  seqEscaped,
  /attributive_label: 'O\\'Brien\\'s op'/,
  "sequence Cypher escapes single quotes"
);

console.log("step-wrap-operation: ok");
