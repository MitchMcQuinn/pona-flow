import { useEffect, useState } from "react";
import { intersectGraphLabelsWithCatalog } from "../../../state/builder/attributiveLabelOptions";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector, { type GraphNodeRow } from "../../../services/connector";
import { Picker } from "../Picker";

interface UpdateStepNodeFieldProps {
  attributiveLabel: string;
  disabled?: boolean;
  onSelect: (row: GraphNodeRow) => void;
}

// Update STEP: only custom-endpoint STEP nodes are editable. STEP nodes backed by a
// saved operation/sequence (query_id) are hidden because their config is owned by the
// referenced query, not this entity row.
export function UpdateStepNodeField({
  attributiveLabel,
  disabled = false,
  onSelect
}: UpdateStepNodeFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [rows, setRows] = useState<GraphNodeRow[]>([]);
  const [graphUnavailable, setGraphUnavailable] = useState(false);

  useEffect(() => {
    if (!spaceId) {
      setRows([]);
      setGraphUnavailable(false);
      return;
    }
    let cancelled = false;
    connector
      .fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" })
      .then((all) => {
        if (cancelled) return;
        const custom = all.filter((r) => !(r.sequencial_properties?.query_id || "").trim());
        setGraphUnavailable(false);
        setRows(custom);
      })
      .catch(() => {
        if (cancelled) return;
        setGraphUnavailable(true);
        setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  const allowed = new Set(
    intersectGraphLabelsWithCatalog(
      rows.map((r) => r.attributive_label).filter(Boolean),
      state.spaceLabels
    )
  );
  const options = rows
    .filter((r) => allowed.has(r.attributive_label))
    .map((r) => ({ value: r.attributive_label, label: r.attributive_label }));

  const emptyHint = graphUnavailable
    ? "Could not load STEP nodes from the graph. Check the space Neo4j connection."
    : "No custom-endpoint STEP nodes in both the graph and this space's label catalog.";

  return (
    <div className="builderField">
      <label>attributive_label</label>
      <Picker
        value={attributiveLabel}
        placeholder="(select STEP)"
        options={options}
        onSelect={(value) => {
          const row = rows.find((r) => r.attributive_label === value);
          if (row) onSelect(row);
        }}
        disabled={disabled}
        emptyHint={emptyHint}
      />
    </div>
  );
}
