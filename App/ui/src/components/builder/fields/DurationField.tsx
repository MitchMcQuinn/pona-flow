import {
  WAIT_DURATION_UNIT_LABELS,
  WAIT_DURATION_UNITS,
  durationAmountToSeconds,
  secondsToDurationParts,
  waitDurationParamName,
  type WaitDurationUnit
} from "@pona-flow/authoring";

interface DurationFieldProps {
  /** Stored seconds, or exactly `$name`. */
  value: number | string | undefined;
  onChange: (next: number | string) => void;
  disabled?: boolean;
  label: string;
  hint?: string;
  /** When true, the amount box also accepts `$parameter`. */
  allowParameter?: boolean;
  testId?: string;
}

/**
 * Number + unit picker that writes seconds (or a `$param` when allowParameter is on).
 */
export function DurationField({
  value,
  onChange,
  disabled,
  label,
  hint,
  allowParameter = false,
  testId
}: DurationFieldProps) {
  const paramName = waitDurationParamName(value);
  const seconds = typeof value === "number" ? value : Number(String(value ?? "").trim());
  const parts =
    paramName || !Number.isFinite(seconds)
      ? { amount: 0, unit: "seconds" as WaitDurationUnit }
      : secondsToDurationParts(seconds);
  const amountText = paramName ? `$${paramName}` : String(parts.amount || (value === 0 ? 0 : ""));

  function commitAmount(raw: string, unit: WaitDurationUnit) {
    const trimmed = raw.trim();
    if (allowParameter && trimmed.startsWith("$")) {
      onChange(trimmed);
      return;
    }
    if (trimmed === "") {
      onChange(0);
      return;
    }
    const amount = Number(trimmed);
    if (!Number.isFinite(amount) || amount < 0) return;
    onChange(durationAmountToSeconds(amount, unit));
  }

  return (
    <div className="builderField">
      <label>{label}</label>
      <div className="builderDurationRow">
        <input
          type="text"
          inputMode={paramName ? "text" : "decimal"}
          data-testid={testId}
          value={amountText}
          placeholder={allowParameter ? "0 or $seconds" : "0"}
          disabled={disabled}
          onChange={(e) => commitAmount(e.target.value, parts.unit)}
        />
        <select
          value={parts.unit}
          disabled={disabled || Boolean(paramName)}
          onChange={(e) => {
            const unit = e.target.value as WaitDurationUnit;
            if (paramName) return;
            commitAmount(String(parts.amount || 0), unit);
          }}
        >
          {WAIT_DURATION_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {WAIT_DURATION_UNIT_LABELS[unit]}
            </option>
          ))}
        </select>
      </div>
      {hint ? <span className="createSequenceHint">{hint}</span> : null}
    </div>
  );
}
