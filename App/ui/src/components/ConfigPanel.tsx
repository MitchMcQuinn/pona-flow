import { useEffect, useState } from "react";
import type { AppState, ParameterSchema, SequenceDefinition, StepGraphNode, StepGraphRelationship } from "../state/types";
import type { BuilderSeed, RunResult } from "../state/builder/types";
import { updateSequenceDescription, type ExecutionPackage } from "../services/api";
import { BuilderPanel } from "./builder/BuilderPanel";
import { EventBuilder } from "./events/EventBuilder";
import { SpaceConfigPanel } from "./space/SpaceConfigPanel";
import { LocalLlmsPanel } from "./localLlms/LocalLlmsPanel";
import { SequenceWebhookSection } from "./sequence/SequenceWebhookSection";
import { TypedValueInput } from "./builder/fields/TypedValueInput";
import { parseCheckboxSelection } from "@pona-flow/authoring";
import "./builder/builder.css";

interface ConfigPanelProps {
  state: AppState;
  onParamChange: (name: string, value: string) => void;
  onParamValidityUpdate: (validity: Record<string, boolean>) => void;
  onCloseInspect: () => void;
  onBuilderResult: (result: RunResult) => void;
  onSequenceCreated: (sequenceId: string) => void;
  onNavRefresh: () => void;
  builderSeed?: BuilderSeed | null;
  onBuilderSeedConsumed?: () => void;
  onEditOperationActiveChange?: (active: boolean) => void;
  exitEditOperationRequest?: number;
  /** Bumped each time a sequence builder session opens so the builder remounts clean/hydrated. */
  builderKey?: number;
  onEventSaved: (eventId: string) => void;
  onEventDeleted: () => void;
  onEventCancel: () => void;
  spaces: Array<{ id: string; label: string }>;
  onSpaceSaved: (values: { name: string; endpoint?: string; labels?: string[] }) => Promise<void>;
  savingSpace: boolean;
  spaceSaveError: string | null;
  onDeleteSpace: () => void;
  onLoadAuditLog: () => void;
  onSpacePanelClose: () => void;
  onLocalLlmsPanelClose?: () => void;
  /** Composed EXECUTION package for the selected sequence (webhook curl + input list). */
  executionPackage?: ExecutionPackage | null;
  composeError?: string | null;
}

function paramHasValue(parameter: ParameterSchema, value: unknown): boolean {
  if (parameter.valueType === "checkbox") {
    return parseCheckboxSelection(String(value ?? "")).length > 0;
  }
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function validateParams(
  schema: ParameterSchema[],
  values: Record<string, unknown>
): Record<string, boolean> {
  const validity: Record<string, boolean> = {};
  for (const parameter of schema) {
    const value = values[parameter.name];
    const present = paramHasValue(parameter, value);
    // checkbox honors its configured min/max even when not strictly required, but an
    // empty optional checkbox is still valid (the runner simply selected nothing).
    if (parameter.valueType === "checkbox" && present) {
      const count = parseCheckboxSelection(String(value ?? "")).length;
      const min = parameter.minChoices;
      const max = parameter.maxChoices;
      const withinMin = !(typeof min === "number" && min > 0) || count >= min;
      const withinMax = !(typeof max === "number" && max > 0) || count <= max;
      validity[parameter.name] = withinMin && withinMax;
      continue;
    }
    if (!parameter.required) {
      validity[parameter.name] = true;
      continue;
    }
    if (parameter.valueType === "checkbox") {
      const count = parseCheckboxSelection(String(value ?? "")).length;
      const min = parameter.minChoices;
      validity[parameter.name] = count > 0 && (!(typeof min === "number" && min > 0) || count >= min);
      continue;
    }
    validity[parameter.name] = present;
  }
  return validity;
}

function formatPayloadValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function findInspectableElement(
  definition: SequenceDefinition | null,
  selected: { kind: "node" | "relationship"; id: string }
): StepGraphNode | StepGraphRelationship | null {
  if (!definition) return null;
  if (selected.kind === "node") {
    return definition.stepGraph.nodes.find((node) => node.id === selected.id) ?? null;
  }
  return definition.stepGraph.relationships.find((rel) => rel.id === selected.id) ?? null;
}

function InspectPropertiesPanel({
  selected,
  element,
  onCloseInspect
}: {
  selected: { kind: "node" | "relationship"; id: string };
  element: StepGraphNode | StepGraphRelationship;
  onCloseInspect: () => void;
}) {
  const payloadEntries = Object.entries(element.payload ?? {});

  return (
    <div className="panel configPanel">
      <div className="panel__body">
        <h2>Properties</h2>
        <p className="inspectKind">
          {selected.kind === "node" ? "STEP node" : "POINTS_TO relationship"}
        </p>
        <div className="field">
          <label>attributive_label</label>
          <div className="inspectValue">{element.attributive_label}</div>
        </div>
        <div className="field">
          <label>id</label>
          <div className="inspectValue">
            <code>{element.id}</code>
          </div>
        </div>
        <div className="inspectPayloadSection">
          <h3>Payload</h3>
          {payloadEntries.length === 0 ? (
            <p className="muted">No payload properties stored for this entity.</p>
          ) : (
            <table className="inspectPayloadTable">
              <tbody>
                {payloadEntries.map(([key, value]) => (
                  <tr key={key}>
                    <th>{key}</th>
                    <td>
                      <pre className="inspectPayloadValue">{formatPayloadValue(value)}</pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="buttonRow">
          <button type="button" onClick={onCloseInspect}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * View + post-hoc edit of a selected sequence's description. The description is the MCP
 * tool description for the sequence, so editing it here updates what agents read. Saves
 * via a focused endpoint (never re-composes the package). Remount per sequence via a key.
 */
function SequenceDescriptionEditor({
  spaceId,
  sequenceId,
  initialDescription,
  onSaved
}: {
  spaceId: string | null;
  sequenceId: string;
  initialDescription: string;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(initialDescription);
  const [draft, setDraft] = useState(initialDescription);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!spaceId) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateSequenceDescription(spaceId, sequenceId, draft.trim());
      setValue(result.description);
      setDraft(result.description);
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save description");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sequenceDescription">
      <div className="sequenceDescriptionHead">
        <h3>Description</h3>
        {!editing ? (
          <button
            type="button"
            className="tinyBtn"
            disabled={!spaceId}
            onClick={() => {
              setDraft(value);
              setError(null);
              setEditing(true);
            }}
          >
            {value ? "Edit" : "Add"}
          </button>
        ) : null}
      </div>
      {editing ? (
        <>
          <textarea
            className="sequenceDescriptionInput"
            value={draft}
            rows={3}
            placeholder="What this sequence does. Shown to MCP agents as the tool description."
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
          />
          {error ? <p className="errorText">{error}</p> : null}
          <div className="buttonRow">
            <button type="button" className="btnPrimary" disabled={saving} onClick={save}>
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setDraft(value);
                setError(null);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : value ? (
        <p className="sequenceDescriptionText">{value}</p>
      ) : (
        <p className="muted">No description yet. Agents see a generic tool description until one is set.</p>
      )}
    </div>
  );
}

export function ConfigPanel({
  state,
  onParamChange,
  onParamValidityUpdate,
  onCloseInspect,
  onBuilderResult,
  onSequenceCreated,
  onNavRefresh,
  builderSeed,
  onBuilderSeedConsumed,
  onEditOperationActiveChange,
  exitEditOperationRequest,
  builderKey,
  onEventSaved,
  onEventDeleted,
  onEventCancel,
  spaces,
  onSpaceSaved,
  savingSpace,
  spaceSaveError,
  onDeleteSpace,
  onLoadAuditLog,
  onSpacePanelClose,
  onLocalLlmsPanelClose,
  executionPackage = null,
  composeError = null
}: ConfigPanelProps) {
  const { rightPanelMode } = state.view;

  useEffect(() => {
    if (rightPanelMode !== "params") return;
    const validity = validateParams(state.params.schema, state.params.values);
    const hasChanged = JSON.stringify(validity) !== JSON.stringify(state.params.validity);
    if (hasChanged) {
      onParamValidityUpdate(validity);
    }
  }, [rightPanelMode, state.params.schema, state.params.values, state.params.validity, onParamValidityUpdate]);

  if (rightPanelMode === "inspect" && state.editor.selectedElement) {
    const element = findInspectableElement(state.sequence.definition, state.editor.selectedElement);
    if (element) {
      return (
        <InspectPropertiesPanel
          selected={state.editor.selectedElement}
          element={element}
          onCloseInspect={onCloseInspect}
        />
      );
    }
    return (
      <div className="panel configPanel">
        <div className="panel__body">
          <h2>Properties</h2>
          <p className="muted">Selected element not found in the current step flow.</p>
          <div className="buttonRow">
            <button type="button" onClick={onCloseInspect}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (rightPanelMode === "params") {
    // Response parameters are produced by the sequence's steps, so they're shown
    // (read-only) in the lower half rather than as inputs to fill in.
    const responseParamNames = new Set(
      state.params.responseParams.map((responseParam) => responseParam.parameter)
    );
    const inputParams = state.params.schema.filter(
      (parameter) => !responseParamNames.has(parameter.name)
    );
    const hasResponseParams = state.params.responseParams.length > 0;
    const selectedSequence = state.nav.sequences.find(
      (sequence) => sequence.id === state.nav.selectedSequenceId
    );

    return (
      <div className="panel configPanel">
        <div className="panel__body">
          {selectedSequence ? (
            <div key={selectedSequence.id} className="sequenceParamsMeta">
              <SequenceDescriptionEditor
                spaceId={state.spaceId}
                sequenceId={selectedSequence.id}
                initialDescription={selectedSequence.description}
                onSaved={onNavRefresh}
              />
              {state.spaceId ? (
                <SequenceWebhookSection
                  spaceId={state.spaceId}
                  sequenceId={selectedSequence.id}
                  executionPackage={executionPackage}
                  composeError={composeError}
                  currentValues={state.params.values}
                />
              ) : null}
            </div>
          ) : null}
          <h2>Parameters</h2>
          {inputParams.length === 0 ? (
            <p className="muted">
              Inputs appear here as the sequence reaches steps that require them. Run the sequence
              to begin.
            </p>
          ) : state.run.awaitingParams ? (
            <p className="muted">
              The run paused at a step that needs input. Fill in the fields below and run again to
              continue.
            </p>
          ) : null}
          {inputParams.map((parameter) => {
            // Once a step has executed, its inputs are resolved and locked while the run is
            // paused mid-sequence — re-editing them can't un-run the step. They unlock again
            // when the run completes or a fresh run starts.
            const locked =
              state.run.awaitingParams &&
              Object.prototype.hasOwnProperty.call(state.params.responseValues, parameter.name);
            return (
              <div key={parameter.name} className="field" data-testid={`param-input-${parameter.name}`}>
                <label htmlFor={`param-${parameter.name}`}>
                  {parameter.name} {parameter.required ? "*" : ""}
                </label>
                <TypedValueInput
                  id={`param-${parameter.name}`}
                  valueType={parameter.valueType ?? parameter.type}
                  options={parameter.options}
                  minChoices={parameter.minChoices}
                  maxChoices={parameter.maxChoices}
                  required={parameter.required}
                  value={String(state.params.values[parameter.name] ?? "")}
                  disabled={locked}
                  onChange={locked ? () => undefined : (next) => onParamChange(parameter.name, next)}
                />
                {locked ? (
                  <div className="muted paramLockedHint">Locked — already used by an executed step.</div>
                ) : state.params.validity[parameter.name] === false ? (
                  <div className="errorText">Required parameter</div>
                ) : null}
              </div>
            );
          })}

          {hasResponseParams ? (
            <div className="responseParamsSection">
              <h3>Response parameters</h3>
              <p className="muted">Values returned and updated as the sequence runs.</p>
              <table className="responseParamsTable">
                <tbody>
                  {state.params.responseParams.map((responseParam) => {
                    const resolved = state.params.responseValues[responseParam.parameter];
                    const hasValue = resolved !== undefined && resolved !== null && resolved !== "";
                    return (
                      <tr key={responseParam.parameter}>
                        <th>{responseParam.parameter}</th>
                        <td>
                          {hasValue ? (
                            <code className="responseParamValue">{formatPayloadValue(resolved)}</code>
                          ) : (
                            <span className="muted responseParamPending">
                              {responseParam.defaultValue
                                ? `default: ${responseParam.defaultValue}`
                                : "awaiting run"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (rightPanelMode === "space") {
    return (
      <SpaceConfigPanel
        spaceId={state.spaceId}
        spaces={spaces}
        me={state.me}
        permissions={state.permissions}
        sequences={state.nav.sequences}
        events={state.events.items}
        auditLog={state.auditLog}
        onSaveSpace={onSpaceSaved}
        savingSpace={savingSpace}
        saveError={spaceSaveError}
        onDeleteSpace={onDeleteSpace}
        onLoadAuditLog={onLoadAuditLog}
        onClose={onSpacePanelClose}
      />
    );
  }

  if (rightPanelMode === "localLlms") {
    return (
      <LocalLlmsPanel
        spaceId={state.spaceId}
        onClose={onLocalLlmsPanelClose ?? onSpacePanelClose}
      />
    );
  }

  if (rightPanelMode === "event") {
    return (
      <EventBuilder
        spaceId={state.spaceId}
        sequences={state.nav.sequences}
        eventId={state.events.selectedEventId}
        defaultTimezone={state.me?.timezone ?? null}
        onSaved={onEventSaved}
        onDeleted={onEventDeleted}
        onCancel={onEventCancel}
      />
    );
  }

  return (
    <div className="panel configPanel builderPanel">
      <div className="panel__body">
        <BuilderPanel
          key={`builder-${builderKey ?? 0}`}
          spaceId={state.spaceId}
          onResult={onBuilderResult}
          createSequenceMode={state.createSequence}
          onSequenceCreated={onSequenceCreated}
          onNavRefresh={onNavRefresh}
          seed={builderSeed}
          onSeedConsumed={onBuilderSeedConsumed}
          onEditOperationActiveChange={onEditOperationActiveChange}
          exitEditOperationRequest={exitEditOperationRequest}
          flows={state.permissions ? state.permissions.flows : null}
        />
      </div>
    </div>
  );
}
