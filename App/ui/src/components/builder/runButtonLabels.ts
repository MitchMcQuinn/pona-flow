import type { GraphNodeLabel, Operation } from "../../state/builder/types";

const LABEL_NOUN: Record<GraphNodeLabel, string> = {
  STEP: "step",
  SCHEMA: "schema",
  INSTANCE: "instance"
};

const OP_VERB: Record<Operation, { idle: string; busy: string }> = {
  create: { idle: "Create", busy: "Creating" },
  read: { idle: "Read", busy: "Reading" },
  update: { idle: "Update", busy: "Updating" },
  delete: { idle: "Delete", busy: "Deleting" }
};

/** True when the run button should use the destructive (red) style. */
export function isDestructiveRunButton(operation: Operation): boolean {
  return operation === "delete";
}

/**
 * Label for the builder run button: "{Operation} {label}" (e.g. "Read schema",
 * "Create step"). Delete idle labels include a trailing ellipsis ("Delete schema…").
 */
export function runButtonLabel(
  operation: Operation,
  clauseLabel: GraphNodeLabel | undefined,
  options: { busy?: boolean } = {}
): string {
  const noun = (clauseLabel && LABEL_NOUN[clauseLabel]) || "pattern";
  const verb = OP_VERB[operation];
  if (options.busy) return `${verb.busy}…`;
  const ellipsis = operation === "delete" ? "…" : "";
  return `${verb.idle} ${noun}${ellipsis}`;
}
