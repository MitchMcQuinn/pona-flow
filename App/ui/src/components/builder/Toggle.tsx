import { useId } from "react";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  /** When true, label renders to the left of the switch track. */
  labelFirst?: boolean;
  id?: string;
  disabled?: boolean;
}

export function Toggle({
  checked,
  onChange,
  label,
  labelFirst = false,
  id,
  disabled = false
}: ToggleProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  const labelId = label ? `${switchId}-label` : undefined;

  return (
    <div
      className={`builderToggle${labelFirst ? " builderToggle--labelFirst" : ""}${disabled ? " disabled" : ""}`}
    >
      {label ? (
        <span className="builderToggleLabel" id={labelId}>
          {label}
        </span>
      ) : null}
      <button
        type="button"
        id={switchId}
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        className="builderToggleSwitch"
        onClick={() => onChange(!checked)}
      >
        <span className="builderToggleTrack" aria-hidden>
          <span className="builderToggleThumb" />
        </span>
      </button>
    </div>
  );
}
