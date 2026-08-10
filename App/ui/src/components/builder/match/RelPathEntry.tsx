import { isMatchOperation } from "@pona-flow/authoring";
import type {
  GraphNodeLabel,
  Operation,
  RelationshipPattern
} from "../../../state/builder/types";
import {
  InstanceCreateRelCard,
  SchemaCreateRelCard,
  StepCreateRelCard
} from "./pathCards/relCreateCards";
import { ConfigUpdateRelCard, MatchRelCard } from "./pathCards/relMatchCards";

interface RelPathEntryProps {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  relationship: RelationshipPattern;
  operation: Operation;
  label: GraphNodeLabel;
  /** In the graph builder the alias picker is hidden (aliases are implicit). */
  graphMode?: boolean;
}

/**
 * Router over the mode-specific relationship cards (see ./pathCards): one card
 * per operation+label mode, sharing patch/check/alias plumbing via hooks.
 */
export function RelPathEntry({
  clauseIndex,
  patternIndex,
  pathIndex,
  relationship,
  operation,
  label,
  graphMode = false
}: RelPathEntryProps) {
  const cardProps = {
    clauseIndex,
    patternIndex,
    pathIndex,
    relationship,
    operation,
    label,
    graphMode
  };
  const isCreate = operation === "create";

  if (isCreate && label === "STEP") return <StepCreateRelCard {...cardProps} />;
  if (isCreate && label === "INSTANCE") return <InstanceCreateRelCard {...cardProps} />;
  if (isCreate && label === "SCHEMA") return <SchemaCreateRelCard {...cardProps} />;
  // update SCHEMA / STEP edits the selected relationship's config payload (SQLite-only).
  if (operation === "update" && (label === "STEP" || label === "SCHEMA")) {
    return <ConfigUpdateRelCard {...cardProps} />;
  }
  if (isMatchOperation(operation)) return <MatchRelCard {...cardProps} />;
  return null;
}
