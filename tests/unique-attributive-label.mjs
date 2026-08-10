/**
 * nextUniqueAttributiveLabel: suffix collision when a STEP attributive_label is taken.
 */
import assert from "node:assert/strict";
import { nextUniqueAttributiveLabel } from "../App/authoring/src/uniqueAttributiveLabel.ts";

assert.equal(nextUniqueAttributiveLabel("FOO", new Set()), "FOO", "unused base is kept");
assert.equal(
  nextUniqueAttributiveLabel("FOO", new Set(["FOO"])),
  "FOO1",
  "first collision appends 1"
);
assert.equal(
  nextUniqueAttributiveLabel("FOO", new Set(["FOO", "FOO1"])),
  "FOO2",
  "skips taken suffixed labels"
);
assert.equal(
  nextUniqueAttributiveLabel("SHOW_ALICES", new Set(["SHOW_ALICES"])),
  "SHOW_ALICES1",
  "works on longer names"
);
assert.equal(nextUniqueAttributiveLabel("  FOO  ", new Set(["FOO"])), "FOO1", "trims base name");
assert.equal(nextUniqueAttributiveLabel("", new Set(["FOO"])), "", "empty base stays empty");

console.log("unique-attributive-label: ok");
