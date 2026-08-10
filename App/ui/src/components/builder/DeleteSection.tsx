import { useEffect, useMemo } from "react";
import { useBuilder } from "../../state/builder/BuilderContext";
import {
  addDeleteTarget,
  removeDeleteTarget,
  setDeleteDetach,
  setDeleteTargets,
  updateDeleteTarget
} from "../../state/builder/queryHelpers";
import {
  bindingDisplayLabels,
  bindingForVariable,
  collectDeleteTargetBindings,
  soleDeleteTargetVariable
} from "@pona-flow/authoring";
import { GRAPH_NODE_LABELS } from "../../state/builder/types";
import { Picker } from "./Picker";
import { Toggle } from "./Toggle";

export function DeleteSection() {
  const { state, patchQuery } = useBuilder();
  const del = state.query.delete ?? { detach: false, targets: [] };
  // STEP/SCHEMA/INSTANCE deletes bind each target to a MATCH variable via a
  // dropdown, mirroring the update INSTANCE filter/set/return cards. Any other
  // label falls back to the free-form variable input.
  const label = state.query.match[0]?.label;
  const boundDelete = GRAPH_NODE_LABELS.includes(label);

  const bindings = useMemo(() => collectDeleteTargetBindings(state.query), [state.query]);

  const displayLabels = bindingDisplayLabels(bindings);
  const targetOptions = bindings.map((b) => ({
    value: b.variable,
    label: displayLabels.get(b.variable) ?? b.variable
  }));

  // Renaming a variable or clearing its attributive_label drops it from the MATCH
  // bindings; reset any target that no longer resolves so we never compose a DELETE
  // against a variable that isn't matched.
  useEffect(() => {
    if (!boundDelete) return;
    del.targets.forEach((target, index) => {
      const value = (target || "").trim();
      if (!value) return;
      if (!bindingForVariable(bindings, value)) {
        patchQuery(updateDeleteTarget(index, ""));
      }
    });
  }, [boundDelete, bindings, del.targets, patchQuery]);

  // A single-entity MATCH (e.g. one INSTANCE filtered by WHERE id = $param) has exactly
  // one possible target, so pre-select it instead of blocking on the manual picker.
  useEffect(() => {
    if (!boundDelete) return;
    const sole = soleDeleteTargetVariable(state.query);
    if (sole) patchQuery(setDeleteTargets([sole]));
  }, [boundDelete, state.query, patchQuery]);

  return (
    <section className="builderSection">
      <div className="builderHeadRow">
        <h3 style={{ margin: 0 }}>Delete</h3>
        <button
          type="button"
          className="builderTinyBtn builderAddBtn"
          onClick={() => patchQuery(addDeleteTarget())}
        >
          + target
        </button>
      </div>

      <Toggle
        checked={del.detach ?? false}
        onChange={(value) => patchQuery(setDeleteDetach(value))}
        label="DETACH"
      />

      {del.targets.map((target, index) => (
        <div className="builderItemRow" key={index}>
          <div className="builderField">
            <label>target</label>
            {boundDelete ? (
              <Picker
                value={target}
                placeholder="(select target)"
                options={targetOptions}
                onSelect={(variable) => patchQuery(updateDeleteTarget(index, variable))}
                emptyHint={
                  bindings.length ? undefined : "Add MATCH nodes or relationships first."
                }
              />
            ) : (
              <input
                className="builderMono"
                placeholder="n"
                value={target}
                onChange={(e) => patchQuery(updateDeleteTarget(index, e.target.value))}
              />
            )}
          </div>
          <div className="builderRowActions">
            <button
              type="button"
              className="builderTinyBtn builderDanger"
              onClick={() => patchQuery(removeDeleteTarget(index))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
