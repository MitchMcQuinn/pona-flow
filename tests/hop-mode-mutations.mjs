/**
 * Hop modes on mutations (DELETE / UPDATE INSTANCE) — the authoring rules that keep
 * the new modes safe, as opposed to the Cypher shape they compose (covered by
 * composer-optional-hop.mjs and composer-absent-hop.mjs):
 *
 * - supportsHopModes gates the builder's hop-mode select to the clauses whose
 *   composed Cypher actually honours the flag
 * - must-not-exist tail variables never reach a DELETE target or SET picker: they
 *   are bound only inside the NOT EXISTS subquery
 * - soleDeleteTargetVariable ignores them too, so an anti-join delete still
 *   auto-fills its one real target
 * - optional-hop bindings are marked nullable and labelled as such
 * - hopModeNotices explains a widened or skipped mutation without blocking Run
 *   (nothing it reports may appear in validateQuery, which gates Run and Save)
 *
 * Run from App/ui: `npx tsx ../../tests/hop-mode-mutations.mjs`
 */
import assert from "node:assert/strict";
import { hopModeNotices, supportsHopModes } from "../App/authoring/src/matchMode.ts";
import {
  bindingDisplayLabels,
  collectDeleteTargetBindings,
  collectReadMatchPathBindings,
  soleDeleteTargetVariable
} from "../App/authoring/src/returnProjections.ts";
import { validateQuery } from "../App/authoring/src/validation.ts";

function node(variable, attributiveLabel) {
  return {
    kind: "node",
    node: { variable, attributive_label: attributiveLabel, properties: [] }
  };
}

function rel(variable, attributiveLabel, extra = {}) {
  return {
    kind: "relationship",
    relationship: { variable, attributive_label: attributiveLabel, properties: [], ...extra }
  };
}

function query(operation, label, path, extra = {}) {
  return {
    id: "q-hop-modes",
    name: "Hop modes",
    operation,
    match: [{ label, patterns: [{ path }] }],
    parameters: [],
    ...extra
  };
}

// ---- 1. Gate: which clause/operation pairs offer the hop-mode select ----

assert.ok(supportsHopModes("read", "INSTANCE"), "read INSTANCE offers hop modes");
assert.ok(supportsHopModes("read", "SCHEMA"), "read SCHEMA offers hop modes");
assert.ok(supportsHopModes("delete", "INSTANCE"), "delete INSTANCE offers hop modes");
assert.ok(supportsHopModes("update", "INSTANCE"), "update INSTANCE offers hop modes");

assert.ok(!supportsHopModes("read", "STEP"), "read STEP needs one concrete entry point");
assert.ok(!supportsHopModes("delete", "STEP"), "delete STEP runs the cascade endpoint");
assert.ok(!supportsHopModes("delete", "SCHEMA"), "delete SCHEMA runs the cascade endpoint");
assert.ok(!supportsHopModes("update", "SCHEMA"), "update SCHEMA edits the entities payload");
assert.ok(!supportsHopModes("create", "INSTANCE"), "create writes patterns, never splits them");
assert.ok(!supportsHopModes("delete", undefined), "an unset clause label offers nothing");

// ---- 2. Absent tails are excluded from DELETE target bindings ----

const deleteChildless = query(
  "delete",
  "INSTANCE",
  [node("GROUP", "GROUP"), rel("r0", "HAS_TASK", { absent: true }), node("TASK", "TASK")],
  { delete: { detach: true, targets: [] } }
);

assert.deepEqual(
  collectDeleteTargetBindings(deleteChildless).map((b) => b.variable),
  ["GROUP"],
  "must-not-exist tail entities are not offered as DELETE targets"
);

// With the tail excluded the anchor is the only binding, so auto-fill still applies.
assert.equal(
  soleDeleteTargetVariable(deleteChildless),
  "GROUP",
  "an anti-join delete auto-fills its one bound target"
);

// The same path with a required hop keeps every entity selectable and stays ambiguous.
const deleteRequired = query(
  "delete",
  "INSTANCE",
  [node("GROUP", "GROUP"), rel("r0", "HAS_TASK"), node("TASK", "TASK")],
  { delete: { detach: true, targets: [] } }
);

assert.deepEqual(
  collectDeleteTargetBindings(deleteRequired).map((b) => b.variable),
  ["GROUP", "r0", "TASK"],
  "a required hop leaves every path entity selectable"
);
assert.equal(soleDeleteTargetVariable(deleteRequired), null, "multi-entity match stays manual");

// ---- 3. Optional tails stay selectable but are flagged nullable ----

const deleteOptional = query(
  "delete",
  "INSTANCE",
  [node("GROUP", "GROUP"), rel("r0", "HAS_TASK", { optional: true }), node("TASK", "TASK")],
  { delete: { detach: true, targets: ["GROUP"] } }
);

const optionalBindings = collectDeleteTargetBindings(deleteOptional);
assert.deepEqual(
  optionalBindings.map((b) => b.variable),
  ["GROUP", "r0", "TASK"],
  "optional tails remain valid targets — DELETE against a null binding is a no-op"
);
assert.equal(
  optionalBindings.find((b) => b.variable === "GROUP").nullable,
  undefined,
  "the anchor is always bound"
);
assert.equal(
  optionalBindings.find((b) => b.variable === "TASK").nullable,
  true,
  "optional-tail entities are marked nullable"
);
assert.equal(
  bindingDisplayLabels(optionalBindings).get("TASK"),
  "TASK (optional)",
  "pickers label nullable bindings"
);

// ---- 4. SET bindings carry the same flags for update INSTANCE ----

const updateAbsent = query(
  "update",
  "INSTANCE",
  [node("GROUP", "GROUP"), rel("r0", "HAS_TASK", { absent: true }), node("TASK", "TASK")],
  { set: [{ expression: "GROUP.empty = true", path_variable: "GROUP" }] }
);

const setBindings = collectReadMatchPathBindings(updateAbsent);
assert.equal(
  setBindings.find((b) => b.variable === "TASK").unbound,
  true,
  "must-not-exist tail entities are flagged unbound so SET pickers can drop them"
);
assert.equal(
  setBindings.find((b) => b.variable === "GROUP").unbound,
  undefined,
  "the anchor stays bound"
);

// ---- 5. Notices: widened mutations, non-blocking ----

const widened = hopModeNotices(deleteOptional);
assert.equal(widened.length, 1, "one notice for the widened anchor");
assert.match(
  widened[0],
  /"GROUP" is matched before the optional hop "HAS_TASK", so this DELETE also deletes rows without that hop/,
  "the notice names the target, the hop, and what it widens"
);
assert.deepEqual(
  validateQuery(deleteOptional, false),
  [],
  "an optional hop composes valid Cypher, so it must never block Run or Save"
);

// ---- 6. Notices: mutations skipped on rows where the hop misses ----

const skipped = hopModeNotices({
  ...deleteOptional,
  delete: { detach: true, targets: ["TASK"] }
});
assert.equal(skipped.length, 1, "one notice for the nullable target");
assert.match(
  skipped[0],
  /"TASK" comes from the optional hop "HAS_TASK" and is null wherever the hop does not match, so this DELETE deletes nothing on those rows/,
  "the notice explains the no-op rows"
);

const skippedUpdate = hopModeNotices(
  query(
    "update",
    "INSTANCE",
    [node("GROUP", "GROUP"), rel("r0", "HAS_TASK", { optional: true }), node("TASK", "TASK")],
    { set: [{ expression: "TASK.done = true", path_variable: "TASK" }] }
  )
);
assert.equal(skippedUpdate.length, 1, "SET targets are read from path_variable");
assert.match(skippedUpdate[0], /this UPDATE writes nothing on those rows/, "verbs track the op");

// ---- 7. Notices stay silent where they would be noise ----

assert.deepEqual(hopModeNotices(deleteRequired), [], "required hops need no notice");
assert.deepEqual(hopModeNotices(deleteChildless), [], "absent hops narrow, so no widening note");
assert.deepEqual(
  hopModeNotices(
    query("read", "INSTANCE", [
      node("GROUP", "GROUP"),
      rel("r0", "HAS_TASK", { optional: true }),
      node("TASK", "TASK")
    ])
  ),
  [],
  "reads write nothing, so there is no blast radius to report"
);
assert.deepEqual(
  hopModeNotices({ ...deleteOptional, delete: { detach: true, targets: [] } }),
  [],
  "a target-less delete has nothing to report yet"
);

console.log("hop-mode-mutations: ok");
