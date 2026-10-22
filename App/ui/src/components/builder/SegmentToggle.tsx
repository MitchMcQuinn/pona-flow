import { useLayoutEffect, useRef, type ReactNode } from "react";
import { TouchHint } from "./TouchHint";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

interface SegmentToggleProps<T extends string> {
  labelledBy?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Optional stable test hook; the group gets `${testId}` and options `${testId}-option-{value}`. */
  testId?: string;
}

/** Segmented control with a mesh-border indicator that slides between options. */
export function SegmentToggle<T extends string>({
  labelledBy,
  ariaLabel,
  options,
  value,
  onChange,
  testId
}: SegmentToggleProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const disabledReasons = options.filter((o) => o.disabled && o.title).map((o) => o.title);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const measure = () => {
      const active = group.querySelector<HTMLButtonElement>("button.active");
      if (!active) return;
      group.style.setProperty("--segment-indicator-x", `${active.offsetLeft}px`);
      group.style.setProperty("--segment-indicator-width", `${active.offsetWidth}px`);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [value, options]);

  return (
    <>
    <div
      ref={groupRef}
      className="builderSegmentToggle"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
      data-testid={testId}
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
    {disabledReasons.map((reason) => (
      <TouchHint key={reason} text={reason} />
    ))}
    </>
  );
}
