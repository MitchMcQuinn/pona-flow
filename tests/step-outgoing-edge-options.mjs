/**
 * STEP hop picker: two POINTS_TO edges between the same STEPs (shared NEXT label
 * and target) must both appear as options, keyed by relationship id, so a delete
 * can target one without taking the other.
 *
 * Run from App/ui: `npx tsx ../../tests/step-outgoing-edge-options.mjs`
 */
import assert from "node:assert/strict";
import {
  selectedStepOutgoingEdgeValue,
  stepEdgeConditionCaption,
  stepOutgoingEdgePickerOptions
} from "../App/ui/src/components/builder/fields/stepOutgoingEdgeOptions.ts";

function edge(partial) {
  return {
    rel_id: "",
    rel_attributive_label: "NEXT",
    target_id: "ID_b",
    target_attributive_label: "STEP_B",
    ...partial
  };
}

// Unique label: value is the bare attributive_label.
{
  const options = stepOutgoingEdgePickerOptions([
    edge({ rel_id: "ID_1", rel_attributive_label: "ON_ERROR", target_attributive_label: "HANDLER" })
  ]);
  assert.equal(options.length, 1);
  assert.equal(options[0].value, "ON_ERROR");
  assert.equal(options[0].label, "ON_ERROR");
}

// Same label, different targets: disambiguate by target (existing sibling case).
{
  const options = stepOutgoingEdgePickerOptions([
    edge({ rel_id: "ID_yes", target_id: "ID_b", target_attributive_label: "STEP_B" }),
    edge({ rel_id: "ID_no", target_id: "ID_c", target_attributive_label: "STEP_C" })
  ]);
  assert.deepEqual(
    options.map((o) => ({ value: o.value, label: o.label })),
    [
      { value: "NEXT|STEP_B", label: "NEXT → STEP_B" },
      { value: "NEXT|STEP_C", label: "NEXT → STEP_C" }
    ]
  );
}

// Same label AND same target: two real edges — list both, keyed by id.
{
  const yes = edge({
    rel_id: "ID_rel_yes",
    condition: "$approved",
    condition_type: "parameter",
    condition_expected: true
  });
  const no = edge({
    rel_id: "ID_rel_no",
    condition: "$approved",
    condition_type: "parameter",
    condition_expected: false
  });
  const options = stepOutgoingEdgePickerOptions([yes, no]);
  assert.equal(options.length, 2, "parallel same-target edges must both appear");
  assert.deepEqual(
    new Set(options.map((o) => o.value)),
    new Set(["ID_rel_yes", "ID_rel_no"])
  );
  const labels = options.map((o) => o.label).sort();
  assert.deepEqual(labels, [
    "NEXT → STEP_B ($approved is false)",
    "NEXT → STEP_B ($approved is true)"
  ]);
  assert.equal(
    selectedStepOutgoingEdgeValue(options, "NEXT", "STEP_B", "ID_rel_no"),
    "ID_rel_no",
    "bound relationship id selects the matching parallel edge"
  );
}

// Read MATCH is label-only: collapse same-target siblings back to one option.
{
  const options = stepOutgoingEdgePickerOptions(
    [
      edge({ rel_id: "ID_rel_yes", condition: "$approved", condition_type: "parameter" }),
      edge({ rel_id: "ID_rel_no", condition: "$approved", condition_type: "parameter", condition_expected: false })
    ],
    { distinguishParallelPairs: false }
  );
  assert.equal(options.length, 1, "read MATCH does not list the same hop twice");
  assert.equal(options[0].value, "NEXT|STEP_B");
  assert.equal(options[0].label, "NEXT → STEP_B");
}

{
  const caption = stepEdgeConditionCaption(
    edge({ condition: "$flag", condition_type: "parameter", condition_expected: false })
  );
  assert.equal(caption, "$flag is false");
}

console.log("step-outgoing-edge-options: ok");
