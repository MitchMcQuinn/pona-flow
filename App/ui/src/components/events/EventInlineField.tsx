import type { ReactNode } from "react";
import { FieldTip } from "../builder/FieldTip";

interface EventInlineFieldProps {
  label: string;
  /** When set, an info mark sits in front of the label. */
  tip?: string;
  htmlFor?: string;
  /** Section title. Stays a heading instead of the regular row label. */
  heading?: "h2" | "h3";
  children?: ReactNode;
}

/**
 * One list row: info mark, "label:", then the control. Rows stack without a
 * label line of their own. The info slot is always reserved so labels line up
 * when a row has no tip.
 */
export function EventInlineField({ label, tip, htmlFor, heading, children }: EventInlineFieldProps) {
  const hasControl = children != null && children !== false;
  const text = heading || !hasControl ? label : `${label}:`;
  const HeadingTag = heading;
  return (
    <div className="eventInlineField">
      <span className="eventInlineFieldTip">{tip ? <FieldTip text={tip} /> : null}</span>
      {HeadingTag ? (
        <HeadingTag className="eventInlineFieldHeading">{text}</HeadingTag>
      ) : htmlFor || hasControl ? (
        <label className="eventInlineFieldLabel" htmlFor={htmlFor}>
          {text}
        </label>
      ) : (
        <span className="eventInlineFieldLabel">{text}</span>
      )}
      {hasControl ? <div className="eventInlineFieldControl">{children}</div> : null}
    </div>
  );
}
