import { useEffect, useState } from "react";
import { attributiveLabelChanged } from "../../../state/builder/cardReset";
import { intersectGraphLabelsWithCatalog } from "../../../state/builder/attributiveLabelOptions";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import { Picker } from "../Picker";
import { AddParameterModal } from "../modals/AddParameterModal";

interface InstanceNodeAttributiveFieldProps {
  attributiveLabel: string;
  disabled: boolean;
  /** SCHEMA type chosen; target (new vs existing instance) is selected separately. */
  onSelect: (attributiveLabel: string) => void;
}

// INSTANCE node: attributive_label is constrained to an existing SCHEMA node.
export function InstanceNodeAttributiveField({
  attributiveLabel,
  disabled,
  onSelect
}: InstanceNodeAttributiveFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [schemas, setSchemas] = useState<string[]>([]);
  const [showParamModal, setShowParamModal] = useState(false);

  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    connector
      .fetchGraphNodesByLabel({ spaceId, nodeLabel: "SCHEMA" })
      .then((rows) => {
        if (cancelled) return;
        const graphLabels = rows.map((r) => r.attributive_label).filter(Boolean);
        setSchemas(intersectGraphLabelsWithCatalog(graphLabels, state.spaceLabels));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [spaceId, state.spaceLabels]);

  return (
    <div className="builderField">
      <label>attributive_label</label>
      <Picker
        value={attributiveLabel}
        placeholder="(select schema)"
        options={schemas.map((s) => ({ value: s, label: s }))}
        createActions={[{ label: "+ ADD A PARAMETER", onClick: () => setShowParamModal(true) }]}
        onSelect={(value) => {
          if (!attributiveLabelChanged(attributiveLabel, value)) return;
          onSelect(value);
        }}
        disabled={disabled}
        title={disabled ? "Locked because this entry has an alias." : undefined}
        emptyHint="No SCHEMA nodes in both the graph and this space's label catalog."
      />
      {showParamModal ? (
        <AddParameterModal
          onCancel={() => setShowParamModal(false)}
          onSave={(param) => {
            setShowParamModal(false);
            if (attributiveLabelChanged(attributiveLabel, param)) onSelect(param);
          }}
        />
      ) : null}
    </div>
  );
}
