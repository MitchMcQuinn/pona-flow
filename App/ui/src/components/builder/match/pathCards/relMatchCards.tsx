/**
 * Config-update and match-mode relationship cards, routed to from RelPathEntry.
 * Shared plumbing (patch, check clearing, neighbor labels, WHERE footer) lives
 * in ./shared.
 */

import connector from "../../../../services/connector";
import type { SchemaOutgoingEdge, StepOutgoingEdge } from "../../../../services/connector";
import { attributiveLabelChanged } from "../../../../state/builder/cardReset";
import {
  collectLockedDefineAliases,
  defaultMatchNodeAlias,
  defaultMatchRelationshipAlias,
  filterAliasReferencesForRequiredAttributiveLabel,
  isAliasReference,
  isAliasSet,
  MATCH_ALIAS_DEFAULT_PLACEHOLDER,
  matchCardTitleAlias,
  patchForAliasReference
} from "../../../../state/builder/matchAlias";
import {
  isLabelOnlyMatch,
  supportsIncomingHop,
  supportsOptionalHop
} from "../../../../state/builder/matchMode";
import {
  normalizeAlias,
  normalizeAttributiveLabel
} from "../../../../state/builder/normalizeField";
import {
  addSchemaProperty,
  clampTraversalDepth,
  clearPathAttributiveLabelsAfter,
  hopForcedMode,
  MAX_TRAVERSAL_DEPTH,
  relationshipHasVariableLength,
  relationshipHopMode,
  setRelationshipHopMode,
  setRelationshipLength,
  updateNode,
  updateRelationship,
  type HopMode
} from "../../../../state/builder/queryHelpers";
import { propertiesFromSchemata } from "../../../../state/builder/schemaRules";
import { parametersFromEntityRows } from "../../../../state/builder/stepEntityLoad";
import type { QueryObject, RelationshipPattern } from "../../../../state/builder/types";
import { PropertyBinding } from "../../PropertyBinding";
import { AliasField } from "../../fields/AliasField";
import { InstanceRelAttributiveField } from "../../fields/InstanceRelAttributiveField";
import { MatchRelAttributiveLabelField } from "../../fields/MatchRelAttributiveLabelField";
import { MatchStepRelAttributiveLabelField } from "../../fields/MatchStepRelAttributiveLabelField";
import { StepRelConditionField } from "../../fields/StepRelConditionField";
import {
  clearDownstreamChecks,
  PathWhereFooter,
  useRelCard,
  type RelCardProps
} from "./shared";

// ---- update SCHEMA / STEP: edit the selected relationship's config payload (SQLite-only) ----
export function ConfigUpdateRelCard(props: RelCardProps) {
  const { clauseIndex, patternIndex, pathIndex, relationship, label } = props;
  const {
    state,
    patchQuery,
    patch,
    clearRelCardChecks,
    precedingNodeLabel,
    followingNodeLabel
  } = useRelCard(props);

  // The end node of a STEP/SCHEMA relationship is fixed by the edge (e.g.
  // PRODUCES → PRODUCT forces PRODUCT), so selecting the relationship also pins and
  // loads the following node's config.
  function selectConfigStepRel(_al: string, edge: StepOutgoingEdge) {
    clearRelCardChecks();
    patch({
      attributive_label: edge.rel_attributive_label,
      node_source: "existing",
      id_binding: { key: "id", value: edge.rel_id },
      variable: edge.rel_id,
      alias_locked: true,
      condition_type: (edge.condition_type as RelationshipPattern["condition_type"]) || "null",
      condition: edge.condition || "",
      condition_expected: edge.condition_expected,
      properties: []
    });

    const spaceId = state.spaceId ?? "";
    const following = state.query.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex + 1];
    if (following?.kind !== "node" || !spaceId) return;
    connector
      .fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" })
      .then((rows) => {
        const targetRow = rows.find((r) => r.attributive_label === edge.target_attributive_label);
        patchQuery((q) => {
          let next = updateNode(clauseIndex, patternIndex, pathIndex + 1, {
            attributive_label: edge.target_attributive_label,
            node_source: "existing",
            id_binding: { key: "id", value: edge.target_id },
            variable: edge.target_id,
            alias_locked: true,
            sequencial_properties: targetRow?.sequencial_properties ?? {},
            properties: []
          })(q);
          const loaded = parametersFromEntityRows(targetRow?.parameters);
          if (loaded.length) {
            const byName = new Map(next.parameters.map((p) => [p.name, p]));
            loaded.forEach((p) => byName.set(p.name, p));
            next = { ...next, parameters: Array.from(byName.values()) };
          }
          return next;
        });
      })
      .catch(() => undefined);
  }

  function selectConfigSchemaRel(edge: SchemaOutgoingEdge) {
    clearRelCardChecks();
    patchQuery((q) => {
      // Existing properties are structurally locked on update (name/type/format frozen); the
      // editor still allows toggling label/required/indexed and editing default_value.
      const relProperties = propertiesFromSchemata(edge.rel_schemata)
        .filter((p) => !p.schematic_properties?.is_key)
        .map((p) => ({ ...p, locked: true }));
      let next = updateRelationship(clauseIndex, patternIndex, pathIndex, {
        attributive_label: edge.rel_attributive_label,
        node_source: "existing",
        id_binding: { key: "id", value: edge.rel_id },
        variable: edge.rel_id,
        alias_locked: true,
        properties: relProperties
      })(q);
      const following = next.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex + 1];
      if (following?.kind === "node") {
        const targetProperties = propertiesFromSchemata(edge.target_schemata)
          .filter((p) => !p.schematic_properties?.is_key)
          .map((p) => ({ ...p, locked: true }));
        next = updateNode(clauseIndex, patternIndex, pathIndex + 1, {
          attributive_label: edge.target_attributive_label,
          node_source: "existing",
          id_binding: { key: "id", value: edge.target_id },
          variable: edge.target_id,
          alias_locked: true,
          properties: targetProperties
        })(next);
      }
      return next;
    });
  }

  const hasAttributiveLabel = Boolean(relationship.attributive_label?.trim());
  // Editing a single relationship loaded from the visualizer: its identity is fixed (bound by
  // graph id) so the picker is read-only — only the guard condition below stays editable.
  const lockedRelEdit = state.lockedStepRelationship;
  return (
    <div className="builderCard">
      <div className="builderHeadRow">
        <strong className="builderMono">
          relationship{relationship.variable ? ` (${relationship.variable})` : ""}
        </strong>
      </div>

      {lockedRelEdit ? (
        <div className="builderField">
          <label>attributive_label</label>
          <input
            readOnly
            value={relationship.attributive_label ?? ""}
            className="builderMono"
          />
        </div>
      ) : label === "STEP" ? (
        <MatchStepRelAttributiveLabelField
          parentAttributiveLabel={precedingNodeLabel}
          attributiveLabel={relationship.attributive_label ?? ""}
          targetAttributiveLabel={followingNodeLabel}
          onSelect={selectConfigStepRel}
          onSelectParameter={() => undefined}
        />
      ) : (
        <InstanceRelAttributiveField
          parentAttributiveLabel={precedingNodeLabel}
          attributiveLabel={relationship.attributive_label ?? ""}
          disabled={false}
          onSelect={selectConfigSchemaRel}
          onSelectParameter={() => undefined}
        />
      )}

      {hasAttributiveLabel && label === "STEP" ? (
        <StepRelConditionField relationship={relationship} readOnly={false} onPatch={patch} />
      ) : null}

      {hasAttributiveLabel && label === "SCHEMA" ? (
        <div className="builderBlock">
          {relationship.properties.map((prop, propIndex) => (
            <PropertyBinding
              key={propIndex}
              clauseIndex={clauseIndex}
              patternIndex={patternIndex}
              pathIndex={pathIndex}
              propIndex={propIndex}
              prop={prop}
              schemaMode
              canDelete
            />
          ))}
          <div className="builderCardFooter">
            <button
              type="button"
              className="builderTinyBtn builderAddBtn"
              onClick={() => patchQuery(addSchemaProperty(clauseIndex, patternIndex, pathIndex))}
            >
              + property
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---- read / update / delete match relationships ----
export function MatchRelCard(props: RelCardProps) {
  const { clauseIndex, patternIndex, pathIndex, relationship, operation, label, graphMode } = props;
  const {
    state,
    patchQuery,
    dispatch,
    patch,
    clearRelCardChecks,
    precedingNodeLabel,
    followingNodeLabel
  } = useRelCard(props);

  function matchRelAliasPatch(
    attributiveLabel: string,
    q: QueryObject
  ): Partial<RelationshipPattern> {
    // Graph mode keeps the synthetic variable stable so the canvas selection survives an
    // attributive_label change (see the node match card for the matching rationale).
    if (relationship.alias_locked || graphMode) {
      return { attributive_label: attributiveLabel, properties: [] };
    }
    return {
      attributive_label: attributiveLabel,
      properties: [],
      variable: defaultMatchRelationshipAlias(q, attributiveLabel, {
        clauseIndex,
        patternIndex,
        pathIndex
      }),
      alias_mode: "define" as const,
      alias_locked: false,
      alias_ref: undefined
    };
  }

  function chooseMatchRelAlias(name: string) {
    const normalized = normalizeAlias(name);
    const refPatch = patchForAliasReference(state.query, "relationship", normalized);
    if (refPatch) {
      patch(refPatch);
      return;
    }
    patch({ variable: normalized, alias_mode: "define", alias_locked: true });
  }

  function createMatchRelAlias(name: string) {
    chooseMatchRelAlias(name);
  }

  function clearDownstream() {
    clearDownstreamChecks(dispatch, state.query, clauseIndex, patternIndex, pathIndex, false);
  }

  function selectMatchInstanceEdge(edge: SchemaOutgoingEdge) {
    const relLabelChanged = attributiveLabelChanged(
      relationship.attributive_label,
      edge.rel_attributive_label
    );
    if (relLabelChanged) clearRelCardChecks();
    // Reverse hops (edge points AT the preceding node) compose as <-[...]- via direction.
    patch({
      ...matchRelAliasPatch(edge.rel_attributive_label, state.query),
      direction: edge.direction === "incoming" ? "incoming" : "outgoing"
    });
    const following = state.query.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex + 1];
    const targetNode = following?.kind === "node" ? following.node : undefined;
    const targetLabelChanged =
      targetNode &&
      attributiveLabelChanged(targetNode.attributive_label, edge.target_attributive_label);
    if (targetLabelChanged) {
      dispatch({
        type: "CLEAR_CHECKS",
        prefix: `gid:${clauseIndex}:${patternIndex}:${pathIndex + 1}`
      });
    }
    const targetPatch =
      targetNode?.alias_locked || graphMode
        ? { attributive_label: edge.target_attributive_label, properties: [] }
        : {
            attributive_label: edge.target_attributive_label,
            properties: [],
            variable: defaultMatchNodeAlias(edge.target_attributive_label),
            alias_mode: "define" as const,
            alias_locked: false,
            alias_ref: undefined
          };
    patchQuery(updateNode(clauseIndex, patternIndex, pathIndex + 1, targetPatch));
  }

  function selectMatchSchemaRel(al: string) {
    const normalized = normalizeAttributiveLabel(al);
    if (!attributiveLabelChanged(relationship.attributive_label, normalized)) return;
    clearRelCardChecks();
    clearDownstream();
    patchQuery((q) => {
      const cleared = clearPathAttributiveLabelsAfter(clauseIndex, patternIndex, pathIndex, {
        preserveIdentity: graphMode
      })(q);
      return updateRelationship(
        clauseIndex,
        patternIndex,
        pathIndex,
        matchRelAliasPatch(normalized, cleared)
      )(cleared);
    });
  }

  function selectMatchStepRel(_al: string, edge: StepOutgoingEdge) {
    // Bind the edge's real relationship label, never the picker's disambiguation
    // value (e.g. "NEXT_STEP|TARGET" for siblings sharing a label) — normalizing
    // that would strip the "|" and mangle the label into a non-existent type.
    const relAttributiveLabel = edge.rel_attributive_label;
    const currentFollowing =
      state.query.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex + 1];
    const currentTarget =
      currentFollowing?.kind === "node" ? currentFollowing.node.attributive_label ?? "" : "";
    const relChanged = attributiveLabelChanged(relationship.attributive_label, relAttributiveLabel);
    const targetChanged = attributiveLabelChanged(currentTarget, edge.target_attributive_label);
    // Siblings share a rel label, so detect a change via the target too — otherwise
    // switching between same-label edges (different targets) would be a no-op.
    if (!relChanged && !targetChanged) return;
    clearRelCardChecks();
    clearDownstream();
    patchQuery((q) => {
      let next = clearPathAttributiveLabelsAfter(clauseIndex, patternIndex, pathIndex, {
        preserveIdentity: graphMode
      })(q);
      next = updateRelationship(
        clauseIndex,
        patternIndex,
        pathIndex,
        matchRelAliasPatch(relAttributiveLabel, next)
      )(next);
      const following = next.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex + 1];
      if (following?.kind === "node") {
        const targetAl = edge.target_attributive_label;
        const targetPatch = following.node.alias_locked || graphMode
          ? { attributive_label: targetAl, properties: [] }
          : {
              attributive_label: targetAl,
              properties: [],
              variable: defaultMatchNodeAlias(targetAl),
              alias_mode: "define" as const,
              alias_locked: false,
              alias_ref: undefined
            };
        next = updateNode(clauseIndex, patternIndex, pathIndex + 1, targetPatch)(next);
      }
      return next;
    });
  }

  // Match (INSTANCE / SCHEMA / STEP): set the relationship attributive_label to a
  // $parameter. The target node can't be derived from a parameter, so it is left
  // untouched (any stale downstream labels are cleared).
  function selectMatchRelParameter(param: string) {
    if (!attributiveLabelChanged(relationship.attributive_label, param)) return;
    clearRelCardChecks();
    clearDownstream();
    patchQuery((q) => {
      const cleared = clearPathAttributiveLabelsAfter(clauseIndex, patternIndex, pathIndex, {
        preserveIdentity: graphMode
      })(q);
      return updateRelationship(
        clauseIndex,
        patternIndex,
        pathIndex,
        matchRelAliasPatch(param, cleared)
      )(cleared);
    });
  }

  const matchAliasLocked = relationship.alias_locked === true;
  const matchIsReference = isAliasReference(relationship);
  const hasAttributiveLabel = Boolean(relationship.attributive_label?.trim());
  const titleAlias = matchCardTitleAlias(relationship.variable, hasAttributiveLabel);
  const matchAliasNames = collectLockedDefineAliases(state.query, "relationship", {
    clauseIndex,
    patternIndex,
    pathIndex
  });
  const matchAliasOptions = filterAliasReferencesForRequiredAttributiveLabel(
    state.query,
    "relationship",
    matchAliasNames,
    relationship.attributive_label ?? ""
  );
  const hasVariableLength = relationshipHasVariableLength(relationship);
  // Read/delete STEP/SCHEMA identifies targets by attributive_label only — no WHERE card.
  // A variable-length alias binds a list of relationships, so its per-hop WHERE
  // filters (alias.prop predicates) would be invalid Cypher — no WHERE card either.
  const showPathWhere =
    !matchIsReference &&
    hasAttributiveLabel &&
    Boolean(relationship.variable?.trim()) &&
    !isLabelOnlyMatch(operation, label) &&
    !hasVariableLength;
  // Hop mode (required / optional / must not exist): read SCHEMA/INSTANCE only
  // (READ STEP needs one concrete entry point).
  const showHopMode =
    supportsOptionalHop(operation, label) && !matchIsReference && hasAttributiveLabel;
  const forcedMode = hopForcedMode(
    state.query.match[clauseIndex]?.patterns[patternIndex],
    pathIndex
  );
  const hopMode: HopMode = forcedMode ?? relationshipHopMode(relationship);
  // Depth (variable-length traversal): match SCHEMA/INSTANCE hops in required mode
  // only — optional/absent hops keep the OPTIONAL MATCH / NOT EXISTS splitting
  // logic untouched, and STEP paths need concrete single hops.
  const showDepth =
    (label === "INSTANCE" || label === "SCHEMA") &&
    !matchIsReference &&
    hasAttributiveLabel &&
    hopMode === "required";

  function patchDepthBounds(minRaw: string, maxRaw: string) {
    const min = clampTraversalDepth(minRaw) ?? 0;
    const max = clampTraversalDepth(maxRaw);
    patchQuery(
      setRelationshipLength(clauseIndex, patternIndex, pathIndex, {
        min,
        // Keep the range coherent while typing: an entered max below min snaps up.
        max: max !== undefined && max < min ? min : max
      })
    );
  }

  return (
    <div className="builderCard">
      <div className="builderHeadRow">
        <strong className="builderMono">
          relationship{titleAlias ? ` (${titleAlias})` : ""}
        </strong>
      </div>

      {!matchIsReference && (label === "INSTANCE" || label === "SCHEMA") ? (
        <InstanceRelAttributiveField
          parentAttributiveLabel={precedingNodeLabel}
          attributiveLabel={relationship.attributive_label ?? ""}
          direction={relationship.direction}
          includeIncoming={supportsIncomingHop(operation, label)}
          disabled={matchAliasLocked}
          onSelect={selectMatchInstanceEdge}
          onSelectParameter={selectMatchRelParameter}
        />
      ) : !matchIsReference && label === "STEP" ? (
        <MatchStepRelAttributiveLabelField
          parentAttributiveLabel={precedingNodeLabel}
          attributiveLabel={relationship.attributive_label ?? ""}
          targetAttributiveLabel={followingNodeLabel}
          disabled={matchAliasLocked}
          onSelect={selectMatchStepRel}
          onSelectParameter={selectMatchRelParameter}
        />
      ) : !matchIsReference ? (
        <MatchRelAttributiveLabelField
          attributiveLabel={relationship.attributive_label ?? ""}
          disabled={matchAliasLocked}
          onSelect={selectMatchSchemaRel}
        />
      ) : null}

      {!isAliasSet(relationship) && !graphMode ? (
        <AliasField
          aliasName={relationship.variable}
          effectiveAlias=""
          placeholder={MATCH_ALIAS_DEFAULT_PLACEHOLDER}
          locked={matchAliasLocked}
          available={matchAliasOptions}
          canCreate={hasAttributiveLabel}
          onCreate={createMatchRelAlias}
          onChooseExisting={chooseMatchRelAlias}
        />
      ) : null}

      {showHopMode ? (
        <div
          className="builderAddFiltersRow"
          title={
            forcedMode === "optional"
              ? "An earlier hop in this path is optional, so this hop is optional too."
              : forcedMode === "absent"
                ? "An earlier hop in this path must not exist, so this hop is part of that excluded pattern."
                : "required: anchor nodes must have this hop. optional: anchor nodes without this hop still return (OPTIONAL MATCH). must not exist: only anchor nodes WITHOUT this hop return (NOT EXISTS)."
          }
        >
          <label className="builderToggleLabel">
            hop mode{" "}
            <select
              value={hopMode}
              disabled={forcedMode !== null}
              onChange={(e) => {
                const mode = e.target.value as HopMode;
                patchQuery((q) => {
                  let next = setRelationshipHopMode(
                    clauseIndex,
                    patternIndex,
                    pathIndex,
                    mode
                  )(q);
                  // Depth is a required-hop feature; leaving required drops the range
                  // so the optional/absent splitting logic never sees one.
                  if (mode !== "required") {
                    next = setRelationshipLength(
                      clauseIndex,
                      patternIndex,
                      pathIndex,
                      undefined
                    )(next);
                  }
                  return next;
                });
              }}
            >
              <option value="required">required</option>
              <option value="optional">optional</option>
              <option value="absent">must not exist</option>
            </select>
          </label>
        </div>
      ) : null}

      {showDepth ? (
        <div
          className="builderAddFiltersRow"
          title={
            "single hop: matches exactly one relationship. range: variable-length traversal " +
            `(*min..max) following this relationship type up to ${MAX_TRAVERSAL_DEPTH} hops; ` +
            "empty max = unbounded. min 0 includes the anchor node itself."
          }
        >
          <label className="builderToggleLabel">
            depth{" "}
            <select
              value={hasVariableLength ? "range" : "single"}
              onChange={(e) =>
                patchQuery(
                  setRelationshipLength(
                    clauseIndex,
                    patternIndex,
                    pathIndex,
                    e.target.value === "range" ? { min: 1, max: 5 } : undefined
                  )
                )
              }
            >
              <option value="single">single hop</option>
              <option value="range">range</option>
            </select>
          </label>
          {hasVariableLength ? (
            <>
              <label className="builderToggleLabel">
                min{" "}
                <input
                  className="builderMono"
                  type="number"
                  min={0}
                  max={MAX_TRAVERSAL_DEPTH}
                  step={1}
                  style={{ width: "4.5em" }}
                  value={String(relationship.length?.min ?? "")}
                  onChange={(e) =>
                    patchDepthBounds(e.target.value, String(relationship.length?.max ?? ""))
                  }
                />
              </label>
              <label className="builderToggleLabel">
                max{" "}
                <input
                  className="builderMono"
                  type="number"
                  min={0}
                  max={MAX_TRAVERSAL_DEPTH}
                  step={1}
                  placeholder="∞"
                  style={{ width: "4.5em" }}
                  value={String(relationship.length?.max ?? "")}
                  onChange={(e) =>
                    patchDepthBounds(String(relationship.length?.min ?? ""), e.target.value)
                  }
                />
              </label>
            </>
          ) : null}
        </div>
      ) : null}

      <PathWhereFooter
        clauseIndex={clauseIndex}
        patternIndex={patternIndex}
        pathIndex={pathIndex}
        label={label}
        operation={operation}
        entityRole="relationship"
        entity={relationship}
        show={showPathWhere}
        onToggleFilters={(checked) => patch({ where_enabled: checked })}
      />
    </div>
  );
}
