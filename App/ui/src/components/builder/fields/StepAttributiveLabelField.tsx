import { useEffect, useState } from "react";
import { attributiveLabelChanged } from "../../../state/builder/cardReset";
import { isRegisteredInSpaceCatalog, spaceCatalogLabelKeys } from "../../../state/builder/attributiveLabelOptions";
import { isAttributiveLabelParameter } from "../../../state/builder/normalizeField";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import type { GraphNodeLabel, SequencialProperties } from "../../../state/builder/types";
import { Picker } from "../Picker";
import { NewStepNodeModal } from "../modals/NewStepNodeModal";
import { AddParameterModal } from "../modals/AddParameterModal";
import { useDebouncedCheck } from "../hooks/useDebouncedCheck";

export interface ExistingStepNode {
  id: string;
  attributive_label: string;
  sequencial_properties?: SequencialProperties;
}

interface StepAttributiveLabelFieldProps {
  attributiveLabel: string;
  disabled: boolean;
  // Real-time uniqueness validation (new nodes only).
  checkKey: string;
  excludeId?: string;
  enforceUnique: boolean;
  // Graph node label whose existing nodes populate the picker (STEP or SCHEMA).
  nodeLabel?: GraphNodeLabel;
  onSelectNew: (attributiveLabel: string) => void;
  onSelectExisting: (record: ExistingStepNode) => void;
}

export function StepAttributiveLabelField({
  attributiveLabel,
  disabled,
  checkKey,
  excludeId,
  enforceUnique,
  nodeLabel = "STEP",
  onSelectNew,
  onSelectExisting
}: StepAttributiveLabelFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [existing, setExisting] = useState<ExistingStepNode[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showParamModal, setShowParamModal] = useState(false);

  // Globally unique across STEP, SCHEMA, and POINTS_TO (enforced server-side).
  // A $parameter label is validated against its default value in the parameters card.
  const isParameterLabel = isAttributiveLabelParameter(attributiveLabel);
  useDebouncedCheck(
    checkKey,
    Boolean(enforceUnique && spaceId && attributiveLabel.trim() && !isParameterLabel),
    `${spaceId}|${attributiveLabel}|${excludeId ?? ""}`,
    async () => {
      const taken = await connector.checkAttributiveLabelExists({
        spaceId,
        attributiveLabel: attributiveLabel.trim(),
        nodeLabel,
        excludeId
      });
      return taken
        ? { status: "duplicate", message: "already taken" }
        : { status: "ok", message: "valid" };
    }
  );

  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    connector
      .fetchGraphNodesByLabel({ spaceId, nodeLabel })
      .then((rows) => {
        if (!cancelled) setExisting(rows as ExistingStepNode[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // state.dataVersion: refetch after a mutation so newly created nodes appear.
  }, [spaceId, nodeLabel, state.dataVersion]);

  // Only surface existing STEP nodes whose attributive_label is registered in the
  // selected space's label column (spaces.labels), mirroring the old form.
  const catalogKeys = spaceCatalogLabelKeys(state.spaceLabels);
  const options = existing
    .filter((n) => isRegisteredInSpaceCatalog(n.attributive_label, catalogKeys))
    .map((n) => ({ value: n.attributive_label, label: n.attributive_label }));

  const check = state.checks[checkKey];

  return (
    <div className="builderField">
      <label>
        attributive_label
        {enforceUnique && !isParameterLabel && check && check.status !== "idle" ? (
          <span className={`builderCheckMsg ${check.status}`}>
            {check.status === "checking" ? "checking…" : check.message}
          </span>
        ) : null}
      </label>
      <Picker
        value={attributiveLabel}
        placeholder="(select node)"
        options={options}
        createActions={[
          { label: "+ ADD NEW NODE", onClick: () => setShowModal(true) },
          { label: "+ ADD A PARAMETER", onClick: () => setShowParamModal(true) }
        ]}
        onSelect={(value) => {
          if (!attributiveLabelChanged(attributiveLabel, value)) return;
          const rec = existing.find((n) => n.attributive_label === value);
          if (rec) onSelectExisting(rec);
        }}
        disabled={disabled}
        title={disabled ? "Locked because this entry has an alias." : undefined}
        emptyHint={`No ${nodeLabel} nodes in both the graph and this space's label catalog.`}
      />
      {showModal ? (
        <NewStepNodeModal
          onCancel={() => setShowModal(false)}
          onSave={(al) => {
            setShowModal(false);
            onSelectNew(al);
          }}
        />
      ) : null}
      {showParamModal ? (
        <AddParameterModal
          onCancel={() => setShowParamModal(false)}
          onSave={(param) => {
            setShowParamModal(false);
            onSelectNew(param);
          }}
        />
      ) : null}
    </div>
  );
}
