/**
 * SCHEMA property name inputs enforce lowercase snake_case ($param is preserved).
 */
import assert from "node:assert/strict";

const {
  normalizeSchemaPropertyKey,
  sanitizeSchemaPropertyKeyInput
} = await import("../App/authoring/src/normalizeField.ts");
const { validateSchemaPropertyKey } = await import("../App/authoring/src/schemaRules.ts");

assert.equal(normalizeSchemaPropertyKey("first name"), "first_name");
assert.equal(normalizeSchemaPropertyKey("STATUS"), "status");
assert.equal(normalizeSchemaPropertyKey("$dynamicName"), "$dynamicName");

assert.equal(sanitizeSchemaPropertyKeyInput("NA"), "na");
assert.equal(sanitizeSchemaPropertyKeyInput("$dyn"), "$dyn");

const valid = validateSchemaPropertyKey("status");
assert.equal(valid.valid, true);

const invalid = validateSchemaPropertyKey("STATUS");
assert.equal(invalid.valid, false);
assert.match(invalid.message, /lowercase/);

const param = validateSchemaPropertyKey("$fieldName");
assert.equal(param.valid, true);

const reserved = validateSchemaPropertyKey("id");
assert.equal(reserved.valid, false);

console.log("schema-property-key-normalize: ok");
