interface ChoiceOptionsPatch {
  options?: string[];
  min_choices?: number;
  max_choices?: number;
}

interface ChoiceOptionsEditorProps {
  valueType: "radio" | "checkbox";
  options: string[];
  minChoices?: number;
  maxChoices?: number;
  disabled?: boolean;
  onChange: (patch: ChoiceOptionsPatch) => void;
}

/**
 * Author-facing configuration for radio/checkbox value_types: the list of options the end
 * user will choose from, plus (checkbox only) the min/max number of valid choices. Used by
 * both PropertyBinding (SCHEMA properties) and ParametersSection (parameters).
 */
export function ChoiceOptionsEditor({
  valueType,
  options,
  minChoices,
  maxChoices,
  disabled = false,
  onChange
}: ChoiceOptionsEditorProps) {
  const setOptionAt = (index: number, value: string) => {
    const next = [...options];
    next[index] = value;
    onChange({ options: next });
  };

  const addOption = () => onChange({ options: [...options, ""] });

  const removeOption = (index: number) =>
    onChange({ options: options.filter((_, i) => i !== index) });

  /** Accept only non-negative integer strings (no "e", decimals, or signs). */
  const patchCount = (key: "min_choices" | "max_choices", raw: string) => {
    const t = raw.trim();
    if (t === "") {
      onChange({ [key]: undefined });
      return;
    }
    if (!/^\d+$/.test(t)) return;
    onChange({ [key]: Number.parseInt(t, 10) });
  };

  return (
    <div className="builderField choiceOptionsEditor">
      <label>options</label>
      {options.length === 0 ? (
        <p className="builderCheckMsg">No options yet. Add the choices the user picks from.</p>
      ) : null}
      {options.map((opt, index) => (
        <div key={index} className="choiceOptionRow">
          <input
            className="builderMono"
            value={opt}
            placeholder={`option ${index + 1}`}
            disabled={disabled}
            onChange={(e) => setOptionAt(index, e.target.value)}
          />
          <button
            type="button"
            className="builderTinyBtn builderDanger"
            title="Remove option"
            disabled={disabled}
            onClick={() => removeOption(index)}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="builderTinyBtn" disabled={disabled} onClick={addOption}>
        + option
      </button>

      {valueType === "checkbox" ? (
        <div className="builderRow choiceCountRow">
          <div className="builderField">
            <label>min choices</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={typeof minChoices === "number" ? String(minChoices) : ""}
              placeholder="(none)"
              disabled={disabled}
              onChange={(e) => patchCount("min_choices", e.target.value)}
            />
          </div>
          <div className="builderField">
            <label>max choices</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={typeof maxChoices === "number" ? String(maxChoices) : ""}
              placeholder="(none)"
              disabled={disabled}
              onChange={(e) => patchCount("max_choices", e.target.value)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
