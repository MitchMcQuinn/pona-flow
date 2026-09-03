/**
 * Creating an operation must mint a catalog id, not reuse the builder session id.
 *
 * Reusing `query.id` hits SQLite ON CONFLICT(id) and overwrites the previous
 * operation. autoWrapInStep then UPDATEs the wrap STEP keyed by that same
 * query_id, which retargets attributive_label and orphans the leftover
 * one-step sequence (red nav row).
 *
 * Run (from App/ui, where tsx is installed):
 *   npx tsx ../../tests/operation-create-mints-catalog-id.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import composer from "./helpers/composer.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "App/authoring/src/operations.ts"), "utf8");

const saveStart = src.indexOf("export async function saveQueryOperation");
const saveEnd = src.indexOf("export async function withMintedIdParams");
assert.ok(saveStart >= 0 && saveEnd > saveStart, "saveQueryOperation is present");
const saveFn = src.slice(saveStart, saveEnd);

assert.match(
  saveFn,
  /const operationId = await connector\.generateQueryId\(\)/,
  "create must mint a catalog id instead of reusing the builder session id"
);
assert.match(
  saveFn,
  /query: \{ \.\.\.ctx\.query, id: operationId \}/,
  "the minted id must be the one written to the catalog payload"
);

const updateStart = src.indexOf("export async function updateQueryOperation");
const updateFn = src.slice(updateStart, saveStart);
assert.match(
  updateFn,
  /const operationId = ctx\.query\.id/,
  "edit must keep the existing catalog id"
);

const wrapSql = composer.composeStepWrapEntitySql({
  entityId: "ID_wrap",
  operationId: "query-shared",
  name: "READ_NOTEBOOKS_TEST"
});
assert.ok(wrapSql, "wrap SQL is composed");
assert.match(
  wrapSql[0],
  /json_extract\(payload, '\$\.query_id'\) = 'query-shared'/,
  "wrap UPDATE is keyed by operation id — colliding creates steal the STEP"
);
assert.match(
  wrapSql[0],
  /READ_NOTEBOOKS_TEST/,
  "the stolen wrap is retargeted to the newer operation name"
);

console.log("operation-create-mints-catalog-id: ok");
