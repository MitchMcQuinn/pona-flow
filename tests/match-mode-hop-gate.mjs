/**
 * +hop graph gating: SCHEMA create must not require existing outgoing edges.
 */
import assert from "node:assert/strict";

function isMatchOperation(operation) {
  return operation === "read" || operation === "update" || operation === "delete";
}

function schemaDrivenHopClause(label, operation) {
  return (
    (label === "INSTANCE" || label === "SCHEMA") &&
    (operation === "create" || isMatchOperation(operation))
  );
}

function hopGatedByGraphOutgoing(label, operation) {
  if (label === "SCHEMA" && operation === "create") return false;
  return (
    schemaDrivenHopClause(label, operation) ||
    (label === "STEP" && isMatchOperation(operation))
  );
}

assert.equal(hopGatedByGraphOutgoing("SCHEMA", "create"), false);
assert.equal(hopGatedByGraphOutgoing("STEP", "create"), false);
assert.equal(hopGatedByGraphOutgoing("INSTANCE", "create"), true);
assert.equal(hopGatedByGraphOutgoing("SCHEMA", "read"), true);
assert.equal(hopGatedByGraphOutgoing("STEP", "read"), true);

function isStepCreateQuery(query) {
  return query.operation === "create" && query.match[0]?.label === "STEP";
}

function catalogRuntimeEnabled(query, runtimeEnabled) {
  if (!isStepCreateQuery(query)) return false;
  return runtimeEnabled;
}

assert.equal(catalogRuntimeEnabled({ operation: "create", match: [{ label: "SCHEMA" }] }, true), false);
assert.equal(catalogRuntimeEnabled({ operation: "create", match: [{ label: "INSTANCE" }] }, true), false);
assert.equal(catalogRuntimeEnabled({ operation: "create", match: [{ label: "STEP" }] }, true), true);
assert.equal(catalogRuntimeEnabled({ operation: "create", match: [{ label: "STEP" }] }, false), false);

console.log("match-mode-hop-gate: ok");
