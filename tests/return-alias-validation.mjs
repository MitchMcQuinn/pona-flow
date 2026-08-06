/**
 * Return-projection alias normalization and validation (INSTANCE read/update RETURN card).
 * Mirrors App/ui/src/state/builder/normalizeField.ts helpers.
 */
import assert from "node:assert/strict";

function normalizeAlias(value) {
  return String(value ?? "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/^[^A-Za-z]+/, "");
}

const ALIAS_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function validateOptionalAlias(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  if (!ALIAS_NAME_PATTERN.test(trimmed)) return "invalid";
  return null;
}

assert.equal(normalizeAlias("my alias"), "my_alias");
assert.equal(normalizeAlias("123step"), "step");
assert.equal(normalizeAlias("1"), "");
assert.equal(normalizeAlias("_foo"), "foo");
assert.ok(ALIAS_NAME_PATTERN.test("step1"));
assert.ok(!ALIAS_NAME_PATTERN.test("123"));
assert.ok(!ALIAS_NAME_PATTERN.test("bad alias"));

assert.equal(validateOptionalAlias(""), null);
assert.equal(validateOptionalAlias(undefined), null);
assert.equal(validateOptionalAlias("valid_alias1"), null);
assert.ok(validateOptionalAlias("123"));
assert.ok(validateOptionalAlias("has space"));

console.log("return-alias-validation: ok");
