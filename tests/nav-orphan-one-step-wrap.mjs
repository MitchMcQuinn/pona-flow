/**
 * Diagnostic: a freshly saved operation is auto-wrapped as
 *   MATCH (step:STEP { attributive_label: 'NAME' }) RETURN *
 * The nav paints that row red when ``orphaned`` is true.
 *
 * Two failure modes this covers:
 *  1. The wrap Cypher is not parsed, so attributiveLabel is empty and
 *     markOrphanedSequences treats "no label" as orphaned.
 *  2. Catalog ``cypher`` arriving as a JSON string (not a string[]) is iterated
 *     character-by-character, so the same regex never matches.
 *
 * Run (from App/ui, where tsx is installed):
 *   npx tsx ../../tests/nav-orphan-one-step-wrap.mjs
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { sequenceStepLabels } from "../App/authoring/src/sequenceCypher.ts";
import { markOrphanedSequences } from "../App/ui/src/services/api.ts";

const wrapCypher = composer.composeOneStepSequenceCypher({ name: "READ_MESSAGES" });
assert.ok(wrapCypher, "one-step wrap Cypher is composed");

const labels = sequenceStepLabels([wrapCypher]);
assert.deepEqual(
  labels,
  ["READ_MESSAGES"],
  `authoring parser must extract the wrap STEP label from ${JSON.stringify(wrapCypher)}`
);

const sequences = [
  {
    id: "seq-1",
    label: "READ_MESSAGES",
    kind: "sequence",
    attributiveLabel: labels[0] || "",
    runtimeEnabled: true,
    suspended: false,
    orphaned: false,
    groupTitle: "TEST GROUP",
    sortOrder: 0,
    description: "",
    singleStep: true
  }
];

const graphHasWrap = new Set(["READ_MESSAGES"]);
const marked = markOrphanedSequences(sequences, graphHasWrap);
assert.equal(
  marked[0].orphaned,
  false,
  "a one-step wrap whose STEP exists in the graph must not be red"
);

const wrapStolen = markOrphanedSequences(
  sequences,
  new Set(["READ_NOTEBOOKS_TEST"])
);
assert.equal(
  wrapStolen[0].orphaned,
  true,
  "a leftover sequence is orphaned when its wrap STEP was retargeted to another label"
);

const emptyLabel = markOrphanedSequences(
  [{ ...sequences[0], attributiveLabel: "" }],
  graphHasWrap
);
assert.equal(
  emptyLabel[0].orphaned,
  false,
  "an unparsed entry STEP must not be treated as orphaned (that falsely paints new wraps red)"
);

const stringCypherLabels = sequenceStepLabels(wrapCypher);
assert.deepEqual(
  stringCypherLabels,
  ["READ_MESSAGES"],
  "parser must accept a single Cypher string, not only a string[]"
);

console.log("nav-orphan-one-step-wrap: ok");
