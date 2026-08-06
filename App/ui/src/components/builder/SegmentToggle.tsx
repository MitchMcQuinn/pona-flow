import type { CSSProperties, ReactNode } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

interface SegmentToggleProps<T extends string> {
  labelledBy: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Optional stable test hook; the group gets `${testId}` and options `${testId}-option-{value}`. */
  testId?: string;
}

/** Segmented control with a mesh-lit indicator that slides between options. */
export function SegmentToggle<T extends string>({
  labelledBy,
  options,
  value,
  onChange,
  testId
}: SegmentToggleProps<T>) {
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );

  return (
    <div
      className="builderSegmentToggle"
      role="radiogroup"
      aria-labelledby={labelledBy}
      data-testid={testId}
      style={
        {
          "--segment-count": options.length,
          "--segment-index": activeIndex
        } as CSSProperties
      }
    >
      <div className="builderSegmentIndicator" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? "active" : undefined}
          data-testid={testId ? `${testId}-option-${option.value}` : undefined}
          disabled={option.disabled}
          title={option.title}
          onClick={() => {
            if (value !== option.value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
