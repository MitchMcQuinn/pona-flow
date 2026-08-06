/**
 * Optional hop (per-relationship OPTIONAL MATCH) for read SCHEMA/INSTANCE:
 * - the path splits at the first optional relationship; the tail renders as
 *   OPTIONAL MATCH segments anchored on the preceding node's bare variable
 * - each hop gets its own OPTIONAL MATCH line so levels match independently
 * - filters on optional-segment entities ride inline on their OPTIONAL MATCH
 *   line (a null hop must not fail the global WHERE)
 * - READ STEP and non-read operations ignore the flag entirely
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

function node(variable, attributiveLabel, extra = {}) {
  return {
    kind: "node",
    node: { variable, attributive_label: attributiveLabel, properties: [], ...extra }
  };
}

function rel(variable, attributiveLabel, extra = {}) {
  return {
    kind: "relationship",
    relationship: { variable, attributive_label: attributiveLabel, properties: [], ...extra }
  };
}

function readQuery(label, path, extra = {}) {
  return {
    id: "q-optional-hop",
    name: "Optional hop",
    operation: "read",
    match: [{ label, patterns: [{ path }] }],
    parameters: [],
    ...extra
  };
}

// ---- 1. Single optional hop: base MATCH + one OPTIONAL MATCH, bare-variable anchor ----

const singleHop = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { optional: true }),
  node("TASK", "TASK")
]);

assert.equal(
  composer.composeQuery(singleHop).cypher,
  [
    "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })",
    "OPTIONAL MATCH (GROUP)-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' })",
    "RETURN *"
  ].join("\n"),
  "single optional hop splits into MATCH + OPTIONAL MATCH anchored on the preceding node"
);

// ---- 2. Two consecutive optional hops: one OPTIONAL MATCH line per hop ----

const twoHops = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { optional: true }),
  node("TASK", "TASK"),
  rel("r1", "HAS_SUBTASK", { optional: true }),
  node("SUBTASK", "SUBTASK")
]);

assert.equal(
  composer.composeQuery(twoHops).cypher,
  [
    "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })",
    "OPTIONAL MATCH (GROUP)-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' })",
    "OPTIONAL MATCH (TASK)-[r1:POINTS_TO { attributive_label: 'HAS_SUBTASK' }]->(SUBTASK:INSTANCE { attributive_label: 'SUBTASK' })",
    "RETURN *"
  ].join("\n"),
  "consecutive optional hops each emit their own OPTIONAL MATCH line"
);

// ---- 3. Normalization: a non-optional hop after an optional one is forced optional ----

const forcedTail = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { optional: true }),
  node("TASK", "TASK"),
  rel("r1", "HAS_SUBTASK"), // not flagged, but follows an optional hop
  node("SUBTASK", "SUBTASK")
]);

assert.equal(
  composer.composeQuery(forcedTail).cypher,
  composer.composeQuery(twoHops).cypher,
  "hops after the first optional hop normalize into the optional tail"
);

// ---- 4. WHERE placement: optional-segment filters go inline, base filters stay global ----

const whereQuery = readQuery("INSTANCE", [
  node("GROUP", "GROUP", {
    where: {
      operator: "AND",
      items: [{ property_key: "status", operator: "=", value: "active" }]
    }
  }),
  rel("r0", "HAS_TASK", { optional: true }),
  node("TASK", "TASK", {
    where: {
      operator: "AND",
      items: [{ property_key: "done", operator: "=", value: "false" }]
    }
  })
]);

assert.equal(
  composer.composeQuery(whereQuery).cypher,
  [
    "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })",
    // The global WHERE binds to the base MATCH — after the OPTIONAL MATCH it would
    // only null the hop instead of filtering rows.
    "WHERE (GROUP.status = 'active')",
    "OPTIONAL MATCH (GROUP)-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' }) WHERE (TASK.done = false)",
    "RETURN *"
  ].join("\n"),
  "base filters render between MATCH and OPTIONAL MATCH; optional-segment filters ride inline"
);

// ---- 5. READ SCHEMA supports optional hops too ----

const schemaRead = readQuery("SCHEMA", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { optional: true }),
  node("TASK", "TASK")
]);

assert.match(
  composer.composeQuery(schemaRead).cypher,
  /^MATCH \(GROUP:SCHEMA \{ attributive_label: 'GROUP' \}\)\nOPTIONAL MATCH \(GROUP\)-/,
  "read SCHEMA paths split like read INSTANCE paths"
);

// ---- 6. READ STEP ignores the flag (a sequence has a single entry point) ----

const stepRead = readQuery("STEP", [
  node("A", "A"),
  rel("r0", "NEXT", { optional: true }),
  node("B", "B")
]);

const stepCypher = composer.composeQuery(stepRead).cypher;
assert.ok(
  !stepCypher.includes("OPTIONAL MATCH"),
  "READ STEP never splits into OPTIONAL MATCH segments"
);
assert.match(stepCypher, /^MATCH \(A:STEP .*\)-\[r0:POINTS_TO .*\]->\(B:STEP .*\)\nRETURN \*$/);

// ---- 7. Non-read operations ignore the flag ----

const createQuery = {
  ...readQuery("SCHEMA", [
    node("GROUP", "GROUP", { id_binding: { key: "id", value: "ID_group" } }),
    rel("r0", "HAS_TASK", { optional: true, id_binding: { key: "id", value: "ID_rel" } }),
    node("TASK", "TASK", { id_binding: { key: "id", value: "ID_task" } })
  ]),
  operation: "create"
};

const createCypher = composer.composeQuery(createQuery).cypher;
assert.ok(
  !createCypher.includes("OPTIONAL MATCH"),
  "create operations never emit OPTIONAL MATCH"
);
assert.match(createCypher, /^MERGE /);

// ---- 8. No optional flag: output unchanged (single MATCH line) ----

const plainRead = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK"),
  node("TASK", "TASK")
]);

assert.equal(
  composer.composeQuery(plainRead).cypher,
  "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' })\nRETURN *",
  "paths without optional hops compose exactly as before"
);

console.log("composer-optional-hop: ok");
