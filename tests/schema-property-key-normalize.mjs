/**
 * SCHEMA property name inputs enforce UPPER_SNAKE (same rules as attributive_label).
 */
import assert from "node:assert/strict";

const {
  normalizeSchemaPropertyKey,
  sanitizeSchemaPropertyKeyInput
} = await import("../App/ui/src/state/builder/normalizeField.ts");
const { validateSchemaPropertyKey } = await import("../App/ui/src/state/builder/schemaRules.ts");

assert.equal(normalizeSchemaPropertyKey("first name"), "FIRST_NAME");
assert.equal(normalizeSchemaPropertyKey("status"), "STATUS");
assert.equal(normalizeSchemaPropertyKey("$dynamicName"), "$dynamicName");

assert.equal(sanitizeSchemaPropertyKeyInput("na"), "NA");
assert.equal(sanitizeSchemaPropertyKeyInput("$dyn"), "$dyn");

const valid = validateSchemaPropertyKey("STATUS");
assert.equal(valid.valid, true);

const invalid = validateSchemaPropertyKey("status");
assert.equal(invalid.valid, false);
assert.match(invalid.message, /UPPER_SNAKE/);

const param = validateSchemaPropertyKey("$fieldName");
assert.equal(param.valid, true);

const reserved = validateSchemaPropertyKey("id");
assert.equal(reserved.valid, false);

console.log("schema-property-key-normalize: ok");
