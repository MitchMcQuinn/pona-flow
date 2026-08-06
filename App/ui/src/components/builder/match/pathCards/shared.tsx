/**
 * Shared plumbing for the mode-specific path-entry cards.
 *
 * `RelPathEntry` / `NodePathEntry` are thin routers that pick one card per
 * operation+label mode (create-STEP, create-INSTANCE, create-SCHEMA,
 * config-update, match). The hooks/components here hold the behavior every
 * card needs: the graph-mode-aware patch, check clearing, alias collection,
 * the create-INSTANCE id/alias sync, and the WHERE-filters footer.
 */

import { useEffect } from "react";
import { useBuilder } from "../../../../state/builder/BuilderContext";
import {
  collectQueryVariables,
  deriveInstanceAlias,
  instanceKeyIsUid,
  instanceKeyProperty,
  instanceKeyValue
} from "../../../../state/builder/instanceRules";
import { patchForAliasReference } from "../../../../state/builder/matchAlias";
import { pathFiltersVisible } from "../../../../state/builder/pathWhereHelpers";
import {
  updateNode,
  updateRelationship
} from "../../../../state/builder/queryHelpers";
import { isAttributiveLabelParameter } from "../../../../state/builder/normalizeField";
import type {
  GraphNodeLabel,
  NodePattern,
  Operation,
  QueryObject,
  RelationshipPattern
} from "../../../../state/builder/types";
import { AddFiltersToggle } from "../../fields/AddFiltersToggle";
import { PathWhereCard } from "../../where/PathWhereCard";

export interface RelCardProps {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  relationship: RelationshipPattern;
  operation: Operation;
  label: GraphNodeLabel;
  /** In the graph builder the alias picker is hidden (aliases are implicit). */
  graphMode: boolean;
}

export interface NodeCardProps {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  node: NodePattern;
  label: GraphNodeLabel;
  operation: Operation;
  /** In the graph builder the alias picker is hidden (aliases are implicit). */
  graphMode: boolean;
}

/**
 * Graph mode owns the variable (canvas selection key + projection identity);
 * strip any variable re-key/clear from card edits so the entity never drops
 * off the graph.
 */
export function stripGraphVariable<T extends { variable?: string }>(
  p: Partial<T>,
  graphMode: boolean
): Partial<T> {
  if (!graphMode || !("variable" in p)) return p;
  const { variable: _drop, ...rest } = p;
  return rest as Partial<T>;
}

/** Aliases of one kind declared elsewhere in this query (locked + define mode). */
export function collectDeclaredAliases(
  query: QueryObject,
  kind: "node" | "relationship",
  currentVariable: string
): string[] {
  const names: string[] = [];
  query.match.forEach((clause) => {
    clause.patterns.forEach((pattern) => {
      pattern.path.forEach((el) => {
        const entity = el.kind === "node" ? el.node : el.relationship;
        if (
          el.kind === kind &&
          entity.alias_locked &&
          entity.alias_mode === "define" &&
          entity.variable.trim() &&
          entity.variable !== currentVariable
        ) {
          names.push(entity.variable);
        }
      });
    });
  });
  return names;
}

/**
 * Shared per-relationship-card context: builder state, the graph-mode-aware
 * patch, check clearing, and the neighbor node labels that constrain edge
 * pickers (preceding = source, following = target).
 */
export function useRelCard(props: RelCardProps) {
  const { clauseIndex, patternIndex, pathIndex, graphMode } = props;
  const builder = useBuilder();
  const { state, patchQuery, dispatch } = builder;
  const addr = `${clauseIndex}:${patternIndex}:${pathIndex}`;

  const patch = (p: Partial<RelationshipPattern>) => {
    patchQuery(
      updateRelationship(clauseIndex, patternIndex, pathIndex, stripGraphVariable(p, graphMode))
    );
  };

  function clearRelCardChecks() {
    dispatch({ type: "CLEAR_CHECKS", prefix: `gid:${addr}` });
    dispatch({ type: "CLEAR_CHECKS", prefix: `al:${addr}` });
  }

  // The preceding node constrains which outgoing schema edges this relationship
  // may adopt.
  const precedingNode =
    state.query.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex - 1];
  const precedingNodeLabel =
    precedingNode && precedingNode.kind === "node"
      ? precedingNode.node.attributive_label ?? ""
      : "";

  // The following node (this relationship's target) disambiguates sibling edges
  // that share a relationship attributive_label in the STEP edge picker.
  const followingNode =
    state.query.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex + 1];
  const followingNodeLabel =
    followingNode && followingNode.kind === "node"
      ? followingNode.node.attributive_label ?? ""
      : "";

  function chooseExistingRelAlias(name: string) {
    const refPatch = patchForAliasReference(state.query, "relationship", name);
    if (refPatch) patch(refPatch);
  }

  return {
    ...builder,
    addr,
    patch,
    clearRelCardChecks,
    precedingNodeLabel,
    followingNodeLabel,
    chooseExistingRelAlias
  };
}

/**
 * Shared per-node-card context: builder state, the graph-mode-aware patch,
 * check clearing (STEP cards also clear the step-body check), and whether the
 * preceding relationship is a $parameter (which lifts the edge-bound target
 * constraint).
 */
export function useNodeCard(props: NodeCardProps) {
  const { clauseIndex, patternIndex, pathIndex, label, graphMode } = props;
  const builder = useBuilder();
  const { state, patchQuery, dispatch } = builder;
  const addr = `${clauseIndex}:${patternIndex}:${pathIndex}`;

  const patch = (p: Partial<NodePattern>) => {
    patchQuery(
      updateNode(clauseIndex, patternIndex, pathIndex, stripGraphVariable(p, graphMode))
    );
  };

  function clearCardChecks() {
    if (label === "STEP") {
      dispatch({ type: "CLEAR_CHECKS", prefix: `stepBody:${addr}` });
    }
    dispatch({ type: "CLEAR_CHECKS", prefix: `gid:${addr}` });
    dispatch({ type: "CLEAR_CHECKS", prefix: `al:${addr}` });
  }

  // A parameterized preceding relationship has no concrete outgoing edge, so it can't
  // fix this node's attributive_label. In that case the edge-bound constraint is lifted
  // and the node falls back to its normal picker (incl. "+ ADD A PARAMETER").
  const precedingEl =
    pathIndex > 0
      ? state.query.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex - 1]
      : undefined;
  const precedingRelIsParameter =
    precedingEl?.kind === "relationship" &&
    isAttributiveLabelParameter(precedingEl.relationship.attributive_label ?? "");

  function chooseExistingAlias(name: string) {
    const refPatch = patchForAliasReference(state.query, "node", name);
    if (refPatch) patch(refPatch);
  }

  return {
    ...builder,
    addr,
    patch,
    clearCardChecks,
    precedingRelIsParameter,
    chooseExistingAlias
  };
}

/**
 * Clear the gid/al (and optionally stepBody) checks of every path element after
 * `fromPathIndex` — used when an upstream selection change invalidates the
 * downstream chain.
 */
export function clearDownstreamChecks(
  dispatch: ReturnType<typeof useBuilder>["dispatch"],
  query: QueryObject,
  clauseIndex: number,
  patternIndex: number,
  fromPathIndex: number,
  includeStepBody: boolean
): void {
  const pattern = query.match[clauseIndex]?.patterns[patternIndex];
  if (!pattern) return;
  for (let i = fromPathIndex + 1; i < pattern.path.length; i += 1) {
    dispatch({ type: "CLEAR_CHECKS", prefix: `gid:${clauseIndex}:${patternIndex}:${i}` });
    dispatch({ type: "CLEAR_CHECKS", prefix: `al:${clauseIndex}:${patternIndex}:${i}` });
    if (includeStepBody) {
      dispatch({ type: "CLEAR_CHECKS", prefix: `stepBody:${clauseIndex}:${patternIndex}:${i}` });
    }
  }
}

/**
 * Create-INSTANCE id/alias sync (shared by the node and relationship cards).
 *
 * With a run-time-minted UID key (or no key property at all) the author-time
 * id_binding is dropped and the variable defaults to a label-derived alias,
 * which also names the entity's `id__<variable>` run-time parameter. With an
 * author-supplied key the id_binding mirrors the key value and the variable
 * follows it unless an alias is locked.
 *
 * `clearIdWithoutUidKey` matches the historical node/rel difference: node cards
 * drop a stale id_binding whenever one exists; relationship cards only when the
 * key is a UID.
 */
export function useInstanceIdSync(opts: {
  enabled: boolean;
  entity: NodePattern | RelationshipPattern;
  aliasLocked: boolean;
  clearIdWithoutUidKey: boolean;
  query: QueryObject;
  patch: (p: { id_binding?: NodePattern["id_binding"]; variable?: string }) => void;
  deps: readonly unknown[];
}): void {
  const { enabled, entity, aliasLocked, clearIdWithoutUidKey, query, patch } = opts;
  useEffect(() => {
    if (!enabled) return;
    const idVal =
      typeof entity.id_binding?.value === "string" ? entity.id_binding.value.trim() : "";
    const patches: { id_binding?: NodePattern["id_binding"]; variable?: string } = {};
    if (instanceKeyIsUid(entity.properties) || !instanceKeyProperty(entity.properties)) {
      if (idVal && (clearIdWithoutUidKey || instanceKeyIsUid(entity.properties))) {
        patches.id_binding = undefined;
      }
      if (!aliasLocked && !entity.variable.trim()) {
        patches.variable = deriveInstanceAlias(
          entity.attributive_label ?? "",
          collectQueryVariables(query)
        );
      }
    } else {
      const keyVal = instanceKeyValue(entity.properties);
      const wantVar = aliasLocked ? entity.variable : keyVal;
      if (keyVal !== idVal) {
        patches.id_binding = keyVal ? { key: "id", value: keyVal } : undefined;
      }
      if (!aliasLocked && wantVar !== entity.variable) {
        patches.variable = wantVar;
      }
    }
    if (Object.keys(patches).length) patch(patches);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, opts.deps as unknown[]);
}

/**
 * The match cards' WHERE footer: the read-mode "add filters" toggle plus the
 * PathWhereCard, gated identically for nodes and relationships.
 */
export function PathWhereFooter({
  clauseIndex,
  patternIndex,
  pathIndex,
  label,
  operation,
  entityRole,
  entity,
  show,
  onToggleFilters
}: {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  label: GraphNodeLabel;
  operation: Operation;
  entityRole: "node" | "relationship";
  entity: NodePattern | RelationshipPattern;
  show: boolean;
  onToggleFilters: (checked: boolean) => void;
}) {
  const { createSequenceMode } = useBuilder();
  const isReadMatch = operation === "read";
  const filtersVisible = pathFiltersVisible(entity);
  return (
    <>
      {isReadMatch && show && !createSequenceMode ? (
        <AddFiltersToggle checked={filtersVisible} onChange={onToggleFilters} />
      ) : null}

      {show && (!isReadMatch || filtersVisible) ? (
        <PathWhereCard
          clauseIndex={clauseIndex}
          patternIndex={patternIndex}
          pathIndex={pathIndex}
          clauseLabel={label}
          entityRole={entityRole}
          attributiveLabel={entity.attributive_label ?? ""}
          entity={entity}
        />
      ) : null}
    </>
  );
}
