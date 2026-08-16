import { useEffect, useState } from "react";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import {
  addPathRelAndNode,
  removePathTail,
  removePattern
} from "../../../state/builder/queryHelpers";
import {
  isRegisteredInSpaceCatalog,
  spaceCatalogLabelKeys
} from "../../../state/builder/attributiveLabelOptions";
import {
  hopGatedByGraphOutgoing,
  lastNodeAttributiveLabelInPattern,
  schemaDrivenHopClause,
  supportsIncomingHop
} from "@pona-flow/authoring";
import { isAttributiveLabelParameter } from "@pona-flow/authoring";
import { isVectorSearchEnabled } from "@pona-flow/composer";
import type { GraphNodeLabel, GraphPattern, Operation } from "../../../state/builder/types";
import { NodePathEntry } from "./NodePathEntry";
import { RelPathEntry } from "./RelPathEntry";

interface PatternProps {
  clauseIndex: number;
  patternIndex: number;
  pattern: GraphPattern;
  label: GraphNodeLabel;
  operation: Operation;
  canRemove: boolean;
}

export function Pattern({
  clauseIndex,
  patternIndex,
  pattern,
  label,
  operation,
  canRemove
}: PatternProps) {
  const { state, patchQuery } = useBuilder();

  const isSchemaCreate = label === "SCHEMA" && operation === "create";
  const lastNodeLabel = lastNodeAttributiveLabelInPattern(pattern);
  // A parameterized trailing node has no concrete outgoing edges to gate against, so
  // the edge-bound hop constraint is lifted and the hop is always offered.
  const lastNodeIsParameter = isAttributiveLabelParameter(lastNodeLabel);
  // INSTANCE/SCHEMA match hops follow SCHEMA outgoing edges; STEP match follows STEP→STEP.
  const gatedHop = hopGatedByGraphOutgoing(label, operation) && !lastNodeIsParameter;
  const useSchemaOutgoingApi = schemaDrivenHopClause(label, operation) && gatedHop;
  const trailingPathIndex = pattern.path.length - 1;
  const trailingIsNode =
    trailingPathIndex >= 0 && pattern.path[trailingPathIndex]?.kind === "node";
  const [outgoingCount, setOutgoingCount] = useState<number | null>(null);

  useEffect(() => {
    if (!gatedHop || !state.spaceId || !lastNodeLabel) {
      setOutgoingCount(gatedHop ? 0 : null);
      return;
    }
    let cancelled = false;
    // Match ops also count incoming edges: a node reachable only via a reverse hop
    // (e.g. VALUE, pointed at by PILLAR) must still offer +hop.
    const load = useSchemaOutgoingApi
      ? connector.fetchSchemaOutgoing({
          spaceId: state.spaceId,
          attributiveLabel: lastNodeLabel,
          includeIncoming: supportsIncomingHop(operation, label)
        })
      : connector.fetchGraphStepOutgoing({ spaceId: state.spaceId, attributiveLabel: lastNodeLabel });
    load
      .then((rows) => {
        if (cancelled) return;
        const catalogKeys = spaceCatalogLabelKeys(state.spaceLabels);
        const count = rows.filter((row) => {
          const relAl =
            "rel_attributive_label" in row
              ? String(row.rel_attributive_label ?? "")
              : "";
          const targetAl =
            "target_attributive_label" in row
              ? String(row.target_attributive_label ?? "")
              : "";
          return (
            isRegisteredInSpaceCatalog(relAl, catalogKeys) &&
            isRegisteredInSpaceCatalog(targetAl, catalogKeys)
          );
        }).length;
        setOutgoingCount(count);
      })
      .catch(() => {
        if (!cancelled) setOutgoingCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [gatedHop, useSchemaOutgoingApi, state.spaceId, state.spaceLabels, lastNodeLabel, operation, label]);

  const showHop = isVectorSearchEnabled(state.query)
    ? false
    : isSchemaCreate
      ? trailingIsNode
      : gatedHop
        ? Boolean(lastNodeLabel) && (outgoingCount ?? 0) > 0
        : trailingIsNode;

  return (
    <div className="builderPattern">
      {pattern.path.map((element, pathIndex) => (
        <div
          className={
            element.kind === "relationship" ? "builderPathEl builderPathElRel" : "builderPathEl"
          }
          key={pathIndex}
        >
          {element.kind === "node" ? (
            <NodePathEntry
              clauseIndex={clauseIndex}
              patternIndex={patternIndex}
              pathIndex={pathIndex}
              node={element.node}
              label={label}
              operation={operation}
            />
          ) : (
            <RelPathEntry
              clauseIndex={clauseIndex}
              patternIndex={patternIndex}
              pathIndex={pathIndex}
              relationship={element.relationship}
              operation={operation}
              label={label}
            />
          )}
        </div>
      ))}

      <div className="builderPatternFooter">
        {showHop && !state.lockedStepRelationship ? (
          <button
            type="button"
            className="builderTinyBtn builderAddBtn"
            onClick={() => patchQuery(addPathRelAndNode(clauseIndex, patternIndex))}
          >
            + hop
          </button>
        ) : null}
        {pattern.path.length > 1 && !state.lockedStepRelationship ? (
          <button
            type="button"
            className="builderTinyBtn"
            onClick={() => patchQuery(removePathTail(clauseIndex, patternIndex))}
          >
            - hop
          </button>
        ) : null}
        {canRemove && !state.lockedStepRelationship ? (
          <button
            type="button"
            className="builderTinyBtn builderDanger"
            onClick={() => patchQuery(removePattern(clauseIndex, patternIndex))}
          >
            Remove pattern
          </button>
        ) : null}
      </div>
    </div>
  );
}
