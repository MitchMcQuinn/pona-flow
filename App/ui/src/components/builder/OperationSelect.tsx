import uiPersistence from "../../services/uiPersistence";
import { operationAllowed, useBuilder } from "../../state/builder/BuilderContext";
import type { Operation } from "../../state/builder/types";
import { SegmentToggle } from "./SegmentToggle";

const OPERATIONS: Operation[] = ["create", "read", "update", "delete"];

export function OperationSelect() {
  const { state, dispatch, createSequenceMode, flows } = useBuilder();
  if (createSequenceMode) return null;

  const current = state.query.operation;
  const locked = Boolean(state.editOperation) || state.lockedStepRelationship;

  return (
    <div className="builderField builderSegmentField">
      <label id="builder-operation-label">operation</label>
      <SegmentToggle
        labelledBy="builder-operation-label"
        testId="builder-operation-toggle"
        value={current}
        options={OPERATIONS.map((op) => ({
          value: op,
          label: op,
          disabled: locked || !operationAllowed(flows, op),
          title: operationAllowed(flows, op) ? undefined : "You lack permission for this operation"
        }))}
        onChange={(operation) => {
          uiPersistence.setOperation(operation);
          dispatch({ type: "SET_OPERATION", operation });
        }}
      />
    </div>
  );
}
