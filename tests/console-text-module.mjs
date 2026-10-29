/**
 * Text module: a sequence that returns one row with a text column should
 * display that value, including a count of 0.
 *
 * Run from App/ui: `npx tsx ../../tests/console-text-module.mjs`
 */
import assert from "node:assert/strict";
import { moduleText, sequenceFieldLines } from "../App/ui/src/consoles/modules/data.ts";

const keys = ["text", "message", "body"];

assert.equal(moduleText({ text: "Warehouse is clear." }, keys), "Warehouse is clear.");
assert.equal(moduleText("plain", keys), "plain");
assert.equal(
  moduleText({ kind: "table", columns: ["text"], rows: [{ text: 5 }] }, keys),
  "5",
);
assert.equal(
  moduleText({ kind: "table", columns: ["text"], rows: [{ text: 0 }] }, keys),
  "0",
);
assert.equal(
  moduleText({ kind: "table", columns: ["text"], rows: [{ text: 1 }, { text: 2 }] }, keys),
  null,
);
assert.equal(moduleText({ kind: "table", columns: ["name"], rows: [{ name: "Ada" }] }, keys), null);

const population = sequenceFieldLines({
  kind: "table",
  columns: ["boobas", "kikis", "history"],
  rows: [{ boobas: 3, kikis: 1, history: [{ tick: 1 }, { tick: 2 }] }],
});
assert.deepEqual(
  population.map((line) => [line.key, line.value]),
  [
    ["boobas", "3"],
    ["kikis", "1"],
    ["history", "2 items"],
  ],
);
assert.equal(
  sequenceFieldLines({ kind: "table", rows: [{ text: 1 }, { text: 2 }] }).length,
  0,
);

console.log("ok");
