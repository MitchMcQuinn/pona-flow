/**
 * Create-STEP "Save as sequence" publishes the designed STEP; it does not mint a
 * catalog kind=operation wrap whose job is to factory more STEPs.
 *
 * INSTANCE/SCHEMA/read/update/delete still go through saveQueryOperation.
 *
 * Run (from App/ui, where tsx is installed):
 *   npx tsx ../../tests/publish-step-as-sequence.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import composer from "./helpers/composer.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const operationsSrc = readFileSync(join(root, "App/authoring/src/operations.ts"), "utf8");
const sequencesSrc = readFileSync(join(root, "App/authoring/src/sequences.ts"), "utf8");
const builderSrc = readFileSync(
  join(root, "App/ui/src/components/builder/BuilderPanel.tsx"),
  "utf8"
);
const mcpSrc = readFileSync(join(root, "App/mcp/src/tools/operations.ts"), "utf8");

const publishStart = operationsSrc.indexOf("export async function publishCreatedStepAsSequence");
const publishEnd = operationsSrc.indexOf("export async function withMintedIdParams");
assert.ok(publishStart >= 0 && publishEnd > publishStart, "publishCreatedStepAsSequence is present");
const publishFn = operationsSrc.slice(publishStart, publishEnd);

assert.match(publishFn, /isStepCreateQuery\(ctx\.query\)/, "publish is gated on create STEP");
assert.match(
  publishFn,
  /isSingleNewStepCreate\(ctx\.query\)/,
  "publish requires a single STEP minted via + ADD NEW NODE (no hops)"
);
assert.match(publishFn, /await runCreate\(ctx\)/, "publish materializes the designed STEP");
assert.match(
  publishFn,
  /autoWrapInSequence\([\s\S]*stepLabel/,
  "the one-step sequence MATCHES the designed STEP label"
);
assert.doesNotMatch(publishFn, /saveQueryOperation/, "publish must not save a catalog factory");
assert.doesNotMatch(publishFn, /autoWrapInStep/, "publish must not mint a second wrap STEP");

const saveStart = operationsSrc.indexOf("export async function saveQueryOperation");
assert.ok(saveStart >= 0 && saveStart < publishStart, "saveQueryOperation remains for query-backed saves");
assert.match(
  operationsSrc.slice(saveStart, publishStart),
  /autoWrapInStep/,
  "query-backed saves still wrap the catalog row in a STEP"
);

const wrapStart = sequencesSrc.indexOf("export async function autoWrapInSequence");
const wrapEnd = sequencesSrc.indexOf("export async function saveSequencePackage");
assert.ok(wrapStart >= 0 && wrapEnd > wrapStart, "autoWrapInSequence is present");
const wrapFn = sequencesSrc.slice(wrapStart, wrapEnd);
assert.match(wrapFn, /entryLabel/, "sequence title and MATCH label can differ");
assert.match(
  wrapFn,
  /composeOneStepSequenceCypher\(\{ name: matchLabel \}\)/,
  "Cypher MATCHES entryLabel, not necessarily the nav title"
);
assert.match(
  wrapFn,
  /oneStepSequenceBuilderConfig\(sequenceId, matchLabel\)/,
  "builder_config MATCHES the designed STEP"
);

const distinctTitle = composer.composeOneStepSequenceCypher({ name: "PING_WEBHOOK" });
assert.match(
  distinctTitle,
  /attributive_label: 'PING_WEBHOOK'/,
  "one-step Cypher matches the STEP label that will run"
);

assert.match(
  builderSrc,
  /isSingleNewStepCreate\(state\.query\)/,
  "the builder only offers Save as sequence for a single new STEP"
);
assert.match(
  builderSrc,
  /publishCreatedStepAsSequence\(state/,
  "the builder create-STEP secondary button publishes"
);

const mcpCreateStart = mcpSrc.indexOf('server.registerTool(\n    "create_operation"');
assert.ok(mcpCreateStart >= 0, "create_operation is registered");
const mcpCreateFn = mcpSrc.slice(mcpCreateStart, mcpSrc.indexOf('server.registerTool(\n    "update_operation"'));
assert.match(mcpCreateFn, /isStepCreateQuery\(query\)/, "MCP create-STEP takes the publish path");
assert.match(
  mcpCreateFn,
  /isSingleNewStepCreate\(query\)/,
  "MCP only publishes a single new STEP as a sequence"
);
assert.match(
  mcpCreateFn,
  /publishCreatedStepAsSequence\(ctx/,
  "MCP create-STEP calls publishCreatedStepAsSequence"
);
assert.match(
  mcpCreateFn,
  /await runCreate\(ctx\)/,
  "MCP materializes a multi-step create STEP without publishing"
);

console.log("publish-step-as-sequence: ok");
