import { parseCheckboxSelection } from "@pona-flow/authoring";

interface TypedValueInputProps {
  /** Declared value_type driving which control renders. */
  valueType: string;
  /** radio + checkbox: choices presented to the user. */
  options?: string[];
  /**
   * checkbox: minimum selections required. Accepted for API symmetry with the validators
   * (enforcement happens in validation, not in rendering), so it is intentionally unused here.
   */
  minChoices?: number;
  /** checkbox: maximum selections allowed (disables further checks once reached). */
  maxChoices?: number;
  required?: boolean;
  /** Raw value: a string for most types, a JSON array string for checkbox. */
  value: string;
  onChange: (raw: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  id?: string;
  placeholder?: string;
  title?: string;
}

const NONE_VALUE = "";

/**
 * Renders the appropriate value-collection control for a property/parameter value_type:
 *  - boolean  -> TRUE/FALSE dropdown
 *  - radio    -> single-select dropdown of configured options
 *  - checkbox -> constrained checklist (honors min/max choices)
 *  - anything else -> plain text input
 * Used both in the create-INSTANCE flow and the sequence-execution parameters panel so a
 * single rule decides how a typed value is collected.
 */
export function TypedValueInput({
  valueType,
  options,
  maxChoices,
  required = false,
  value,
  onChange,
  disabled = false,
  readOnly = false,
  id,
  placeholder,
  title
}: TypedValueInputProps) {
  if (valueType === "boolean") {
    const current = value === "true" || value === "false" ? value : NONE_VALUE;
    return (
      <select
        id={id}
        value={current}
        disabled={disabled || readOnly}
        title={title}
        onChange={(e) => onChange(e.target.value)}
      >
        {!required || current === NONE_VALUE ? (
          <option value={NONE_VALUE}>{required ? "(select)" : "(none)"}</option>
        ) : null}
        <option value="true">TRUE</option>
        <option value="false">FALSE</option>
      </select>
    );
  }

  if (valueType === "radio") {
    const opts = options ?? [];
    return (
      <select
        id={id}
        value={opts.includes(value) ? value : NONE_VALUE}
        disabled={disabled || readOnly}
        title={title}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={NONE_VALUE}>{required ? "(select one)" : "(none)"}</option>
        {opts.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (valueType === "checkbox") {
    const opts = options ?? [];
    const selected = parseCheckboxSelection(value);
    const atMax =
      typeof maxChoices === "number" && maxChoices > 0 && selected.length >= maxChoices;

    const toggle = (opt: string) => {
      const next = selected.includes(opt)
        ? selected.filter((s) => s !== opt)
        : [...selected, opt];
      onChange(JSON.stringify(next));
    };

    return (
      <div className="typedChecklist" title={title}>
        {opts.length === 0 ? (
          <span className="builderMuted">(no options configured)</span>
        ) : (
          opts.map((opt) => {
            const checked = selected.includes(opt);
            return (
              <label key={opt} className="typedChecklistItem">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || readOnly || (!checked && atMax)}
                  onChange={() => toggle(opt)}
                />
                <span>{opt}</span>
              </label>
            );
          })
        )}
      </div>
    );
  }

  return (
    <input
      id={id}
      value={value}
      readOnly={readOnly}
      disabled={disabled}
      placeholder={placeholder}
      title={title}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
