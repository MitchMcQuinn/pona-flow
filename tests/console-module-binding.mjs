/**
 * A form module with only a submit sequence should also record that sequence as its data sequence.
 *
 * Run from App/ui: `npx tsx ../../tests/console-module-binding.mjs`
 */
import assert from "node:assert/strict";
import { bindModuleSequences } from "../App/ui/src/consoles/normalize.ts";

const catalog = [
  { id: "OP_tick", label: "SIMULATE_WORLD_TICK", kind: "operation" },
  { id: "SEQ_create", label: "create person", kind: "sequence" },
];

const blank = {
  id: "mod_step",
  type: "form",
  title: "Advance",
  dataSource: "url",
  dataUrl: "",
  dataSequenceId: "",
  actionSource: "sequence",
  actionUrl: "",
  actionSequenceId: "SIMULATE_WORLD_TICK",
  config: {},
  layout: { x: 0, y: 0, w: 4, h: 4 },
};

const linked = bindModuleSequences(blank, catalog);
assert.equal(linked.dataSequenceId, "OP_tick");
assert.equal(linked.dataSource, "sequence");
assert.equal(linked.actionSequenceId, "OP_tick");
assert.equal(linked.actionSource, "sequence");

const named = bindModuleSequences(
  { ...blank, id: "birth", dataSource: "sequence", actionSequenceId: "create person" },
  catalog,
);
assert.equal(named.dataSequenceId, "SEQ_create");
assert.equal(named.actionSequenceId, "SEQ_create");

console.log("ok");
