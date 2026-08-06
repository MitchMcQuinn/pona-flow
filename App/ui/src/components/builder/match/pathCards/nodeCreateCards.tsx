/**
 * Create-mode node cards (INSTANCE / STEP-or-SCHEMA picker), routed to from
 * NodePathEntry. Shared plumbing (patch, check clearing, preceding-parameter
 * detection) lives in ./shared.
 */

import connector from "../../../../services/connector";
import {
  attributiveLabelChanged,
  nodeClearedForAttributiveLabel
} from "../../../../state/builder/cardReset";
import {
  collectQueryVariables,
  instanceEntityIdPatch,
  instanceKeyValue,
  INSTANCE_ALIAS_DEFAULT_PLACEHOLDER
} from "../../../../state/builder/instanceRules";
import {
  instanceTargetPickerValue,
  isInstanceTargetResolved
} from "../../../../state/builder/instanceTarget";
import {
  filterAliasReferencesForRequiredAttributiveLabel,
  isAliasReference,
  isAliasSet
} from "../../../../state/builder/matchAlias";
import {
  normalizeAlias,
  normalizeAttributiveLabel
} from "../../../../state/builder/normalizeField";
import { addSchemaProperty } from "../../../../state/builder/queryHelpers";
import { propertiesFromSchemata } from "../../../../state/builder/schemaRules";
import { PropertyBinding } from "../../PropertyBinding";
import { AliasField } from "../../fields/AliasField";
import { InstanceNodeAttributiveField } from "../../fields/InstanceNodeAttributiveField";
import { InstancePropertyField } from "../../fields/InstancePropertyField";
import { InstanceTargetField } from "../../fields/InstanceTargetField";
import {
  StepAttributiveLabelField,
  type ExistingStepNode
} from "../../fields/StepAttributiveLabelField";
import { StepSequencialConfig } from "../../fields/StepSequencialConfig";
import {
  collectDeclaredAliases,
  useInstanceIdSync,
  useNodeCard,
  type NodeCardProps
} from "./shared";

// ---- INSTANCE create: schema-constrained picker, adopted read-only properties ----
export function InstanceCreateNodeCard(props: NodeCardProps) {
  const { clauseIndex, patternIndex, pathIndex, node, graphMode } = props;
  const {
    state,
    patch,
    clearCardChecks,
    precedingRelIsParameter,
    chooseExistingAlias
  } = useNodeCard(props);

  const aliasLocked = node.alias_locked === true;
  const isAliasRef = isAliasReference(node);
  const schemaSelected = Boolean(node.attributive_label?.trim());
  const instanceTargetResolved = isInstanceTargetResolved(node.node_source);
  const hasSelection =
    node.node_source === "existing" || node.node_source === "new" || schemaSelected;
  const aliasCanCreate = instanceTargetResolved && schemaSelected;
  const instanceKeyId = instanceKeyValue(node.properties);

  // INSTANCE target nodes (everything past the first) are fixed by the preceding
  // relationship's outgoing schema edge, so their attributive_label is read-only.
  const isInstanceTarget = pathIndex > 0 && !precedingRelIsParameter;

  const aliasNames = collectDeclaredAliases(state.query, "node", node.variable);
  const aliasOptions = filterAliasReferencesForRequiredAttributiveLabel(
    state.query,
    "node",
    aliasNames,
    node.attributive_label ?? ""
  );

  function createAlias(name: string) {
    patch({ variable: normalizeAlias(name), alias_mode: "define", alias_locked: true });
  }

  function selectInstanceSchema(attributiveLabel: string) {
    const labelChanged = attributiveLabelChanged(node.attributive_label, attributiveLabel);
    if (labelChanged) clearCardChecks();
    patch({
      ...(labelChanged ? nodeClearedForAttributiveLabel("INSTANCE", attributiveLabel, node) : {}),
      attributive_label: attributiveLabel
    });
  }

  async function selectNewInstanceTarget() {
    if (!state.spaceId || !node.attributive_label?.trim()) return;
    clearCardChecks();
    try {
      const def = await connector.fetchSchemaDefinition({
        spaceId: state.spaceId,
        attributiveLabel: node.attributive_label.trim()
      });
      // UID key values are minted by the engine at run time, so the adopted
      // properties keep their (empty) schema defaults.
      const properties = propertiesFromSchemata(def.schemata ?? []);
      patch({
        node_source: "new",
        properties,
        ...instanceEntityIdPatch(node, properties, {
          attributiveLabel: node.attributive_label.trim(),
          takenVariables: collectQueryVariables(state.query).filter(
            (v) => v !== node.variable
          )
        })
      });
    } catch {
      patch({ node_source: "new", properties: [] });
    }
  }

  function selectExistingInstanceTarget(record: { id: string; attributive_label: string }) {
    clearCardChecks();
    patch({
      node_source: "existing",
      id_binding: { key: "id", value: record.id },
      properties: [],
      variable: aliasLocked ? node.variable : record.id
    });
  }

  // Target supplied at run time: an existing instance whose id is a "$name" parameter.
  function selectParameterInstanceTarget(param: string) {
    clearCardChecks();
    patch({
      node_source: "existing",
      id_binding: { key: "id", value: param },
      properties: [],
      variable: aliasLocked ? node.variable : normalizeAlias(param.slice(1))
    });
  }

  useInstanceIdSync({
    enabled: instanceTargetResolved && node.node_source !== "existing",
    entity: node,
    aliasLocked,
    clearIdWithoutUidKey: true,
    query: state.query,
    patch,
    deps: [instanceTargetResolved, node.properties, aliasLocked, node.node_source]
  });

  return (
    <div className="builderCard">
      <div className="builderHeadRow">
        <strong className="builderMono">
          node{isAliasSet(node) || hasSelection ? ` (${node.variable})` : ""}
        </strong>
      </div>

      {!isAliasRef && isInstanceTarget ? (
        <div className="builderField">
          <label>attributive_label</label>
          <input
            readOnly
            value={node.attributive_label ?? ""}
            placeholder="(set by relationship)"
            className="builderMono"
          />
        </div>
      ) : null}

      {!isAliasRef && !isInstanceTarget ? (
        <InstanceNodeAttributiveField
          attributiveLabel={node.attributive_label ?? ""}
          disabled={aliasLocked}
          onSelect={selectInstanceSchema}
        />
      ) : null}

      {!isAliasRef && schemaSelected ? (
        <InstanceTargetField
          schemaAttributiveLabel={node.attributive_label ?? ""}
          targetValue={instanceTargetPickerValue(
            node.node_source,
            typeof node.id_binding?.value === "string" ? node.id_binding.value : undefined
          )}
          disabled={aliasLocked}
          onSelectNew={() => void selectNewInstanceTarget()}
          onSelectExisting={selectExistingInstanceTarget}
          onSelectParameter={selectParameterInstanceTarget}
        />
      ) : null}

      {!isAliasSet(node) && !graphMode ? (
        <AliasField
          aliasName={node.variable}
          locked={aliasLocked}
          effectiveAlias={aliasLocked ? node.variable : ""}
          placeholder={INSTANCE_ALIAS_DEFAULT_PLACEHOLDER}
          available={aliasOptions}
          canCreate={aliasCanCreate}
          onCreate={createAlias}
          onChooseExisting={chooseExistingAlias}
        />
      ) : null}

      {!isAliasRef &&
      instanceTargetResolved &&
      node.node_source === "new" &&
      node.properties.length > 0 ? (
        <div className="builderBlock">
          {node.properties.map((prop, propIndex) => (
            <InstancePropertyField
              key={propIndex}
              clauseIndex={clauseIndex}
              patternIndex={patternIndex}
              pathIndex={pathIndex}
              propIndex={propIndex}
              prop={prop}
              attributiveLabel={node.attributive_label ?? ""}
              excludeId={instanceKeyId || undefined}
              hidden={!aliasLocked && Boolean(prop.schematic_properties?.is_key)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---- STEP/SCHEMA create: picker-driven node selection, alias locking ----
export function PickerCreateNodeCard(props: NodeCardProps) {
  const { clauseIndex, patternIndex, pathIndex, node, label, graphMode } = props;
  const { state, patchQuery, patch, clearCardChecks, chooseExistingAlias, addr } =
    useNodeCard(props);

  const schemaMode = label === "SCHEMA";
  const isStepCreate = label === "STEP";
  const aliasLocked = node.alias_locked === true;
  const isAliasRef = isAliasReference(node);
  const isExisting = node.node_source === "existing";
  const schemaSelected = Boolean(node.attributive_label?.trim());
  const hasSelection = isExisting || node.node_source === "new" || schemaSelected;
  const aliasCanCreate = schemaSelected;
  const aliasNames = collectDeclaredAliases(state.query, "node", node.variable);

  async function selectNewStepNode(attributiveLabel: string) {
    // The id is generated by the backend and never shown as a form field.
    // The alias defaults to the id unless the user explicitly sets one.
    let generatedId = "";
    try {
      generatedId = (await connector.generateQueryId()).trim();
    } catch {
      generatedId = "";
    }
    if (!generatedId) {
      return;
    }
    const al = normalizeAttributiveLabel(attributiveLabel);
    if (attributiveLabelChanged(node.attributive_label, al)) clearCardChecks();
    patch({
      ...nodeClearedForAttributiveLabel(label, al, node),
      node_source: "new",
      id_binding: { key: "id", value: generatedId },
      variable: aliasLocked ? node.variable : generatedId
    });
  }

  function selectExistingStepNode(record: ExistingStepNode) {
    if (attributiveLabelChanged(node.attributive_label, record.attributive_label)) clearCardChecks();
    patch({
      ...nodeClearedForAttributiveLabel(label, record.attributive_label, node),
      // Keep the graph's exact attributive_label — normalization is for new labels only.
      attributive_label: record.attributive_label.trim(),
      node_source: "existing",
      id_binding: { key: "id", value: record.id },
      variable: aliasLocked ? node.variable : record.id,
      ...(label === "STEP" ? { sequencial_properties: record.sequencial_properties ?? {} } : {})
    });
  }

  function createAlias(name: string) {
    patch({ variable: normalizeAlias(name), alias_mode: "define", alias_locked: true });
  }

  return (
    <div className="builderCard">
      <div className="builderHeadRow">
        <strong className="builderMono">
          node{isAliasSet(node) || hasSelection ? ` (${node.variable})` : ""}
        </strong>
      </div>

      {!isAliasRef ? (
        <StepAttributiveLabelField
          attributiveLabel={node.attributive_label ?? ""}
          disabled={aliasLocked}
          checkKey={`al:${addr}`}
          excludeId={typeof node.id_binding?.value === "string" ? node.id_binding.value : undefined}
          enforceUnique={!isExisting}
          nodeLabel={label}
          onSelectNew={selectNewStepNode}
          onSelectExisting={selectExistingStepNode}
        />
      ) : null}

      {!isAliasSet(node) && !graphMode ? (
        <AliasField
          aliasName={node.variable}
          locked={aliasLocked}
          available={aliasNames}
          canCreate={aliasCanCreate}
          onCreate={createAlias}
          onChooseExisting={chooseExistingAlias}
        />
      ) : null}

      {!isAliasRef && hasSelection && isStepCreate && !isExisting ? (
        <StepSequencialConfig
          node={node}
          onPatch={patch}
          bodyCheckKey={`stepBody:${addr}`}
        />
      ) : null}

      {!isAliasRef && hasSelection && schemaMode && !isExisting ? (
        <div className="builderBlock">
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
