import { useRef, useState } from "react";
import {
  finalizeAttributiveLabelInput,
  isAttributiveLabelParameter,
  sanitizeAttributiveLabelInput
} from "@pona-flow/authoring";

export type InlineCreateKind = "node" | "parameter";

export function sanitizeNodeLabel(raw: string): string {
  return sanitizeAttributiveLabelInput(raw);
}

export function sanitizeParameterName(raw: string): string {
  const trimmed = raw.trim();
  const body = (trimmed.startsWith("$") ? trimmed.slice(1) : trimmed).replace(/[^A-Za-z0-9_]/g, "");
  return "$" + body;
}

function isValid(kind: InlineCreateKind, value: string): boolean {
  if (kind === "node") return Boolean(value.trim());
  return isAttributiveLabelParameter(value.trim());
}

interface InlineCreateNameFieldProps {
  kind: InlineCreateKind;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export function InlineCreateNameField({
  kind,
  className,
  onCommit,
  onCancel
}: InlineCreateNameFieldProps) {
  const [value, setValue] = useState(kind === "parameter" ? "$" : "");
  const doneRef = useRef(false);
  const sanitize = kind === "node" ? sanitizeNodeLabel : sanitizeParameterName;

  function finish(next: () => void) {
    if (doneRef.current) return;
    doneRef.current = true;
    next();
  }

  function commit() {
    const next = kind === "node" ? finalizeAttributiveLabelInput(value) : sanitize(value);
    if (!isValid(kind, next)) {
      finish(onCancel);
      return;
    }
    finish(() => onCommit(next));
  }

  return (
    <input
      className={className || "builderMono"}
      data-testid="inline-create-name"
      aria-label={kind === "node" ? "attributive_label" : "parameter"}
      autoFocus
      value={value}
      placeholder={kind === "node" ? "name" : "$parameter"}
      onChange={(e) => setValue(sanitize(e.target.value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}
