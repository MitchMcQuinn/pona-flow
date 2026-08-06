import { useEffect, useState } from "react";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector, { type GraphNodeRow } from "../../../services/connector";
import { INSTANCE_TARGET_NEW_VALUE } from "../../../state/builder/instanceTarget";
import { Picker } from "../Picker";
import { AddParameterModal } from "../modals/AddParameterModal";

export interface ExistingInstanceNode {
  id: string;
  attributive_label: string;
  display_label: string;
}

interface InstanceTargetFieldProps {
  schemaAttributiveLabel: string;
  targetValue: string;
  disabled: boolean;
  onSelectNew: () => void;
  onSelectExisting: (record: ExistingInstanceNode) => void;
  /** Target supplied at run time: called with an exact "$name" reference. */
  onSelectParameter: (parameter: string) => void;
}

function instanceOptionLabel(record: ExistingInstanceNode): string {
  const text = (record.display_label || record.id).trim();
  return text || record.id;
}

// After schema (attributive_label) is chosen: pick an existing INSTANCE or create a new one.
export function InstanceTargetField({
  schemaAttributiveLabel,
  targetValue,
  disabled,
  onSelectNew,
  onSelectExisting,
  onSelectParameter
}: InstanceTargetFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [instances, setInstances] = useState<ExistingInstanceNode[]>([]);
  const [showParamModal, setShowParamModal] = useState(false);

  useEffect(() => {
    if (!spaceId || !schemaAttributiveLabel.trim()) {
      setInstances([]);
      return;
    }
    let cancelled = false;
    connector
      .fetchGraphNodesByLabel({
        spaceId,
        nodeLabel: "INSTANCE",
        attributiveLabel: schemaAttributiveLabel.trim()
      })
      .then((rows) => {
        if (cancelled) return;
        setInstances(
          (rows as GraphNodeRow[]).map((r) => ({
            id: r.id,
            attributive_label: r.attributive_label,
            display_label: (r.display_label || r.id).trim() || r.id
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setInstances([]);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, schemaAttributiveLabel]);

  const options = [
    ...(targetValue === INSTANCE_TARGET_NEW_VALUE
      ? [{ value: INSTANCE_TARGET_NEW_VALUE, label: "New instance" }]
      : []),
    ...instances.map((n) => ({
      value: n.id,
      label: instanceOptionLabel(n)
    }))
  ];

  return (
    <div className="builderField">
      <label>target</label>
      <Picker
        value={targetValue}
        placeholder="(select target)"
        options={options}
        createLabel="+ NEW INSTANCE"
        onCreate={() => {
          if (targetValue === INSTANCE_TARGET_NEW_VALUE) return;
          onSelectNew();
        }}
        createActions={[{ label: "+ ADD A PARAMETER", onClick: () => setShowParamModal(true) }]}
        onSelect={(value) => {
          if (value === INSTANCE_TARGET_NEW_VALUE) return;
          const rec = instances.find((n) => n.id === value);
          if (rec) onSelectExisting(rec);
        }}
        disabled={disabled || !schemaAttributiveLabel.trim()}
        title={disabled ? "Locked because this entry has an alias." : undefined}
        emptyHint={
          schemaAttributiveLabel.trim()
            ? "No existing instances for this schema yet — use + NEW INSTANCE."
            : "Select a schema first."
        }
      />
      {showParamModal ? (
        <AddParameterModal
          onCancel={() => setShowParamModal(false)}
          onSave={(param) => {
            setShowParamModal(false);
            if (param !== targetValue) onSelectParameter(param);
          }}
        />
      ) : null}
    </div>
  );
}
