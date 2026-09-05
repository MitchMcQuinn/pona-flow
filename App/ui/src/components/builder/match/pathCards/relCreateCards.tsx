/**
 * Create-mode relationship cards (STEP / INSTANCE / SCHEMA), routed to from
 * RelPathEntry. Each card owns one mode's picker + alias + property flow; the
 * shared plumbing (patch, check clearing, neighbor labels) lives in ./shared.
 */

import { useEffect, useRef } from "react";
import connector from "../../../../services/connector";
import type { SchemaOutgoingEdge } from "../../../../services/connector";
import {
  attributiveLabelChanged,
  nodeClearedForAttributiveLabel,
  relationshipClearedForAttributiveLabel
} from "../../../../state/builder/cardReset";
import {
  collectQueryVariables,
  instanceEntityIdPatch,
  instanceKeyValue,
  INSTANCE_ALIAS_DEFAULT_PLACEHOLDER,
  DEFAULT_STEP_RELATIONSHIP_LABEL
} from "@pona-flow/authoring";
import {
  filterAliasReferencesForRequiredAttributiveLabel,
  isAliasReference,
  isAliasSet
} from "@pona-flow/authoring";
import {
  normalizeAlias,
  normalizeAttributiveLabel,
  sanitizeAttributiveLabelInput
} from "@pona-flow/authoring";
import { addSchemaProperty, updateNode } from "../../../../state/builder/queryHelpers";
import { propertiesFromSchemata } from "@pona-flow/authoring";
import type { NodePattern, RelationshipPattern } from "../../../../state/builder/types";
import { PropertyBinding } from "../../PropertyBinding";
import { AliasField } from "../../fields/AliasField";
import { InstancePropertyField } from "../../fields/InstancePropertyField";
import { InstanceRelAttributiveField } from "../../fields/InstanceRelAttributiveField";
import {
  SchemaRelAttributiveLabelField,
  type ExistingSchemaRelationshipType
} from "../../fields/SchemaRelAttributiveLabelField";
import { StepRelConditionField } from "../../fields/StepRelConditionField";
import { VectorizedField } from "../../fields/VectorizedField";
import {
  collectDeclaredAliases,
  useInstanceIdSync,
  useRelCard,
  type RelCardProps
} from "./shared";

/** The create cards' default alias picker (create mode always allows defining one). */
function CreateRelAliasField({
  relationship,
  aliasNames,
  onCreate,
  onChooseExisting
}: {
  relationship: RelationshipPattern;
  aliasNames: string[];
  onCreate: (name: string) => void;
  onChooseExisting: (name: string) => void;
}) {
  const isReference = isAliasReference(relationship);
  return (
    <AliasField
      aliasName={isReference ? relationship.alias_ref ?? "" : relationship.variable}
      locked={relationship.alias_locked === true}
      available={aliasNames}
      canCreate
      onCreate={onCreate}
      onChooseExisting={onChooseExisting}
    />
  );
}

// ---- STEP create: attributive picker, alias, auto id, condition (user query) ----
export function StepCreateRelCard(props: RelCardProps) {
  const { relationship, graphMode } = props;
  const { state, patch, clearRelCardChecks, chooseExistingRelAlias } = useRelCard(props);
  const relLabelAtFocusRef = useRef(relationship.attributive_label ?? "");

  const isReference = isAliasReference(relationship);
  const aliasLocked = relationship.alias_locked === true;
  const isExisting = relationship.node_source === "existing";
  const currentId =
    typeof relationship.id_binding?.value === "string" ? relationship.id_binding.value : "";
  const showAliasField = !isAliasSet(relationship) && !graphMode;
  const aliasNames = collectDeclaredAliases(state.query, "relationship", relationship.variable);

  function commitRelAttributiveLabel(next: string) {
    if (!attributiveLabelChanged(relLabelAtFocusRef.current, next)) return;
    clearRelCardChecks();
    patch(relationshipClearedForAttributiveLabel(next, props.label, relationship));
  }

  // STEP relationships get a backend id up front (alias defaults to it) and a
  // default attributive_label of NEXT. attributive_label is optional + may repeat.
  useEffect(() => {
    if (isReference || currentId) return;
    let cancelled = false;
    connector
      .generateQueryId()
      .then((generatedId) => {
        if (cancelled) return;
        patch({
          id_binding: { key: "id", value: generatedId },
          variable: aliasLocked ? relationship.variable : generatedId,
          attributive_label: relationship.attributive_label?.trim()
            ? relationship.attributive_label
            : DEFAULT_STEP_RELATIONSHIP_LABEL
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReference, currentId]);

  return (
    <div className="builderCard">
      <div className="builderHeadRow">
        <strong className="builderMono">
          relationship{isReference || relationship.variable ? ` (${relationship.variable})` : ""}
        </strong>
      </div>

      {!isReference ? (
        <div className="builderField">
          <label>attributive_label</label>
          <input
            value={relationship.attributive_label ?? ""}
            placeholder="NEXT or $parameter"
            disabled={aliasLocked}
            title={aliasLocked ? "Locked because this entry has an alias." : undefined}
            onFocus={() => {
              relLabelAtFocusRef.current = relationship.attributive_label ?? "";
            }}
            onChange={(e) =>
              patch({ attributive_label: sanitizeAttributiveLabelInput(e.target.value) })
            }
            onBlur={(e) => commitRelAttributiveLabel(e.target.value)}
          />
        </div>
      ) : null}

      {showAliasField ? (
        <CreateRelAliasField
          relationship={relationship}
          aliasNames={aliasNames}
          onCreate={(name) =>
            patch({ variable: normalizeAlias(name), alias_mode: "define", alias_locked: true })
          }
          onChooseExisting={chooseExistingRelAlias}
        />
      ) : null}

      {!isReference ? (
        <StepRelConditionField relationship={relationship} readOnly={isExisting} onPatch={patch} />
      ) : null}
    </div>
  );
}

// ---- INSTANCE create: edge picker that also fixes the target node ----
export function InstanceCreateRelCard(props: RelCardProps) {
  const { clauseIndex, patternIndex, pathIndex, relationship, label, graphMode } = props;
  const {
    state,
    patchQuery,
    dispatch,
    patch,
    clearRelCardChecks,
    precedingNodeLabel,
    chooseExistingRelAlias
  } = useRelCard(props);

  const isReference = isAliasReference(relationship);
  const aliasLocked = relationship.alias_locked === true;
  const isExisting = relationship.node_source === "existing";
  const instanceKeyId = instanceKeyValue(relationship.properties);
  const hasSelection =
    isExisting || relationship.node_source === "new" || Boolean(relationship.attributive_label?.trim());
  const showAliasField = !isAliasSet(relationship) && !graphMode;

  const aliasNames = collectDeclaredAliases(state.query, "relationship", relationship.variable);
  const instanceAliasOptions = filterAliasReferencesForRequiredAttributiveLabel(
    state.query,
    "relationship",
    aliasNames,
    relationship.attributive_label ?? ""
  );

  async function selectInstanceEdge(edge: SchemaOutgoingEdge) {
    const relLabelChanged = attributiveLabelChanged(
      relationship.attributive_label,
      edge.rel_attributive_label
    );
    if (relLabelChanged) clearRelCardChecks();
    // UID key values are minted by the engine at run time, so the adopted
    // properties keep their (empty) schema defaults.
    const relProperties = propertiesFromSchemata(edge.rel_schemata);
    patch({
      ...(relLabelChanged
        ? relationshipClearedForAttributiveLabel(edge.rel_attributive_label, label, relationship)
        : {}),
      node_source: "new",
      attributive_label: edge.rel_attributive_label,
      properties: relProperties,
      ...instanceEntityIdPatch(relationship, relProperties, {
        attributiveLabel: edge.rel_attributive_label,
        takenVariables: collectQueryVariables(state.query).filter(
          (v) => v !== relationship.variable
        )
      })
    });
    // Cascade the chosen target schema onto the following node in the path.
    const following = state.query.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex + 1];
    const targetNode = following?.kind === "node" ? following.node : undefined;
    const targetLabelChanged =
      targetNode &&
      attributiveLabelChanged(targetNode.attributive_label, edge.target_attributive_label);
    if (targetLabelChanged) {
      dispatch({ type: "CLEAR_CHECKS", prefix: `gid:${clauseIndex}:${patternIndex}:${pathIndex + 1}` });
    }
    const followingPatch: Partial<NodePattern> = {
      ...(targetLabelChanged && targetNode
        ? nodeClearedForAttributiveLabel("INSTANCE", edge.target_attributive_label, targetNode)
        : {}),
      attributive_label: edge.target_attributive_label
    };
    // Keep the following node's graph-managed variable stable (see patch() rationale).
    if (graphMode) delete followingPatch.variable;
    patchQuery(updateNode(clauseIndex, patternIndex, pathIndex + 1, followingPatch));
  }

  // INSTANCE create: a $parameter replaces the edge binding (no target cascade).
  function selectInstanceRelParameter(param: string) {
    if (attributiveLabelChanged(relationship.attributive_label, param)) clearRelCardChecks();
    patch(relationshipClearedForAttributiveLabel(param, label, relationship));
  }

  useInstanceIdSync({
    enabled: hasSelection && !isReference,
    entity: relationship,
    aliasLocked,
    clearIdWithoutUidKey: false,
    query: state.query,
    patch,
    deps: [hasSelection, isReference, relationship.properties, aliasLocked]
  });

  return (
    <div className="builderCard">
      <div className="builderHeadRow">
        <strong className="builderMono">
          relationship{isAliasSet(relationship) || hasSelection ? ` (${relationship.variable})` : ""}
        </strong>
      </div>

      {!isReference ? (
        <InstanceRelAttributiveField
          parentAttributiveLabel={precedingNodeLabel}
          attributiveLabel={relationship.attributive_label ?? ""}
          disabled={aliasLocked}
          onSelect={selectInstanceEdge}
          onSelectParameter={selectInstanceRelParameter}
        />
      ) : null}

      {showAliasField ? (
        <AliasField
          aliasName={relationship.variable}
          locked={aliasLocked}
          effectiveAlias={aliasLocked && !isReference ? relationship.variable : ""}
          placeholder={INSTANCE_ALIAS_DEFAULT_PLACEHOLDER}
          available={instanceAliasOptions}
          canCreate
          onCreate={(name) =>
            patch({ variable: normalizeAlias(name), alias_mode: "define", alias_locked: true })
          }
          onChooseExisting={chooseExistingRelAlias}
        />
      ) : null}

      {!isReference && hasSelection && relationship.properties.length > 0 ? (
        <div className="builderBlock">
          {relationship.properties.map((prop, propIndex) => (
            <InstancePropertyField
              key={propIndex}
              clauseIndex={clauseIndex}
              patternIndex={patternIndex}
              pathIndex={pathIndex}
              propIndex={propIndex}
              prop={prop}
              attributiveLabel={relationship.attributive_label ?? ""}
              excludeId={instanceKeyId || undefined}
              hidden={!aliasLocked && Boolean(prop.schematic_properties?.is_key)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---- SCHEMA create: attributive picker + alias + auto id + schema properties ----
export function SchemaCreateRelCard(props: RelCardProps) {
  const { clauseIndex, patternIndex, pathIndex, relationship, label, graphMode } = props;
  const { state, patchQuery, patch, clearRelCardChecks, chooseExistingRelAlias, addr } =
    useRelCard(props);

  const isReference = isAliasReference(relationship);
  const aliasLocked = relationship.alias_locked === true;
  const isExisting = relationship.node_source === "existing";
  const currentId =
    typeof relationship.id_binding?.value === "string" ? relationship.id_binding.value : "";
  const hasSelection =
    isExisting || relationship.node_source === "new" || Boolean(relationship.attributive_label?.trim());
  const showAliasField = !isAliasSet(relationship) && !graphMode;
  const aliasNames = collectDeclaredAliases(state.query, "relationship", relationship.variable);

  async function selectNewRel(attributiveLabel: string) {
    let id = currentId;
    if (!id) {
      try {
        id = await connector.generateQueryId();
      } catch {
        id = "";
      }
    }
    const al = normalizeAttributiveLabel(attributiveLabel);
    if (attributiveLabelChanged(relationship.attributive_label, al)) clearRelCardChecks();
    patch({
      ...relationshipClearedForAttributiveLabel(al, label, relationship),
      node_source: "new",
      id_binding: { key: "id", value: id },
      variable: aliasLocked ? relationship.variable : id
    });
  }

  // Reuse an existing relationship *type* between this node pair: the new edge gets its
  // own fresh id (binding the picked edge's id would mint a duplicate-id edge) and an
  // identical copy of the type's shared property definition, hydrated so the composer
  // writes the same schemata payload for the new edge's entities row.
  async function selectExistingRel(record: ExistingSchemaRelationshipType) {
    if (attributiveLabelChanged(relationship.attributive_label, record.attributive_label)) {
      clearRelCardChecks();
    }
    let id = "";
    try {
      id = await connector.generateQueryId();
    } catch {
      id = "";
    }
    let typeProperties: RelationshipPattern["properties"] = [];
    let typeVectorized = false;
    const spaceId = state.spaceId ?? "";
    if (spaceId) {
      try {
        const definition = await connector.fetchSchemaDefinition({
          spaceId,
          attributiveLabel: record.attributive_label.trim()
        });
        typeVectorized = definition.is_vectorized === true;
        // Drop the implicit is_key UID — the composer re-injects it at payload time,
        // keeping the copy byte-identical to the type's other edges.
        typeProperties = propertiesFromSchemata(definition.schemata ?? []).filter(
          (p) => !p.schematic_properties?.is_key
        );
      } catch {
        typeProperties = [];
      }
    }
    patch({
      ...relationshipClearedForAttributiveLabel(record.attributive_label, label, relationship),
      // Keep the graph's exact attributive_label — normalization is for new labels only.
      attributive_label: record.attributive_label.trim(),
      node_source: "existing",
      id_binding: { key: "id", value: id },
      variable: aliasLocked ? relationship.variable : id,
      is_vectorized: typeVectorized,
      properties: typeProperties
    });
  }

  return (
    <div className="builderCard">
      <div className="builderHeadRow">
        <strong className="builderMono">
          relationship{isAliasSet(relationship) || hasSelection ? ` (${relationship.variable})` : ""}
        </strong>
      </div>

      {!isReference ? (
        <SchemaRelAttributiveLabelField
          attributiveLabel={relationship.attributive_label ?? ""}
          disabled={aliasLocked}
          checkKey={`al:${addr}`}
          excludeId={currentId || undefined}
          enforceUnique={!isExisting}
          onSelectNew={selectNewRel}
          onSelectExisting={selectExistingRel}
        />
      ) : null}

      {showAliasField ? (
        <CreateRelAliasField
          relationship={relationship}
          aliasNames={aliasNames}
          onCreate={(name) =>
            patch({ variable: normalizeAlias(name), alias_mode: "define", alias_locked: true })
          }
          onChooseExisting={chooseExistingRelAlias}
        />
      ) : null}

      {!isReference && hasSelection ? (
        <>
          {isExisting ? (
            <p className="builderCheckMsg">
              Reusing an existing relationship type — its properties are shared by every use
              and shown read-only here. Edit the type via a SCHEMA update to change them
              everywhere.
            </p>
          ) : null}
          <div className="builderBlock">
            <VectorizedField
              clauseIndex={clauseIndex}
              patternIndex={patternIndex}
              pathIndex={pathIndex}
              checked={relationship.is_vectorized === true}
              disabled={isExisting}
            />
            {relationship.properties.map((prop, propIndex) => (
              <PropertyBinding
                key={propIndex}
                clauseIndex={clauseIndex}
                patternIndex={patternIndex}
                pathIndex={pathIndex}
                propIndex={propIndex}
                prop={prop}
                schemaMode
                canDelete={!isExisting}
                readOnly={isExisting}
                vectorized={relationship.is_vectorized === true}
              />
            ))}
            {!isExisting ? (
              <div className="builderCardFooter">
                <button
                  type="button"
                  className="builderTinyBtn builderAddBtn"
                  onClick={() => patchQuery(addSchemaProperty(clauseIndex, patternIndex, pathIndex))}
                >
                  + property
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
