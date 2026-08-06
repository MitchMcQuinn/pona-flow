import { Toggle } from "../Toggle";

interface AddFiltersToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function AddFiltersToggle({ checked, onChange, disabled }: AddFiltersToggleProps) {
  return (
    <div className="builderAddFiltersRow">
      <Toggle
        checked={checked}
        onChange={onChange}
        label="Add filters"
        labelFirst
        disabled={disabled}
      />
    </div>
  );
}
