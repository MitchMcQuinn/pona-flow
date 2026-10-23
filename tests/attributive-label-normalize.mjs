/**
 * Display attributive labels stay lowercase with spaces.
 * Underscore folding is only for comparison / Cypher identifiers.
 */
import assert from "node:assert/strict";

const {
  finalizeAttributiveLabelInput,
  normalizeAttributiveLabel,
  sanitizeAttributiveLabelInput
} = await import("../App/authoring/src/normalizeField.ts");
const { validateAttributiveLabelValue } = await import("../App/authoring/src/schemaRules.ts");
const { sanitizeNodeLabel } = await import(
  "../App/ui/src/components/builder/fields/InlineCreateNameField.tsx"
);

assert.equal(normalizeAttributiveLabel("Customer Record"), "customer_record");
assert.equal(normalizeAttributiveLabel("CUSTOMER_RECORD"), "customer_record");
assert.equal(normalizeAttributiveLabel("customer_record"), "customer_record");
assert.equal(normalizeAttributiveLabel("$stepName"), "$stepName");

assert.equal(sanitizeAttributiveLabelInput("NA"), "na");
assert.equal(sanitizeAttributiveLabelInput("Person"), "person");
assert.equal(sanitizeAttributiveLabelInput("New Node"), "new node");
assert.equal(sanitizeAttributiveLabelInput("new "), "new ");
assert.equal(sanitizeAttributiveLabelInput("$dyn"), "$dyn");

assert.equal(finalizeAttributiveLabelInput("New Node"), "new node");
assert.equal(finalizeAttributiveLabelInput("new  node  "), "new node");

assert.equal(sanitizeNodeLabel("New Node"), "new node");
assert.equal(sanitizeNodeLabel("NEW_NODE"), "new_node");

const valid = validateAttributiveLabelValue("customer_record");
assert.equal(valid.valid, true);

const spaced = validateAttributiveLabelValue("customer record");
assert.equal(spaced.valid, true);

const invalid = validateAttributiveLabelValue("CUSTOMER_RECORD");
assert.equal(invalid.valid, false);
assert.match(invalid.message, /lowercase/);

console.log("attributive-label-normalize: ok");
