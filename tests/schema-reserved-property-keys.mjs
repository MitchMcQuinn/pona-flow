/**
 * Reserved SCHEMA property names (App/authoring/src/schemaRules.ts).
 *
 * `id` is the implicit UID key; `embedding` / `embedding_stale` are written by the engine's
 * vector-search module and must not be authorable. The same rejection is enforced again in
 * Python (tests/embeddings-reserved-properties.py) because any client can call the API
 * directly, so these two sets have to stay in step.
 *
 * Property keys are normalized to UPPER_SNAKE, so the check is case-insensitive — but a
 * name that merely *starts* with a reserved word (EMBEDDING_DATE) is perfectly legal.
 */

import assert from "node:assert/strict";

import {
  DEFAULT_SCHEMA_KEY_PROPERTY_NAME,
  RESERVED_SCHEMA_PROPERTY_KEYS,
  isImplicitSchemaKeyName,
  isReservedSchemaPropertyKey,
  validateSchemaPropertyKey,
} from "../App/authoring/src/index.ts";

// --- the reserved set ---
assert.deepEqual(
  [...RESERVED_SCHEMA_PROPERTY_KEYS.keys()].sort(),
  ["embedding", "embedding_stale", "id"],
  "reserved keys must match the Python frozenset in Engine/server/graph.py"
);

for (const key of ["id", "ID", "embedding", "EMBEDDING", "embedding_stale", "EMBEDDING_STALE"]) {
  assert.equal(isReservedSchemaPropertyKey(key), true, `${key} should be reserved`);
  const result = validateSchemaPropertyKey(key);
  assert.equal(result.valid, false, `${key} should fail validation`);
  assert.match(result.message, /reserved/, `${key} should say why it is reserved`);
  assert.ok(result.message.includes(key), `${key} message should name the key as typed`);
}

// --- names that merely share a prefix stay legal ---
for (const key of ["EMBEDDING_DATE", "EMBEDDINGS", "IDENTIFIER", "STALE"]) {
  assert.equal(isReservedSchemaPropertyKey(key), false, `${key} should not be reserved`);
  assert.equal(validateSchemaPropertyKey(key).valid, true, `${key} should validate`);
}

// --- prototype keys are not accidentally reserved (Map, not object lookup) ---
for (const key of ["CONSTRUCTOR", "TOSTRING", "HASOWNPROPERTY"]) {
  assert.equal(isReservedSchemaPropertyKey(key), false, `${key} must not be reserved`);
}

// --- only the implicit key is blocked from live input in PropertyBinding ---
assert.equal(isImplicitSchemaKeyName("id"), true);
assert.equal(isImplicitSchemaKeyName("ID"), true);
assert.equal(isImplicitSchemaKeyName(DEFAULT_SCHEMA_KEY_PROPERTY_NAME), true);
assert.equal(
  isImplicitSchemaKeyName("EMBEDDING"),
  false,
  "embedding must fail validation rather than being untypeable"
);

// --- $param keys still bypass the name rules ---
assert.equal(validateSchemaPropertyKey("$prop").valid, true);

console.log("schema-reserved-property-keys: ok");
