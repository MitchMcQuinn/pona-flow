/**
 * Config-update and match-mode node cards, routed to from NodePathEntry.
 * Shared plumbing (patch, check clearing, preceding-parameter detection,
 * WHERE footer) lives in ./shared.
 */

import connector from "../../../../services/connector";
import type { GraphNodeRow } from "../../../../services/connector";
import { attributiveLabelChanged } from "../../../../state/builder/cardReset";
import {
  collectLockedDefineAliases,
  defaultMatchNodeAlias,
  filterAliasReferencesForRequiredAttributiveLabel,
  isAliasReference,
  isAliasSet,
  MATCH_ALIAS_DEFAULT_PLACEHOLDER,
  matchCardTitleAlias,
  patchForAliasReference
} from "@pona-flow/authoring";
import {
  isLabelOnlyMatch,
  matchPickerNodeLabel
} from "@pona-flow/authoring";
import {
  normalizeAlias,
  normalizeAttributiveLabel
} from "@pona-flow/authoring";
import {
  addSchemaProperty,
  clearPathAttributiveLabelsAfter,
  updateNode
} from "../../../../state/builder/queryHelpers";
import { propertiesFromSchemata } from "@pona-flow/authoring";
import { loadStepNodeIntoQuery } from "../../../../state/builder/stepEntityLoad";
import type { NodePattern } from "../../../../state/builder/types";
import { PropertyBinding } from "../../PropertyBinding";
import { AliasField } from "../../fields/AliasField";
import { InstanceNodeAttributiveField } from "../../fields/InstanceNodeAttributiveField";
import { MatchAttributiveLabelField } from "../../fields/MatchAttributiveLabelField";
import { StepSequencialConfig } from "../../fields/StepSequencialConfig";
import { UpdateStepNodeField } from "../../fields/UpdateStepNodeField";
import { VectorizedField } from "../../fields/VectorizedField";
import {
  clearDownstreamChecks,
  PathWhereFooter,
  useNodeCard,
  type NodeCardProps
} from "./shared";

// ---- update SCHEMA / STEP: edit the selected entity's config payload (SQLite-only) ----
export function ConfigUpdateNodeCard(props: NodeCardProps) {
  const { clauseIndex, patternIndex, pathIndex, node, label } = props;
  const { state, patchQuery, patch, clearCardChecks, precedingRelIsParameter, addr } =
    useNodeCard(props);

  // Load an existing custom-endpoint STEP node's full HTTP template + input parameters
  // into the editable config card and target it by id for the SQLite UPDATE.
  function selectUpdateStepNode(row: GraphNodeRow) {
    clearCardChecks();
    patchQuery(loadStepNodeIntoQuery(row, { clauseIndex, patternIndex, pathIndex }));
  }

  // Load an existing SCHEMA node's property schemata into editable property rows and
  // target it by its graph id for the SQLite UPDATE.
  function selectUpdateSchemaNode(attributiveLabel: string) {
    const spaceId = state.spaceId ?? "";
    if (!spaceId) return;
    clearCardChecks();
    connector
      .fetchSchemaDefinition({ spaceId, attributiveLabel })
      .then((def) => {
        // Existing properties are immutable on update (add/delete-only): mark them locked so
        // the editor renders them read-only. Newly added rows stay editable.
        const properties = propertiesFromSchemata(def.schemata)
          .filter((p) => !p.schematic_properties?.is_key)
          .map((p) => ({ ...p, locked: true }));
        patch({
          attributive_label: attributiveLabel,
          node_source: "existing",
          id_binding: { key: "id", value: def.schema_id },
          variable: def.schema_id || attributiveLabel,
          alias_locked: true,
          is_vectorized: def.is_vectorized === true,
          properties
        });
      })
      .catch(() => undefined);
  }

  const hasAttributiveLabel = Boolean(node.attributive_label?.trim());
  const isStepConfig = label === "STEP";
  // End nodes of a concrete preceding relationship are fixed by the edge (and loaded
  // by the relationship picker), so their attributive_label is read-only here too.
  const isConfigTarget = pathIndex > 0 && !precedingRelIsParameter;
  // When editing a single relationship (loaded from the visualizer), the start/end nodes are
  // only context for the relationship — lock them read-only so the author edits the edge alone.
  const lockedRelEdit = state.lockedStepRelationship;
  const stepConfigReady =
    hasAttributiveLabel &&
    Boolean(node.sequencial_properties) &&
    !node.sequencial_properties?.query_id;
  return (
    <div className="builderCard">
      <div className="builderHeadRow">
        <strong className="builderMono">
          node{hasAttributiveLabel ? ` (${node.attributive_label})` : ""}
        </strong>
      </div>

      {isConfigTarget || lockedRelEdit ? (
        <div className="builderField">
          <label>attributive_label</label>
          <input
            readOnly
            value={node.attributive_label ?? ""}
            placeholder="(set by relationship)"
            className="builderMono"
          />
        </div>
      ) : isStepConfig ? (
        <UpdateStepNodeField
          attributiveLabel={node.attributive_label ?? ""}
          onSelect={selectUpdateStepNode}
        />
      ) : (
        <MatchAttributiveLabelField
          fetchLabel="SCHEMA"
          attributiveLabel={node.attributive_label ?? ""}
          requireSpaceCatalog
          allowParameter={false}
          onSelect={selectUpdateSchemaNode}
        />
      )}

      {stepConfigReady && !lockedRelEdit ? (
        <StepSequencialConfig node={node} onPatch={patch} bodyCheckKey={`stepBody:${addr}`} />
      ) : null}

      {!isStepConfig && hasAttributiveLabel && !lockedRelEdit ? (
        <div className="builderBlock">
          <VectorizedField
            clauseIndex={clauseIndex}
            patternIndex={patternIndex}
            pathIndex={pathIndex}
            checked={node.is_vectorized === true}
          />
          {node.properties.map((prop, propIndex) => (
            <PropertyBinding
              key={propIndex}
              clauseIndex={clauseIndex}
              patternIndex={patternIndex}
              pathIndex={pathIndex}
              propIndex={propIndex}
              prop={prop}
              schemaMode
              canDelete
              locked={Boolean(prop.locked)}
              vectorized={node.is_vectorized === true}
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

// ---- read / update / delete match nodes ----
export function MatchNodeCard(props: NodeCardProps) {
  const { clauseIndex, patternIndex, pathIndex, node, label, operation, graphMode } = props;
  const { state, patchQuery, dispatch, patch, clearCardChecks, precedingRelIsParameter } =
    useNodeCard(props);

  const matchFetchLabel = matchPickerNodeLabel(label);
  const isInstanceTargetMatch =
    label === "INSTANCE" && pathIndex > 0 && !precedingRelIsParameter;
  const isStepHopTargetMatch =
    label === "STEP" && pathIndex > 0 && !precedingRelIsParameter;
  // SCHEMA (and STEP) end nodes are fixed by the preceding relationship's edge
  // (e.g. PRODUCES → PRODUCT forces PRODUCT), so their attributive_label is read-only.
  const isSchemaTargetMatch =
    label === "SCHEMA" && pathIndex > 0 && !precedingRelIsParameter;

  function matchNodeAliasPatch(attributiveLabel: string): Partial<NodePattern> {
    // In graph mode the variable is a stable synthetic id that the canvas selection keys
    // off of, so never re-derive it from the attributive_label (that would silently
    // deselect the node). Aliases are implicit here anyway.
    if (node.alias_locked || graphMode) {
      return { attributive_label: attributiveLabel, properties: [] };
    }
    return {
      attributive_label: attributiveLabel,
      properties: [],
      variable: defaultMatchNodeAlias(attributiveLabel),
      alias_mode: "define" as const,
      alias_locked: false,
      alias_ref: undefined
    };
  }

  function chooseMatchNodeAlias(name: string) {
    const normalized = normalizeAlias(name);
    const refPatch = patchForAliasReference(state.query, "node", normalized);
    if (refPatch) {
      patch(refPatch);
      return;
    }
    patch({ variable: normalized, alias_mode: "define", alias_locked: true });
  }

  function createMatchNodeAlias(name: string) {
    chooseMatchNodeAlias(name);
  }

  function clearDownstream() {
    clearDownstreamChecks(
      dispatch,
      state.query,
      clauseIndex,
      patternIndex,
      pathIndex,
      label === "STEP"
    );
  }

  function selectMatchStepNode(al: string) {
    const normalized = normalizeAttributiveLabel(al);
    if (!attributiveLabelChanged(node.attributive_label, normalized)) return;
    clearCardChecks();
    clearDownstream();
    patchQuery((q) => {
      const cleared = clearPathAttributiveLabelsAfter(clauseIndex, patternIndex, pathIndex, {
        preserveIdentity: graphMode
      })(q);
      return updateNode(
        clauseIndex,
        patternIndex,
        pathIndex,
        matchNodeAliasPatch(normalized)
      )(cleared);
    });
  }

  function selectMatchSchemaNode(al: string) {
    const normalized = normalizeAttributiveLabel(al);
    if (!attributiveLabelChanged(node.attributive_label, normalized)) return;
    clearCardChecks();
    clearDownstream();
    patchQuery((q) => {
      const cleared = clearPathAttributiveLabelsAfter(clauseIndex, patternIndex, pathIndex, {
        preserveIdentity: graphMode
      })(q);
      return updateNode(clauseIndex, patternIndex, pathIndex, matchNodeAliasPatch(normalized))(
        cleared
      );
    });
  }

  function selectMatchInstanceNode(attributiveLabel: string) {
    if (!attributiveLabelChanged(node.attributive_label, attributiveLabel)) return;
    clearCardChecks();
    patch(matchNodeAliasPatch(attributiveLabel));
  }

  const matchAliasLocked = node.alias_locked === true;
  const matchIsReference = isAliasReference(node);
  const hasAttributiveLabel = Boolean(node.attributive_label?.trim());
  const matchAliasNames = collectLockedDefineAliases(state.query, "node", {
    clauseIndex,
    patternIndex,
    pathIndex
  });
  const matchAliasOptions = filterAliasReferencesForRequiredAttributiveLabel(
    state.query,
    "node",
    matchAliasNames,
    node.attributive_label ?? ""
  );
  const titleAlias = matchCardTitleAlias(node.variable, hasAttributiveLabel);
  // Read/delete STEP/SCHEMA identifies targets by attributive_label only — no WHERE card.
  const showPathWhere =
    !matchIsReference &&
    hasAttributiveLabel &&
    Boolean(node.variable?.trim()) &&
    !isLabelOnlyMatch(operation, label);

  return (
    <div className="builderCard">
      <div className="builderHeadRow">
        <strong className="builderMono">
          node{titleAlias ? ` (${titleAlias})` : ""}
        </strong>
      </div>

      {!matchIsReference &&
      (isInstanceTargetMatch || isStepHopTargetMatch || isSchemaTargetMatch) ? (
        <div className="builderField">
          <label>attributive_label</label>
          <input
            readOnly
            value={node.attributive_label ?? ""}
            placeholder="(set by relationship)"
            className="builderMono"
          />
        </div>
      ) : !matchIsReference && label === "INSTANCE" ? (
        <InstanceNodeAttributiveField
          attributiveLabel={node.attributive_label ?? ""}
          disabled={matchAliasLocked}
          onSelect={selectMatchInstanceNode}
        />
      ) : (
        <MatchAttributiveLabelField
          fetchLabel={matchFetchLabel}
          attributiveLabel={node.attributive_label ?? ""}
          requireSpaceCatalog
          disabled={matchAliasLocked}
          onSelect={(al) => {
            if (label === "STEP") selectMatchStepNode(al);
            else selectMatchSchemaNode(al);
          }}
        />
      )}

      {!isAliasSet(node) && !graphMode ? (
        <AliasField
          aliasName={node.variable}
          effectiveAlias=""
          placeholder={MATCH_ALIAS_DEFAULT_PLACEHOLDER}
          locked={matchAliasLocked}
          available={matchAliasOptions}
          canCreate={hasAttributiveLabel}
          onCreate={createMatchNodeAlias}
          onChooseExisting={chooseMatchNodeAlias}
        />
      ) : null}

      <PathWhereFooter
        clauseIndex={clauseIndex}
        patternIndex={patternIndex}
        pathIndex={pathIndex}
        label={label}
        operation={operation}
        entityRole="node"
        entity={node}
        show={showPathWhere}
        onToggleFilters={(checked) => patch({ where_enabled: checked })}
      />
    </div>
  );
}
