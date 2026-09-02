/**
 * Regression: read/update/delete Cypher must keep MATCH + WHERE + UNWIND + RETURN + ORDER BY
 * in one executable statement so Neo4j returns graph entities for the visualizer.
 */
import assert from "node:assert/strict";
import { cypherStatementsForExecution } from "../App/authoring/src/packages.ts";

const readCypher = [
  "MATCH (n1:STEP {attributive_label: $al})",
  "WHERE n1.id = $id",
  "RETURN *",
  "ORDER BY n1.id",
  "SKIP 0",
  "LIMIT 10"
].join("\n");

const grouped = cypherStatementsForExecution(readCypher);
assert.equal(grouped.length, 1, "read query should be one statement");
assert.match(grouped[0], /^MATCH /);
assert.match(grouped[0], / WHERE /);
assert.match(grouped[0], / RETURN \* /);
assert.match(grouped[0], / ORDER BY /);
assert.match(grouped[0], / LIMIT /);

const createCypher = [
  "MATCH (n1:STEP {id: $id})",
  "MERGE (n1)",
  "RETURN *"
].join("\n");

const createGrouped = cypherStatementsForExecution(createCypher);
assert.equal(createGrouped.length, 1);
assert.match(createGrouped[0], /MERGE/);
assert.match(createGrouped[0], /RETURN \*/);

// Optional hop: MATCH + base WHERE + OPTIONAL MATCH lines + RETURN stay one statement.
const optionalHopCypher = [
  "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })",
  "WHERE (GROUP.status = 'active')",
  "OPTIONAL MATCH (GROUP)-[r0:POINTS_TO]->(TASK:INSTANCE { attributive_label: 'TASK' })",
  "OPTIONAL MATCH (TASK)-[r1:POINTS_TO]->(SUB:INSTANCE { attributive_label: 'SUB' })",
  "RETURN *"
].join("\n");

const optionalGrouped = cypherStatementsForExecution(optionalHopCypher);
assert.equal(optionalGrouped.length, 1, "optional-hop read must stay one statement");
assert.match(optionalGrouped[0], /^MATCH .* WHERE .* OPTIONAL MATCH .* OPTIONAL MATCH .* RETURN \*$/);

const unwindCypher = [
  "MATCH (n16:INSTANCE { attributive_label: 'ENTITY_SCHEMA' })-[r20:POINTS_TO]->(n19:INSTANCE { attributive_label: 'ENTITY_SCHEMA' })-[r24:POINTS_TO]->(n23:INSTANCE { attributive_label: 'ENTITY_SCHEMA' })",
  "WHERE (n19.id = $predicate)",
  "UNWIND [n16.id, n23.id] AS associatedEntities",
  "RETURN associatedEntities"
].join("\n");

const unwindGrouped = cypherStatementsForExecution(unwindCypher);
assert.equal(unwindGrouped.length, 1, "UNWIND must stay on the MATCH statement");
assert.match(unwindGrouped[0], / WHERE /);
assert.match(unwindGrouped[0], / UNWIND \[n16\.id, n23\.id\] AS associatedEntities /);
assert.match(unwindGrouped[0], / RETURN associatedEntities$/);

console.log("cypher-read-grouping: ok");
