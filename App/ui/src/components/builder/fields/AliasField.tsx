import { useState } from "react";
import {
  ALIAS_NAME_ERROR_MSG,
  ALIAS_NAME_PATTERN,
  normalizeAlias
} from "@pona-flow/authoring";
import { Picker } from "../Picker";
import { ModalBackdrop } from "../../modals/ModalBackdrop";

interface AliasFieldProps {
  // Current display name: the variable when defining, or alias_ref when referencing.
  aliasName: string;
  locked: boolean;
  /** Shown in the picker when unlocked (e.g. default alias from attributive_label). */
  effectiveAlias?: string;
  placeholder?: string;
  // Other locked alias names declared in the query (same kind), excluding this entry.
  available: string[];
  // Whether an attributive_label is present (required before creating a new alias).
  canCreate: boolean;
  onCreate: (name: string) => void;
  onChooseExisting: (name: string) => void;
}

export function AliasField({
  aliasName,
  locked,
  effectiveAlias = "",
  placeholder = "Default to ID",
  available,
  canCreate,
  onCreate,
  onChooseExisting
}: AliasFieldProps) {
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function save() {
    const v = normalizeAlias(name);
    if (v !== name) setName(v);
    if (!ALIAS_NAME_PATTERN.test(v)) {
      setError(ALIAS_NAME_ERROR_MSG);
      return;
    }
    if (available.includes(v)) {
      setError("An alias with this name already exists in this query.");
      return;
    }
    setShowModal(false);
    setName("");
    setError(null);
    onCreate(v);
  }

  return (
    <div className="builderField">
      <label>alias</label>
      <Picker
        value={locked ? aliasName : effectiveAlias}
        placeholder={placeholder}
        options={available.map((a) => ({ value: a, label: a }))}
        createLabel={canCreate ? "+ ADD ALIAS" : undefined}
        onCreate={
          canCreate
            ? () => {
                setName("");
                setError(null);
                setShowModal(true);
              }
            : undefined
        }
        onSelect={(value) => onChooseExisting(value)}
        disabled={locked}
        title={locked ? "Alias is locked for this entry." : undefined}
        emptyHint={canCreate ? undefined : "Select an attributive_label to add a new alias."}
      />

      {showModal ? (
        <ModalBackdrop onClick={() => setShowModal(false)}>
          <div className="builderModalPanel" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Add alias</h3>
            <div className="builderField">
              <label>alias name</label>
              <input
                autoFocus
                className="builderMono"
                value={name}
                placeholder="e.g. step1"
                onChange={(e) => {
                  setName(normalizeAlias(e.target.value));
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
            </div>
            {error ? <p className="builderCheckMsg error">{error}</p> : null}
            <div className="builderModalActions">
              <button
                type="button"
                className="builderTinyBtn"
                onClick={() => setShowModal(false)}
              >
                Cancel
              </button>
              <button type="button" onClick={save}>
                Save
              </button>
            </div>
          </div>
        </ModalBackdrop>
      ) : null}
    </div>
  );
}
