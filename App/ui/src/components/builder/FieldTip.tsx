import { useId, type ReactNode } from "react";

export function FieldTip({ text }: { text: string }) {
  const tipId = useId();
  return (
    <span className="builderTip">
      <button type="button" className="builderTipMark" aria-label="More information" aria-describedby={tipId}>
        ?
      </button>
      <span id={tipId} className="builderTipBubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

export function FieldLabel({
  htmlFor,
  tip,
  children
}: {
  htmlFor?: string;
  tip?: string;
  children: ReactNode;
}) {
  return (
    <div className="createSequenceLabelRow">
      <label htmlFor={htmlFor}>{children}</label>
      {tip ? <FieldTip text={tip} /> : null}
    </div>
  );
}
