/**
 * nextUniqueAttributiveLabel: suffix collision when a STEP attributive_label is taken.
 */
import assert from "node:assert/strict";
import {
  nextUniqueAttributiveLabel,
  shouldRetargetOperationWrap,
  stepWrapBaseName,
} from "../App/authoring/src/uniqueAttributiveLabel.ts";

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
assert.equal(stepWrapBaseName("Create customer", ["customer_record"]), "Create customer");
assert.equal(stepWrapBaseName("entity", ["entity"]), "create_entity");
assert.equal(stepWrapBaseName("ENTITY", ["entity"]), "create_ENTITY");
assert.equal(
  stepWrapBaseName("entity", ["entity", "create_entity"]),
  "create_entity1",
  "suffixes when create_<label> is also reserved"
);

assert.equal(
  shouldRetargetOperationWrap({
    requestedName: "READ_PEOPLE",
    wrapEntityId: "wrap-1",
    currentWrapLabel: "READ_PERSON",
    labelTakenByOther: false,
    multiStepReferencesWrap: false,
  }),
  true,
  "free name with no multi-step MATCH retargets"
);
assert.equal(
  shouldRetargetOperationWrap({
    requestedName: "READ_PEOPLE",
    wrapEntityId: "wrap-1",
    currentWrapLabel: "READ_PERSON",
    labelTakenByOther: false,
    multiStepReferencesWrap: true,
  }),
  false,
  "multi-step MATCH blocks wrap retarget"
);

console.log("unique-attributive-label: ok");
