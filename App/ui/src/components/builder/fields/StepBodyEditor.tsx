import { useMemo, useRef } from "react";
import { buildStepBodyHighlightHtml, escapeHtml } from "@pona-flow/authoring";
import type { Parameter } from "../../../state/builder/types";

interface StepBodyEditorProps {
  value: string;
  readOnly: boolean;
  parameters: Parameter[];
  /** Green/yellow $param highlighting; off for meta-workflow / read-only bodies. */
  highlightParameters?: boolean;
  placeholder?: string;
  onChange: (raw: string) => void;
  onBlur?: () => void;
}

export function StepBodyEditor({
  value,
  readOnly,
  parameters,
  highlightParameters = true,
  placeholder,
  onChange,
  onBlur
}: StepBodyEditorProps) {
  const highlightHtml = useMemo(
    () =>
      highlightParameters ? buildStepBodyHighlightHtml(value, parameters) : escapeHtml(value),
    [value, parameters, highlightParameters]
  );
  const highlightRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function syncScroll(from: "input" | "highlight") {
    const input = inputRef.current;
    const highlight = highlightRef.current;
    if (!input || !highlight) return;
    if (from === "input") {
      highlight.scrollTop = input.scrollTop;
      highlight.scrollLeft = input.scrollLeft;
    } else {
      input.scrollTop = highlight.scrollTop;
      input.scrollLeft = highlight.scrollLeft;
    }
  }

  if (readOnly) {
    return (
      <pre
        className="builderMono builderPreviewPre builderStepBodyReadonly"
        dangerouslySetInnerHTML={{ __html: highlightHtml || "&nbsp;" }}
      />
    );
  }

  return (
    <div className="builderStepBodyEditor">
      <pre
        ref={highlightRef}
        className="builderMono builderStepBodyHighlight"
        aria-hidden
        dangerouslySetInnerHTML={{ __html: highlightHtml || "&nbsp;" }}
        onScroll={() => syncScroll("highlight")}
      />
      <textarea
        ref={inputRef}
        className="builderMono builderStepBodyInput"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onScroll={() => syncScroll("input")}
      />
    </div>
  );
}
