/**
 * Regression: read/update/delete Cypher must keep MATCH + WHERE + RETURN + ORDER BY
 * in one executable statement so Neo4j returns graph entities for the visualizer.
 */
import assert from "node:assert/strict";

const MATCH_TAIL_LINE =
  /^(WHERE|RETURN|WITH|ORDER BY|SKIP|LIMIT|SET|DELETE|DETACH DELETE|OPTIONAL\s+MATCH)\s/i;

const MATCH_LINE = /^(OPTIONAL\s+)?MATCH\s/i;

function splitCypherLines(cypherText) {
  return (cypherText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
}

function groupCypherStatementsForExecution(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (MATCH_LINE.test(lines[i])) {
      const parts = [];
      while (i < lines.length && MATCH_LINE.test(lines[i])) {
        parts.push(lines[i]);
        i += 1;
      }
      if (
        i < lines.length &&
        /^(MERGE|CREATE)\s/i.test(lines[i]) &&
        !/^CREATE\s+INDEX\b/i.test(lines[i])
      ) {
        parts.push(lines[i]);
        i += 1;
        if (i < lines.length && /^RETURN\s/i.test(lines[i])) {
          parts.push(lines[i]);
          i += 1;
        }
      } else {
        while (i < lines.length && MATCH_TAIL_LINE.test(lines[i])) {
          parts.push(lines[i]);
          i += 1;
        }
      }
      out.push(parts.join(" "));
    } else {
      out.push(lines[i]);
      i += 1;
    }
  }
  return out;
}

const readCypher = [
  "MATCH (n1:STEP {attributive_label: $al})",
  "WHERE n1.id = $id",
  "RETURN *",
  "ORDER BY n1.id",
  "SKIP 0",
  "LIMIT 10"
].join("\n");

const grouped = groupCypherStatementsForExecution(splitCypherLines(readCypher));
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

const createGrouped = groupCypherStatementsForExecution(splitCypherLines(createCypher));
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

const optionalGrouped = groupCypherStatementsForExecution(splitCypherLines(optionalHopCypher));
assert.equal(optionalGrouped.length, 1, "optional-hop read must stay one statement");
assert.match(optionalGrouped[0], /^MATCH .* WHERE .* OPTIONAL MATCH .* OPTIONAL MATCH .* RETURN \*$/);

console.log("cypher-read-grouping: ok");
