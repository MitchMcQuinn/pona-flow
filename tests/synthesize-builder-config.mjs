/**
 * Cypher-only catalog rows (chat-agent operations and sequences) reopen in the
 * visual builder. The rebuilt snapshot composes back to the stored statement
 * for the builder's dialect, and a statement the builder cannot represent stays
 * closed so a later save cannot overwrite it.
 *
 * Run from App/ui: `npx tsx ../../tests/synthesize-builder-config.mjs`
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import {
  configForVisualEdit,
  synthesizeBuilderConfig,
} from "../App/authoring/src/synthesizeBuilderConfig.ts";

function flat(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function roundTrip(cypher, operation = "read") {
  const config = synthesizeBuilderConfig({
    id: "Q1",
    name: "people",
    operation,
    cypher: [cypher],
  });
  assert.ok(config, `expected a snapshot for ${cypher}`);
  assert.equal(config.query.id, "Q1");
  assert.equal(config.query.name, "people");
  assert.equal(config.query.operation, operation);
  const composed = composer.composeQuery(config.query).cypher;
  assert.equal(flat(composed), flat(cypher), `composed:\n${composed}`);
  return config;
}

const read = roundTrip(
  "MATCH (n:INSTANCE { attributive_label: 'PERSON' })\nWHERE n.status = 'active'\nRETURN n.name AS name"
);
assert.equal(read.query.match[0].label, "INSTANCE");
assert.equal(read.query.match[0].patterns[0].path[0].node.attributive_label, "PERSON");
assert.equal(read.query.return.items[0].alias, "name");

roundTrip(
  "MATCH (a:INSTANCE { attributive_label: 'nurse' })-[r:WORKS_AT]->(b:INSTANCE { attributive_label: 'unit' })\nRETURN a, b"
);

roundTrip("MATCH (step:STEP { attributive_label: 'STEP1' })\nRETURN *");

roundTrip(
  "MATCH (n:INSTANCE { attributive_label: 'PERSON', status: $status })\nRETURN n\nORDER BY n.name ASC\nLIMIT 10",
);
const params = synthesizeBuilderConfig({
  id: "Q1",
  name: "people",
  operation: "read",
  cypher: ["MATCH (n:INSTANCE { attributive_label: 'PERSON', status: $status }) RETURN n"],
  parameters: [{ name: "status", data_type: "string", value: "open", is_required: true }],
});
assert.equal(params.query.parameters[0].value, "open");
assert.equal(params.query.parameters[0].is_required, true);

roundTrip(
  "MATCH (n:INSTANCE { attributive_label: 'PERSON' })\nSET n.status = 'closed'\nRETURN n.status AS status",
  "update"
);

roundTrip(
  "MATCH (n:INSTANCE { attributive_label: 'PERSON' })\nWHERE n.status = 'closed'\nDETACH DELETE n",
  "delete"
);

roundTrip("MERGE (n:INSTANCE { attributive_label: 'PERSON' }) RETURN *", "create");

const agent = synthesizeBuilderConfig({
  id: "ID_op_count",
  name: "count people",
  operation: "read",
  cypher: ["MATCH (p:Person) RETURN count(p) AS text"],
});
assert.ok(agent);
const person = agent.query.match[0].patterns[0].path[0].node;
assert.equal(person.variable, "p");
assert.equal(person.attributive_label, "Person");
assert.equal(person.labels[0], "INSTANCE");
assert.deepEqual(agent.query.return.items[0], { expression: "count(p)", alias: "text" });

const stored = { version: 1, query: { id: "kept", name: "kept", operation: "read", parameters: [], match: [] }, runtimeEnabled: false };
const kept = configForVisualEdit({
  id: "other",
  name: "other",
  cypher: ["MATCH (p:Person) RETURN p"],
  builder_config: stored,
});
assert.equal(kept, stored);

const empty = configForVisualEdit({
  id: "ID_op_count",
  name: "count people",
  operation: "read",
  cypher: ["MATCH (p:Person) RETURN count(p) AS text"],
  builder_config: {},
});
assert.equal(empty.query.match[0].patterns[0].path[0].node.attributive_label, "Person");

assert.equal(
  synthesizeBuilderConfig({
    id: "Q",
    name: "script",
    operation: "read",
    cypher: ["MATCH (n:INSTANCE { attributive_label: 'PERSON' }) WITH n RETURN n"],
  }),
  null
);
assert.equal(
  synthesizeBuilderConfig({
    id: "Q",
    name: "undirected",
    operation: "read",
    cypher: ["MATCH (a:INSTANCE)-[r:POINTS_TO]-(b:INSTANCE) RETURN a"],
  }),
  null
);

const traversal = roundTrip(
  "MATCH path = (:STEP { attributive_label: 'STEP1' })-[*]->(downstream)\nRETURN path"
);
assert.equal(traversal.query.read_traversal, "downstream");

console.log("synthesize builder config ok");
