import { isMatchOperation } from "@pona-flow/authoring";
import type { GraphNodeLabel, NodePattern, Operation } from "../../../state/builder/types";
import {
  InstanceCreateNodeCard,
  PickerCreateNodeCard
} from "./pathCards/nodeCreateCards";
import { ConfigUpdateNodeCard, MatchNodeCard } from "./pathCards/nodeMatchCards";

interface NodePathEntryProps {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  node: NodePattern;
  label: GraphNodeLabel;
  operation: Operation;
  /** In the graph builder the alias picker is hidden (aliases are implicit). */
  graphMode?: boolean;
}

/**
 * Router over the mode-specific node cards (see ./pathCards): one card per
 * operation+label mode, sharing patch/check/alias plumbing via hooks.
 */
export function NodePathEntry({
  clauseIndex,
  patternIndex,
  pathIndex,
  node,
  label,
  operation,
  graphMode = false
}: NodePathEntryProps) {
  const cardProps = { clauseIndex, patternIndex, pathIndex, node, label, operation, graphMode };
  const isCreate = operation === "create";

  if (isCreate && label === "INSTANCE") return <InstanceCreateNodeCard {...cardProps} />;
  // STEP and SCHEMA create share the picker-driven attributive_label / alias / id flow.
  if (isCreate && (label === "STEP" || label === "SCHEMA")) {
    return <PickerCreateNodeCard {...cardProps} />;
  }
  // update SCHEMA / STEP edits the selected entity's config payload (SQLite-only).
  if (operation === "update" && (label === "STEP" || label === "SCHEMA")) {
    return <ConfigUpdateNodeCard {...cardProps} />;
  }
  if (isMatchOperation(operation)) return <MatchNodeCard {...cardProps} />;
  return null;
}
