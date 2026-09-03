/**
 * Operation name and its paired one-step sequence title are one workspace name.
 *
 * Uniqueness must not treat that shared title as already taken. Pairing is by the
 * sequence MATCH (wrap attributive_label), not by whether the two titles currently
 * equal each other.
 *
 * Run (from App/ui, where tsx is installed):
 *   npx tsx ../../tests/operation-one-step-shared-title.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogNamesTakenForOperationRename,
  isPairedOneStepSequence,
  pairedOneStepSequences
} from "../App/authoring/src/sequenceCypher.ts";
import { withCatalogQueryName } from "../App/authoring/src/builderConfig.ts";
import composer from "./helpers/composer.mjs";

const wrapCypher = composer.composeOneStepSequenceCypher({ name: "READ_MESSAGES" });
assert.ok(wrapCypher, "one-step wrap Cypher is composed");

const operation = {
  id: "op-1",
  name: "READ_MESSAGES",
  kind: "operation",
  cypher: ["MATCH (n:PERSON) RETURN *"]
};
const paired = {
  id: "seq-1",
  name: "READ_MESSAGES",
  kind: "sequence",
  cypher: [wrapCypher]
};
const otherOp = {
  id: "op-2",
  name: "READ_NOTEBOOKS",
  kind: "operation",
  cypher: []
};
const otherSeq = {
  id: "seq-2",
  name: "CHAIN_NOTES",
  kind: "sequence",
  cypher: [
    "MATCH (step:STEP { attributive_label: 'READ_MESSAGES' })-[*]->(next:STEP) RETURN *"
  ]
};

assert.equal(
  isPairedOneStepSequence(paired, "READ_MESSAGES"),
  true,
  "one-step MATCH of the wrap is paired"
);
assert.equal(
  isPairedOneStepSequence(otherSeq, "READ_MESSAGES"),
  false,
  "a multi-step that MATCHES the wrap is not paired"
);
assert.deepEqual(
  pairedOneStepSequences([paired, otherSeq], "READ_MESSAGES").map((row) => row.id),
  ["seq-1"],
  "pairing is MATCH identity, not title equality"
);

const taken = catalogNamesTakenForOperationRename({
  rows: [operation, paired, otherOp, otherSeq],
  operationId: "op-1",
  wrapLabel: "READ_MESSAGES",
  originalName: "READ_MESSAGES"
});
assert.equal(
  taken.has("read_messages"),
  false,
  "the shared operation/one-step title is not taken during rename"
);
assert.equal(taken.has("read_notebooks"), true, "other operations still collide");
assert.equal(taken.has("chain_notes"), true, "other sequences still collide");

const takenByOriginalTitle = catalogNamesTakenForOperationRename({
  rows: [
    operation,
    { ...paired, cypher: [] }
  ],
  operationId: "op-1",
  wrapLabel: "",
  originalName: "READ_MESSAGES"
});
assert.equal(
  takenByOriginalTitle.has("read_messages"),
  false,
  "original-title fallback still excludes the paired one-step when MATCH is unavailable"
);

const patched = withCatalogQueryName(
  { version: 1, query: { id: "op-1", name: "READ_MESSAGES", operation: "read" }, runtimeEnabled: true },
  "READ_NOTEBOOKS_TEST"
);
assert.equal(
  patched.query.name,
  "READ_NOTEBOOKS_TEST",
  "operation builder_config.query.name follows the shared title"
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const operationsSrc = readFileSync(join(root, "App/authoring/src/operations.ts"), "utf8");
assert.match(
  operationsSrc,
  /maybeRetargetOperationWrap/,
  "operation update must sync the wrap and paired one-step title"
);

const sequencesSrc = readFileSync(join(root, "App/authoring/src/sequences.ts"), "utf8");
assert.match(
  sequencesSrc,
  /syncOneStepSequenceSharedTitle/,
  "one-step sequence rename must write the wrapped operation title"
);

const wrapSrc = readFileSync(join(root, "App/authoring/src/stepWrapLabel.ts"), "utf8");
assert.match(
  wrapSrc,
  /pairedOneStepSequences\(rows, matchLabel\)/,
  "operation wrap retarget pairs one-step sequences by MATCH, not by title"
);
assert.match(
  wrapSrc,
  /syncPairedOperationTitle/,
  "sequence rename writes the operation catalog name"
);

console.log("operation-one-step-shared-title: ok");
