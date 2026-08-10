/**
 * Absent hop (must-not-exist anti-join) for read SCHEMA/INSTANCE:
 * - the path splits at the first absent relationship; the tail renders as
 *   NOT EXISTS { MATCH (anchor)<tail> } in the global WHERE, anchored on the
 *   preceding node's bare variable
 * - filters on tail entities move inside the subquery's own WHERE
 * - hops after the absent hop normalize into the negated pattern
 * - an earlier optional hop claims the tail first (first flagged hop wins)
 * - READ STEP and non-read operations ignore the flag entirely
 * - RETURN / ORDER BY must not reference variables scoped to the negated tail
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { validateQuery } from "../App/authoring/src/validation.ts";
import {
  hopForcedMode,
  relationshipHopMode,
  setRelationshipHopMode
} from "../App/ui/src/state/builder/queryHelpers.ts";

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
    id: "q-absent-hop",
    name: "Absent hop",
    operation: "read",
    match: [{ label, patterns: [{ path }] }],
    parameters: [],
    ...extra
  };
}

// ---- 1. Single absent hop: base MATCH + WHERE NOT EXISTS { MATCH ... } ----
// The motivating case: all VALUE instances with no connected PILLAR.

const valueWithoutPillar = readQuery("INSTANCE", [
  node("VALUE", "VALUE"),
  rel("r0", "HAS_MANY", { absent: true, direction: "incoming" }),
  node("PILLAR", "PILLAR")
]);

assert.equal(
  composer.composeQuery(valueWithoutPillar).cypher,
  [
    "MATCH (VALUE:INSTANCE { attributive_label: 'VALUE' })",
    "WHERE NOT EXISTS { MATCH (VALUE)<-[r0:POINTS_TO { attributive_label: 'HAS_MANY' }]-(PILLAR:INSTANCE { attributive_label: 'PILLAR' }) }",
    "RETURN *"
  ].join("\n"),
  "absent hop renders as a NOT EXISTS anti-join anchored on the preceding node"
);

// ---- 2. Outgoing absent hop ----

const singleAbsent = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { absent: true }),
  node("TASK", "TASK")
]);

assert.equal(
  composer.composeQuery(singleAbsent).cypher,
  [
    "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })",
    "WHERE NOT EXISTS { MATCH (GROUP)-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' }) }",
    "RETURN *"
  ].join("\n"),
  "outgoing absent hop composes the anti-join with outgoing direction"
);

// ---- 3. Filters on negated-tail entities move inside the subquery WHERE ----

const absentWithInnerFilter = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { absent: true }),
  node("TASK", "TASK", {
    where: {
      operator: "AND",
      items: [{ property_key: "done", operator: "=", value: "false" }]
    }
  })
]);

assert.equal(
  composer.composeQuery(absentWithInnerFilter).cypher,
  [
    "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })",
    "WHERE NOT EXISTS { MATCH (GROUP)-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' }) WHERE (TASK.done = false) }",
    "RETURN *"
  ].join("\n"),
  "tail-entity filters render inside the NOT EXISTS subquery, not the global WHERE"
);

// ---- 4. Base filters join the global WHERE alongside the NOT EXISTS body ----

const absentWithBaseFilter = readQuery("INSTANCE", [
  node("GROUP", "GROUP", {
    where: {
      operator: "AND",
      items: [{ property_key: "status", operator: "=", value: "active" }]
    }
  }),
  rel("r0", "HAS_TASK", { absent: true }),
  node("TASK", "TASK")
]);

assert.equal(
  composer.composeQuery(absentWithBaseFilter).cypher,
  [
    "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })",
    "WHERE (GROUP.status = 'active') AND NOT EXISTS { MATCH (GROUP)-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' }) }",
    "RETURN *"
  ].join("\n"),
  "base-path filters and the anti-join share the global WHERE"
);

// ---- 5. Required hop before the absent hop stays in the base MATCH ----

const requiredThenAbsent = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK"),
  node("TASK", "TASK"),
  rel("r1", "HAS_SUBTASK", { absent: true }),
  node("SUBTASK", "SUBTASK")
]);

assert.equal(
  composer.composeQuery(requiredThenAbsent).cypher,
  [
    "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' })",
    "WHERE NOT EXISTS { MATCH (TASK)-[r1:POINTS_TO { attributive_label: 'HAS_SUBTASK' }]->(SUBTASK:INSTANCE { attributive_label: 'SUBTASK' }) }",
    "RETURN *"
  ].join("\n"),
  "the anti-join anchors on the last named node of the required base path"
);

// ---- 6. Hops after the absent hop normalize into the negated pattern ----

const multiHopTail = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { absent: true }),
  node("TASK", "TASK"),
  rel("r1", "HAS_SUBTASK"), // not flagged, but follows an absent hop
  node("SUBTASK", "SUBTASK")
]);

assert.equal(
  composer.composeQuery(multiHopTail).cypher,
  [
    "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })",
    "WHERE NOT EXISTS { MATCH (GROUP)-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' })-[r1:POINTS_TO { attributive_label: 'HAS_SUBTASK' }]->(SUBTASK:INSTANCE { attributive_label: 'SUBTASK' }) }",
    "RETURN *"
  ].join("\n"),
  "everything after the absent hop lives inside the single NOT EXISTS pattern"
);

// ---- 7. An earlier optional hop claims the tail (first flagged hop wins) ----

const optionalBeforeAbsent = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { optional: true }),
  node("TASK", "TASK"),
  rel("r1", "HAS_SUBTASK", { absent: true }),
  node("SUBTASK", "SUBTASK")
]);

const bothOptional = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { optional: true }),
  node("TASK", "TASK"),
  rel("r1", "HAS_SUBTASK", { optional: true }),
  node("SUBTASK", "SUBTASK")
]);

assert.equal(
  composer.composeQuery(optionalBeforeAbsent).cypher,
  composer.composeQuery(bothOptional).cypher,
  "an absent flag inside an optional tail normalizes into the optional tail"
);

// ---- 8. READ SCHEMA supports absent hops too ----

const schemaRead = readQuery("SCHEMA", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { absent: true }),
  node("TASK", "TASK")
]);

assert.match(
  composer.composeQuery(schemaRead).cypher,
  /^MATCH \(GROUP:SCHEMA \{ attributive_label: 'GROUP' \}\)\nWHERE NOT EXISTS \{ MATCH \(GROUP\)-/,
  "read SCHEMA paths split into anti-joins like read INSTANCE paths"
);

// ---- 9. READ STEP ignores the flag (a sequence has a single entry point) ----

const stepRead = readQuery("STEP", [
  node("A", "A"),
  rel("r0", "NEXT", { absent: true }),
  node("B", "B")
]);

const stepCypher = composer.composeQuery(stepRead).cypher;
assert.ok(
  !stepCypher.includes("NOT EXISTS"),
  "READ STEP never splits into a NOT EXISTS anti-join"
);
assert.match(stepCypher, /^MATCH \(A:STEP .*\)-\[r0:POINTS_TO .*\]->\(B:STEP .*\)\nRETURN \*$/);

// ---- 10. Non-read operations ignore the flag ----

const createQuery = {
  ...readQuery("SCHEMA", [
    node("GROUP", "GROUP", { id_binding: { key: "id", value: "ID_group" } }),
    rel("r0", "HAS_TASK", { absent: true, id_binding: { key: "id", value: "ID_rel" } }),
    node("TASK", "TASK", { id_binding: { key: "id", value: "ID_task" } })
  ]),
  operation: "create"
};

const createCypher = composer.composeQuery(createQuery).cypher;
assert.ok(
  !createCypher.includes("NOT EXISTS"),
  "create operations never emit NOT EXISTS anti-joins"
);
assert.match(createCypher, /^MERGE /);

// ---- 11. No absent flag: output unchanged (single MATCH line) ----

const plainRead = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK"),
  node("TASK", "TASK")
]);

assert.equal(
  composer.composeQuery(plainRead).cypher,
  "MATCH (GROUP:INSTANCE { attributive_label: 'GROUP' })-[r0:POINTS_TO { attributive_label: 'HAS_TASK' }]->(TASK:INSTANCE { attributive_label: 'TASK' })\nRETURN *",
  "paths without absent hops compose exactly as before"
);

// ---- 12. Validation: RETURN / ORDER BY must not reference negated-tail variables ----

const returnsNegatedVariable = {
  ...singleAbsent,
  return: { items: [{ expression: "TASK.title", path_variable: "TASK" }] }
};

assert.ok(
  validateQuery(returnsNegatedVariable, false).some((w) =>
    w.includes('"TASK" is inside a must-not-exist pattern')
  ),
  "RETURN projections referencing negated-tail variables are rejected"
);

const ordersOnNegatedVariable = {
  ...singleAbsent,
  order_by: [{ expression: "TASK.title", direction: "ASC" }]
};

assert.ok(
  validateQuery(ordersOnNegatedVariable, false).some((w) =>
    w.includes('"TASK" is inside a must-not-exist pattern')
  ),
  "ORDER BY items referencing negated-tail variables are rejected"
);

const returnsAnchor = {
  ...singleAbsent,
  return: { items: [{ expression: "GROUP", path_variable: "GROUP" }] }
};

assert.ok(
  !validateQuery(returnsAnchor, false).some((w) => w.includes("must-not-exist")),
  "RETURN projections on base-path variables stay valid"
);

// ---- 13. Builder hop-mode helpers keep the flags mutually exclusive ----

const helperQuery = readQuery("INSTANCE", [
  node("GROUP", "GROUP"),
  rel("r0", "HAS_TASK", { optional: true }),
  node("TASK", "TASK"),
  rel("r1", "HAS_SUBTASK", { optional: true }),
  node("SUBTASK", "SUBTASK")
]);

const afterAbsent = setRelationshipHopMode(0, 0, 1, "absent")(helperQuery);
const absentPath = afterAbsent.match[0].patterns[0].path;
assert.equal(relationshipHopMode(absentPath[1].relationship), "absent");
assert.equal(absentPath[1].relationship.optional, undefined, "absent clears optional on the hop");
assert.equal(
  relationshipHopMode(absentPath[3].relationship),
  "required",
  "downstream hop flags clear — the tail lives inside the single NOT EXISTS pattern"
);
assert.equal(
  hopForcedMode(afterAbsent.match[0].patterns[0], 3),
  "absent",
  "downstream hops report the forced absent mode"
);

const backToOptional = setRelationshipHopMode(0, 0, 1, "optional")(afterAbsent);
const optionalPath = backToOptional.match[0].patterns[0].path;
assert.equal(relationshipHopMode(optionalPath[1].relationship), "optional");
assert.equal(optionalPath[1].relationship.absent, undefined, "optional clears absent on the hop");
assert.equal(
  relationshipHopMode(optionalPath[3].relationship),
  "optional",
  "setting optional forces downstream hops optional"
);

console.log("composer-absent-hop: ok");
