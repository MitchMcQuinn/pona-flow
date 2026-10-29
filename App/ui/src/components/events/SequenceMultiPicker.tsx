import { FieldLabel } from "../builder/FieldTip";
import { Picker } from "../builder/Picker";
import type { SequenceSummary } from "../../state/types";

interface SequenceMultiPickerProps {
  label: string;
  tip: string;
  sequences: SequenceSummary[];
  selected: string[];
  onChange: (next: string[]) => void;
  pickerTestId: string;
  menuTestId: string;
  placeholder?: string;
}

/**
 * Selected sequences stay in a flat list under the label. The full catalog opens from
 * a picker, so it does not sit on the form.
 */
export function SequenceMultiPicker({
  label,
  tip,
  sequences,
  selected,
  onChange,
  pickerTestId,
  menuTestId,
  placeholder = "Add a sequence"
}: SequenceMultiPickerProps) {
  const labels = new Map(sequences.map((sequence) => [sequence.id, sequence.label]));
  const available = sequences.filter((sequence) => !selected.includes(sequence.id));

  function add(id: string) {
    if (!id || selected.includes(id)) return;
    onChange([...selected, id]);
  }

  function remove(id: string) {
    onChange(selected.filter((entry) => entry !== id));
  }

  return (
    <div className="field">
      <FieldLabel tip={tip}>{label}</FieldLabel>
      {selected.length > 0 ? (
        <ul className="eventSeqChips">
          {selected.map((id) => {
            const name = labels.get(id) || id;
            return (
              <li key={id} className="eventSeqChip" data-pin-target={id}>
                <span>{name}</span>
                <button
                  type="button"
                  className="eventSeqChipRemove"
                  aria-label={`Remove ${name}`}
                  onClick={() => remove(id)}
                >
                  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                    <path
                      d="M2 2 L10 10 M10 2 L2 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {sequences.length === 0 ? (
        <p className="muted">No sequences available in this space.</p>
      ) : available.length > 0 ? (
        <Picker
          value=""
          placeholder={placeholder}
          ariaLabel={label}
          options={available.map((sequence) => ({ value: sequence.id, label: sequence.label }))}
          onSelect={add}
          toggleTestId={pickerTestId}
          menuTestId={menuTestId}
        />
      ) : null}
    </div>
  );
}
