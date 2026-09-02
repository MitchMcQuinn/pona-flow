import { useEffect, useState } from "react";
import {
  buildStepLabelOptions,
  excludeSequenceStepOptions,
  intersectGraphLabelsWithCatalog
} from "../../../state/builder/attributiveLabelOptions";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import type { GraphNodeLabel } from "../../../state/builder/types";
import { Picker } from "../Picker";
import { AddParameterModal } from "../modals/AddParameterModal";

interface MatchAttributiveLabelFieldProps {
  /** Graph label used to load nodes (INSTANCE uses SCHEMA). */
  fetchLabel: GraphNodeLabel;
  attributiveLabel: string;
  disabled?: boolean;
  /** When true, only labels present in both the graph and ``spaces.labels``. */
  requireSpaceCatalog?: boolean;
  /** Offer the "+ ADD A PARAMETER" action (off for entity-config update pickers). */
  allowParameter?: boolean;
  onSelect: (attributiveLabel: string) => void;
}

// Read / update / delete match: pick an existing node by attributive_label (no create).
export function MatchAttributiveLabelField({
  fetchLabel,
  attributiveLabel,
  disabled = false,
  requireSpaceCatalog = true,
  allowParameter = true,
  onSelect
}: MatchAttributiveLabelFieldProps) {
  const { state, createSequenceMode } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [graphUnavailable, setGraphUnavailable] = useState(false);
  const [showParamModal, setShowParamModal] = useState(false);

  useEffect(() => {
    if (!spaceId) {
      setOptions([]);
      setGraphUnavailable(false);
      return;
    }
    let cancelled = false;
    connector
      .fetchGraphNodesByLabel({ spaceId, nodeLabel: fetchLabel })
      .then((rows) => {
        if (cancelled) return;
        setGraphUnavailable(false);
        // STEP labels can collide across raw endpoints, operations, and sequences, so
        // annotate each with its resolved kind to disambiguate. Other node labels
        // (SCHEMA/INSTANCE) have no kind, so show their plain attributive_label.
        if (fetchLabel === "STEP") {
          let stepOptions = buildStepLabelOptions(
            rows,
            state.spaceLabels,
            state.savedQueries,
            requireSpaceCatalog
          );
          // Nested sequences are not runnable, so don't offer them while building one.
          if (createSequenceMode) stepOptions = excludeSequenceStepOptions(stepOptions);
          setOptions(
            stepOptions.map((opt) => ({
              value: opt.value,
              label: `${opt.value}  (${opt.kind}${opt.suspended ? " · suspended" : ""})`
            }))
          );
          return;
        }
        const graphLabels = rows.map((r) => r.attributive_label).filter(Boolean);
        const list = requireSpaceCatalog
          ? intersectGraphLabelsWithCatalog(graphLabels, state.spaceLabels)
          : Array.from(new Set(graphLabels)).sort((a, b) => a.localeCompare(b));
        setOptions(list.map((al) => ({ value: al, label: al })));
      })
      .catch(() => {
        if (cancelled) return;
        setGraphUnavailable(true);
        setOptions([]);
      });
    return () => {
      cancelled = true;
    };
    // state.dataVersion: refetch after a mutation so newly created nodes appear.
  }, [
    spaceId,
    fetchLabel,
    requireSpaceCatalog,
    createSequenceMode,
    state.spaceLabels,
    state.savedQueries,
    state.dataVersion
  ]);
  const emptyHint = graphUnavailable
    ? `Could not load ${fetchLabel} nodes from the graph. Check the space Neo4j connection.`
    : requireSpaceCatalog
      ? `No ${fetchLabel} nodes in both the graph and this space's label catalog.`
      : `No ${fetchLabel} nodes in this space.`;

  return (
    <div className="builderField">
      <label>attributive_label</label>
      <Picker
        value={attributiveLabel}
        placeholder="(select node)"
        options={options}
        createActions={
          createSequenceMode || !allowParameter
            ? []
            : [{ label: "+ ADD A PARAMETER", onClick: () => setShowParamModal(true) }]
        }
        onSelect={onSelect}
        disabled={disabled}
        emptyHint={emptyHint}
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
