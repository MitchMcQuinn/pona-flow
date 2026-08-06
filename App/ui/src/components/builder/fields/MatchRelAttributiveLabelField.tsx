import { useEffect, useState } from "react";
import { intersectGraphLabelsWithCatalog } from "../../../state/builder/attributiveLabelOptions";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import { Picker } from "../Picker";
import { AddParameterModal } from "../modals/AddParameterModal";

interface MatchRelAttributiveLabelFieldProps {
  attributiveLabel: string;
  disabled?: boolean;
  onSelect: (attributiveLabel: string) => void;
}

// Read / update / delete match: pick an existing relationship by attributive_label (no create).
export function MatchRelAttributiveLabelField({
  attributiveLabel,
  disabled = false,
  onSelect
}: MatchRelAttributiveLabelFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [labels, setLabels] = useState<string[]>([]);
  const [showParamModal, setShowParamModal] = useState(false);

  useEffect(() => {
    if (!spaceId) {
      setLabels([]);
      return;
    }
    let cancelled = false;
    connector
      .fetchGraphRelationshipsByLabel({ spaceId })
      .then((rows) => {
        if (cancelled) return;
        const graphLabels = rows.map((r) => r.attributive_label).filter(Boolean);
        setLabels(intersectGraphLabelsWithCatalog(graphLabels, state.spaceLabels));
      })
      .catch(() => {
        if (!cancelled) setLabels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, state.spaceLabels]);

  const options = labels.map((al) => ({ value: al, label: al }));

  return (
    <div className="builderField">
      <label>attributive_label</label>
      <Picker
        value={attributiveLabel}
        placeholder="(select relationship)"
        options={options}
        createActions={[{ label: "+ ADD A PARAMETER", onClick: () => setShowParamModal(true) }]}
        onSelect={onSelect}
        disabled={disabled}
        emptyHint="No relationships in both the graph and this space's label catalog."
      />
      {showParamModal ? (
        <AddParameterModal
          onCancel={() => setShowParamModal(false)}
          onSave={(param) => {
            setShowParamModal(false);
            onSelect(param);
          }}
        />
      ) : null}
    </div>
  );
}
