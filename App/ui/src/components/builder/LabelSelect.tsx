import uiPersistence from "../../services/uiPersistence";
import { flowAllowed, useBuilder } from "../../state/builder/BuilderContext";
import { GRAPH_NODE_LABELS } from "../../state/builder/types";
import { SegmentToggle } from "./SegmentToggle";

export function LabelSelect() {
  const { state, dispatch, createSequenceMode, flows } = useBuilder();
  if (createSequenceMode) return null;

  const current = state.query.match[0]?.label;
  if (!current) return null;

  const operation = state.query.operation;
  const locked = Boolean(state.editOperation) || state.lockedStepRelationship;

  return (
    <div className="builderField builderSegmentField">
      <label id="builder-label-label">label</label>
      <SegmentToggle
        labelledBy="builder-label-label"
        testId="builder-label-toggle"
        value={current}
        options={GRAPH_NODE_LABELS.map((label) => ({
          value: label,
          label,
          disabled: locked || !flowAllowed(flows, operation, label),
          title: flowAllowed(flows, operation, label)
            ? undefined
            : `You lack ${operation} permission for ${label}`
        }))}
        onChange={(label) => {
          uiPersistence.setLabel(label);
          dispatch({ type: "SET_LABEL", label });
        }}
      />
    </div>
  );
}
