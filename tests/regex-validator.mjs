/**
 * Regex validator: pattern catalog lookup and value validation.
 */
import assert from "node:assert/strict";
import regexValidator from "../App/regex-validator/src/index.ts";

regexValidator.setPatterns([
  { name: "any", regex: "" },
  { name: "email", regex: "^[^@]+@[^@]+$" },
]);

assert.deepEqual(regexValidator.validate("any", "anything"), { valid: true, skipped: true });
assert.deepEqual(regexValidator.validate("email", ""), { valid: true, skipped: true });
assert.deepEqual(regexValidator.validate("email", "a@b.c"), { valid: true });
assert.deepEqual(regexValidator.validate("email", "not-an-email"), { valid: false });
assert.deepEqual(regexValidator.validate("missing", "x"), { valid: true, skipped: true });
assert.equal(regexValidator.getPattern("email"), "^[^@]+@[^@]+$");

console.log("regex-validator: ok");
