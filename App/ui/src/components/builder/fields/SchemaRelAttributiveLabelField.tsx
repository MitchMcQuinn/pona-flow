import { useEffect, useState } from "react";
import { attributiveLabelChanged } from "../../../state/builder/cardReset";
import { isRegisteredInSpaceCatalog, spaceCatalogLabelKeys } from "../../../state/builder/attributiveLabelOptions";
import { isAttributiveLabelParameter } from "../../../state/builder/normalizeField";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import { Picker } from "../Picker";
import { NewStepNodeModal } from "../modals/NewStepNodeModal";
import { AddParameterModal } from "../modals/AddParameterModal";
import { useDebouncedCheck } from "../hooks/useDebouncedCheck";

/** A reusable SCHEMA relationship type: one attributive_label shared by any number of edges. */
export interface ExistingSchemaRelationshipType {
  id: string;
  attributive_label: string;
}

interface SchemaRelAttributiveLabelFieldProps {
  attributiveLabel: string;
  disabled: boolean;
  checkKey: string;
  excludeId?: string;
  enforceUnique: boolean;
  onSelectNew: (attributiveLabel: string) => void;
  onSelectExisting: (record: ExistingSchemaRelationshipType) => void;
}

export function SchemaRelAttributiveLabelField({
  attributiveLabel,
  disabled,
  checkKey,
  excludeId,
  enforceUnique,
  onSelectNew,
  onSelectExisting
}: SchemaRelAttributiveLabelFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [existing, setExisting] = useState<ExistingSchemaRelationshipType[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showParamModal, setShowParamModal] = useState(false);

  // New type names stay globally unique across STEP, SCHEMA, and POINTS_TO; reusing
  // an existing type skips the check (enforceUnique is off once node_source is set).
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
      .fetchGraphSchemaRelationships({ spaceId })
      .then((rows) => {
        if (!cancelled) setExisting(rows as ExistingSchemaRelationshipType[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  const catalogKeys = spaceCatalogLabelKeys(state.spaceLabels);
  const options = existing
    .filter((r) => isRegisteredInSpaceCatalog(r.attributive_label, catalogKeys))
    .map((r) => ({ value: r.attributive_label, label: r.attributive_label }));

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
        placeholder="(select relationship type)"
        options={options}
        createActions={[
          { label: "+ ADD NEW RELATIONSHIP", onClick: () => setShowModal(true) },
          { label: "+ ADD A PARAMETER", onClick: () => setShowParamModal(true) }
        ]}
        onSelect={(value) => {
          if (!attributiveLabelChanged(attributiveLabel, value)) return;
          const rec = existing.find((r) => r.attributive_label === value);
          if (rec) onSelectExisting(rec);
        }}
        disabled={disabled}
        title={disabled ? "Locked because this entry has an alias." : undefined}
        emptyHint="No SCHEMA relationship types in both the graph and this space's label catalog."
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
