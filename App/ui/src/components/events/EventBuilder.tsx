import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type {
  Combinator,
  EventRuleGroup,
  EventType,
  ExternalFilter,
  ExternalFilterOperator,
  ExternalParamMapping,
  SequenceSummary,
  SimulationPackage
} from "../../state/types";
import { confirmDialog } from "../modals/confirmDialog";
import { deleteEvent, fetchEvent, generateId, saveEvent } from "../../services/api";
import { EventTestListener } from "./EventTestListener";
import { SimulationSessions } from "./SimulationSessions";
import {
  emptySimulationPackage,
  simulationPackageFromApi,
  SimulatedEventFields,
  type SimulatedEventFieldsHandle
} from "./SimulatedEventFields";
import { browserTimeZone, supportedTimeZones, timeZoneLabel } from "../../services/timezone";
import { FieldLabel, FieldTip } from "../builder/FieldTip";
import { SegmentToggle } from "../builder/SegmentToggle";
import { Toggle } from "../builder/Toggle";
import { SequenceMultiPicker } from "./SequenceMultiPicker";
import { TimeEventGroups } from "./TimeEventGroups";
import { EventInlineField } from "./EventInlineField";
import "../builder/builder.css";
import "./events.css";

const EVENT_TYPE_TIPS: Record<EventType, string> = {
  time: "Runs the selected sequences when the schedule below is met, in the timezone you pick.",
  external: "Runs the selected sequences when a matching payload is posted to this event’s inbound URL.",
  simulated: "Advances one tic at a time. Each due probability picks a weighted outcome and can run a sequence."
};

export interface EventPreviewDocument {
  name?: string;
  enabled?: boolean;
  event_type?: EventType;
  type?: EventType;
  combinator?: Combinator;
  timezone?: string;
  groups?: EventRuleGroup[];
  sequences?: string[];
  recovery_sequences?: string[];
  event_package?: {
    combinator?: Combinator;
    timezone?: string;
    groups?: EventRuleGroup[];
  };
  external_package?: {
    secret?: string;
    combinator?: Combinator;
    filters?: ExternalFilter[];
    param_mappings?: ExternalParamMapping[];
  };
  simulation_package?: Partial<SimulationPackage>;
}

interface EventBuilderProps {
  spaceId: string | null;
  /** All nav sequences; only kind === "sequence" rows are selectable targets. */
  sequences: SequenceSummary[];
  /** Existing event id when editing; null when creating a new event. */
  eventId: string | null;
  /** The user's preferred IANA timezone, used as the default for new events; null = UTC. */
  defaultTimezone: string | null;
  onSaved: (eventId: string) => void;
  onDeleted: () => void;
  /** True while a saved simulation's settings are open. */
  onEditingChange?: (editing: boolean) => void;
  consoles: { id: string; name: string }[];
  /** Bumps when the nav edit icon should open this event's settings. */
  editNonce?: number;
  /** Hydrate a proposed event and hide save and delete. */
  preview?: EventPreviewDocument | null;
}

function emptyGroup(): EventRuleGroup {
  return {
    combinator: "AND",
    is_weekday: null,
    is_date_ordinal: null,
    is_date: null,
    is_time: null,
    is_month: null,
    is_year: null
  };
}

const FILTER_OPERATORS: Array<{ value: ExternalFilterOperator; label: string }> = [
  { value: "equals", label: "equals" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "exists" },
  { value: "regex", label: "matches regex" }
];

function emptyFilter(): ExternalFilter {
  return { path: "", operator: "equals", value: "" };
}

function emptyMapping(): ExternalParamMapping {
  return { source_path: "", parameter: "" };
}

/** Base origin the browser is served from; external services POST to /api/hooks here. */
function apiOrigin(): string {
  if (typeof window !== "undefined" && window.location) return window.location.origin;
  return "";
}

/** A read-only value in a code block with a one-click copy button. */
function CopyField({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="agentTokenCode">
      <code data-testid={testId}>{value}</code>
      <button type="button" className="btnPrimary" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function EventBuilder({
  spaceId,
  sequences,
  eventId,
  defaultTimezone,
  onSaved,
  onDeleted,
  onEditingChange,
  consoles,
  editNonce = 0,
  preview = null
}: EventBuilderProps) {
  const newEventTimezone = defaultTimezone || browserTimeZone();

  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [eventType, setEventType] = useState<EventType>("time");
  const [combinator, setCombinator] = useState<Combinator>("OR");
  const [timezone, setTimezone] = useState<string>(newEventTimezone);
  const [groups, setGroups] = useState<EventRuleGroup[]>([emptyGroup()]);
  /** Bumps when a load or a new-event reset replaces `groups`, so the group editor remounts on that data. */
  const [scheduleEpoch, setScheduleEpoch] = useState(0);
  const [selectedSequences, setSelectedSequences] = useState<string[]>([]);
  const [selectedRecovery, setSelectedRecovery] = useState<string[]>([]);
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  // External-trigger state (used when eventType === "external").
  const [ingestToken, setIngestToken] = useState<string>("");
  const [secret, setSecret] = useState<string>("");
  const [externalCombinator, setExternalCombinator] = useState<Combinator>("AND");
  const [filters, setFilters] = useState<ExternalFilter[]>([]);
  const [mappings, setMappings] = useState<ExternalParamMapping[]>([]);
  const [simulation, setSimulation] = useState<SimulationPackage>(emptySimulationPackage);
  const simFieldsRef = useRef<SimulatedEventFieldsHandle>(null);
  const [loading, setLoading] = useState(Boolean(eventId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(() => editNonce > 0);
  const appliedEdit = useRef<number | null>(null);
  const seenEventId = useRef<string | null>(null);
  const [simView, setSimView] = useState<"endpoints" | "sessions">("sessions");

  // Rule values are authored directly in this zone, so no conversion is needed here.
  const timeZoneNote = timeZoneLabel(timezone);

  const sequenceOptions = useMemo(
    () => sequences.filter((sequence) => sequence.kind === "sequence"),
    [sequences]
  );

  const timezoneOptions = useMemo(() => {
    const zones = supportedTimeZones();
    return zones.includes(timezone) ? zones : [timezone, ...zones];
  }, [timezone]);

  useEffect(() => {
    if (!preview) return;
    setLoading(false);
    setError(null);
    if (preview.name != null) setName(preview.name);
    if (typeof preview.enabled === "boolean") setEnabled(preview.enabled);
    const kind = preview.event_type ?? preview.type;
    if (kind === "time" || kind === "external" || kind === "simulated") setEventType(kind);
    const schedule = preview.event_package ?? preview;
    if (schedule.combinator === "AND" || schedule.combinator === "OR") setCombinator(schedule.combinator);
    if (schedule.timezone) setTimezone(schedule.timezone);
    if (Array.isArray(schedule.groups) && schedule.groups.length) {
      setGroups(schedule.groups);
      setScheduleEpoch((epoch) => epoch + 1);
    }
    if (Array.isArray(preview.sequences)) setSelectedSequences(preview.sequences);
    if (Array.isArray(preview.recovery_sequences)) setSelectedRecovery(preview.recovery_sequences);
    const external = preview.external_package;
    if (external) {
      setSecret(external.secret || "");
      if (external.combinator === "AND" || external.combinator === "OR") {
        setExternalCombinator(external.combinator);
      }
      setFilters(Array.isArray(external.filters) ? external.filters : []);
      setMappings(Array.isArray(external.param_mappings) ? external.param_mappings : []);
    }
    if (preview.simulation_package) setSimulation(simulationPackageFromApi(preview.simulation_package));
  }, [preview]);

  useEffect(() => {
    setSimView("sessions");
    if (preview) return;
    if (!eventId) {
      setName("");
      setEnabled(true);
      setEventType("time");
      setCombinator("OR");
      setTimezone(newEventTimezone);
      setGroups([emptyGroup()]);
      setScheduleEpoch((epoch) => epoch + 1);
      setSelectedSequences([]);
      setSelectedRecovery([]);
      setParameters({});
      setIngestToken("");
      setSecret("");
      setExternalCombinator("AND");
      setFilters([]);
      setMappings([]);
      setSimulation(emptySimulationPackage());
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchEvent(eventId)
      .then((detail) => {
        if (cancelled) return;
        setName(detail.name);
        setEnabled(detail.enabled);
        setEventType(
          detail.type === "external" || detail.type === "simulated" ? detail.type : "time"
        );
        setCombinator(detail.eventPackage.combinator || "OR");
        // Legacy events have no timezone — their values were authored in UTC.
        setTimezone(detail.eventPackage.timezone || "UTC");
        setGroups(
          detail.eventPackage.groups.length > 0
            ? detail.eventPackage.groups.map((group) => ({ ...emptyGroup(), ...group }))
            : [emptyGroup()]
        );
        setScheduleEpoch((epoch) => epoch + 1);
        setSelectedSequences(detail.sequences);
        setSelectedRecovery(detail.recoverySequences);
        setParameters(detail.eventPackage.parameters || {});
        const ext = detail.externalPackage;
        setIngestToken(ext.ingest_token || "");
        setSecret(ext.secret || "");
        setExternalCombinator(ext.combinator || "AND");
        setFilters(Array.isArray(ext.filters) ? ext.filters : []);
        setMappings(Array.isArray(ext.param_mappings) ? ext.param_mappings : []);
        setSimulation(simulationPackageFromApi(detail.simulationPackage));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load event");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, preview]);

  // Open settings when the nav edit icon requests it, including when this
  // event is already on screen. A plain selection of a different event closes them.
  useEffect(() => {
    if (appliedEdit.current !== editNonce) {
      appliedEdit.current = editNonce;
      seenEventId.current = eventId;
      setSettingsOpen(editNonce > 0);
      return;
    }
    if (seenEventId.current !== eventId) {
      seenEventId.current = eventId;
      setSettingsOpen(false);
    }
  }, [eventId, editNonce]);

  const editingSettings =
    eventType === "simulated" && Boolean(eventId) && !loading && settingsOpen;
  useEffect(() => {
    onEditingChange?.(editingSettings);
    return () => onEditingChange?.(false);
  }, [editingSettings, onEditingChange]);

  function updateFilter(index: number, patch: Partial<ExternalFilter>) {
    setFilters((current) =>
      current.map((filter, i) => (i === index ? { ...filter, ...patch } : filter))
    );
  }

  function updateMapping(index: number, patch: Partial<ExternalParamMapping>) {
    setMappings((current) =>
      current.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping))
    );
  }

  const ingestUrl = ingestToken
    ? `${apiOrigin()}/api/hooks/${ingestToken}`
    : "";

  const canSave = Boolean(spaceId) && name.trim().length > 0 && !busy && !loading;

  async function handleSave() {
    if (!spaceId || !canSave) return;
    if (eventType === "simulated") {
      const problem = simFieldsRef.current?.validate();
      if (problem) {
        setError(problem);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const id = eventId ?? (await generateId());
      const result = await saveEvent({
        id,
        spaceId,
        name: name.trim(),
        enabled: eventType === "simulated" ? true : enabled,
        type: eventType,
        eventPackage: { combinator, groups, parameters, timezone },
        externalPackage:
          eventType === "external"
            ? {
                ingest_token: ingestToken || undefined,
                secret: secret.trim() || undefined,
                combinator: externalCombinator,
                filters,
                param_mappings: mappings,
                parameters
              }
            : undefined,
        simulationPackage: eventType === "simulated" ? simulation : undefined,
        sequences: eventType === "simulated" ? [] : selectedSequences,
        recoverySequences: eventType === "simulated" ? [] : selectedRecovery
      });
      // The backend mints the ingest token on first save; surface it immediately so
      // the inbound URL is visible without a reload.
      if (result.ingest_token) setIngestToken(result.ingest_token);
      if (result.simulation_token) {
        setSimulation((current) => ({ ...current, token: result.simulation_token }));
      }
      onSaved(id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save event");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!eventId) return;
    if (!(await confirmDialog(`Delete event "${name || eventId}"?`))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteEvent(eventId);
      onDeleted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete event");
    } finally {
      setBusy(false);
    }
  }

  const savedSimulation = eventType === "simulated" && Boolean(eventId) && !loading;

  const typePicker = (
    <div className="eventTypeRow" data-pin-target="event_type">
      <SegmentToggle
        ariaLabel="trigger type"
        testId="event-type-toggle"
        value={eventType}
        onChange={(next) => {
          setEventType(next);
          if (next === "simulated") setEnabled(true);
        }}
        options={[
          { value: "time", label: "time" },
          { value: "external", label: "external" },
          { value: "simulated", label: "simulated" }
        ]}
      />
      <FieldTip text={EVENT_TYPE_TIPS[eventType]} />
    </div>
  );

  const saveAndDelete = (
    <>
      <button
        className="btnPrimary"
        type="button"
        data-testid="event-save-btn"
        disabled={!canSave}
        onClick={handleSave}
      >
        {busy ? "Saving..." : eventId ? "Save changes" : "Create event"}
      </button>
      {eventId ? (
        <button
          className="btnDanger"
          type="button"
          data-testid="event-delete-btn"
          disabled={busy}
          onClick={handleDelete}
        >
          Delete
        </button>
      ) : null}
    </>
  );

  const simulationEditor =
    eventType === "simulated" && !loading ? (
      <SimulatedEventFields
        key={eventId ?? "new-simulated"}
        ref={simFieldsRef}
        initial={simulation}
        sequences={sequenceOptions}
        consoles={consoles}
        onChange={(next) =>
          setSimulation((current) => ({ ...next, token: next.token || current.token }))
        }
      />
    ) : null;

  return (
    <div className={preview ? "panel configPanel eventBuilder previewLocked" : "panel configPanel eventBuilder"}>
      <div className="panel__body">
        <div className="eventHeader">
          {eventId && !loading ? (
            <div
              className={
                name.trim()
                  ? "builderField builderPropertyName eventTitleField"
                  : "builderField builderFieldMissing builderPropertyName eventTitleField"
              }
              data-pin-target="name"
            >
              <input
                id="event-name"
                className="builderPropertyNameInput"
                aria-label="event name"
                value={name}
                placeholder="Enter an event name"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          ) : eventId ? null : (
            <h1>create an event</h1>
          )}
          {savedSimulation && settingsOpen ? (
            <button
              type="button"
              className="eventDoneEditing panelTextButton"
              data-testid="event-done-editing"
              onClick={() => setSettingsOpen(false)}
            >
              done editing
            </button>
          ) : savedSimulation ? (
            <button
              type="button"
              className="eventSettingsGear"
              aria-pressed={false}
              aria-label="event settings"
              data-testid="event-settings-toggle"
              onClick={() => setSettingsOpen(true)}
            >
              <svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                <path d="M21.731 2.269a2.625 2.625 0 0 0-3.712 0l-1.157 1.157 3.712 3.712 1.157-1.157a2.625 2.625 0 0 0 0-3.712ZM19.513 8.199l-3.712-3.712-12.15 12.15a5.25 5.25 0 0 0-1.32 2.214l-.8 2.685a.75.75 0 0 0 .933.933l2.685-.8a5.25 5.25 0 0 0 2.214-1.32L19.513 8.2Z" />
              </svg>
            </button>
          ) : null}
        </div>

        {loading ? <p className="muted">Loading event...</p> : null}

        {!savedSimulation || settingsOpen ? typePicker : null}

        {eventId && !loading ? (
          eventType !== "simulated" ? (
            <div className="eventInlineRow">
              <Toggle
                id="event-enabled-toggle"
                checked={enabled}
                onChange={setEnabled}
                label="enabled"
              />
            </div>
          ) : null
        ) : (
        <div className="eventInlineRow">
          <div
            className={
              name.trim()
                ? "builderField builderPropertyName"
                : "builderField builderFieldMissing builderPropertyName"
            }
            data-pin-target="name"
          >
            <input
              id="event-name"
              className="builderPropertyNameInput"
              aria-label="event name"
              value={name}
              placeholder="Enter an event name"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {eventType !== "simulated" ? (
            <Toggle
              id="event-enabled-toggle"
              checked={enabled}
              onChange={setEnabled}
              label="enabled"
            />
          ) : null}
        </div>
        )}

        {eventType === "external" ? (
          <div className="eventExternal eventSection">
            <EventInlineField
              label="inbound URL"
              tip="External services POST their payload here to run the sequences below. The URL is created when you first save."
            >
              {ingestUrl ? (
                <CopyField value={ingestUrl} testId="event-ingest-url" />
              ) : (
                <p className="muted">Save to generate the URL.</p>
              )}
            </EventInlineField>

            <EventTestListener
              eventId={eventId}
              ingestToken={ingestToken}
              signed={secret.trim().length > 0}
            />

            <div data-pin-target="secret">
            <EventInlineField
              label="signing secret"
              htmlFor="event-secret"
              tip="When set, callers must send an X-Pona-Signature HMAC-SHA256 of the raw body. Leave blank to accept any request."
            >
              <input
                id="event-secret"
                value={secret}
                placeholder="optional"
                onChange={(e) => setSecret(e.target.value)}
              />
            </EventInlineField>
            </div>

            <div data-pin-target="filters">
            <EventInlineField
              label="filters"
              heading={filters.length > 0 ? "h2" : undefined}
              tip="Only matching payloads fire the event. No filters means every request."
            >
              {filters.length > 0 ? (
                <select
                  id="event-ext-combinator"
                  aria-label="filter combinator"
                  value={externalCombinator}
                  onChange={(e) => setExternalCombinator(e.target.value as Combinator)}
                >
                  <option value="AND">all (AND)</option>
                  <option value="OR">any (OR)</option>
                </select>
              ) : (
                <button
                  type="button"
                  className="tinyBtn"
                  onClick={() => setFilters((c) => [...c, emptyFilter()])}
                >
                  + Add filter
                </button>
              )}
            </EventInlineField>

            {filters.length > 0 ? (
              <div className="eventInlineNest">
              <div className="eventInlineList">
                {filters.map((filter, index) => (
                  <Fragment key={index}>
                  {index > 0 ? (
                    <div className="builderJunctionDivider" aria-hidden="true">
                      <span>{externalCombinator}</span>
                    </div>
                  ) : null}
                  <div className="eventInlineGroup">
                    <button
                      type="button"
                      className="builderPropertyRemove"
                      aria-label={`Remove filter ${index + 1}`}
                      title="Remove filter"
                      onClick={() => setFilters((c) => c.filter((_, i) => i !== index))}
                    >
                      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                        <path
                          d="M2 2 L10 10 M10 2 L2 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                    <EventInlineField label="path">
                      <input
                        aria-label={`Filter ${index + 1} path`}
                        value={filter.path}
                        placeholder="event.type"
                        onChange={(e) => updateFilter(index, { path: e.target.value })}
                      />
                    </EventInlineField>
                    <EventInlineField label="operator">
                      <select
                        aria-label={`Filter ${index + 1} operator`}
                        value={filter.operator}
                        onChange={(e) =>
                          updateFilter(index, {
                            operator: e.target.value as ExternalFilterOperator
                          })
                        }
                      >
                        {FILTER_OPERATORS.map((op) => (
                          <option key={op.value} value={op.value}>
                            {op.label}
                          </option>
                        ))}
                      </select>
                    </EventInlineField>
                    <EventInlineField label="value">
                      <input
                        aria-label={`Filter ${index + 1} value`}
                        value={filter.value}
                        placeholder="value"
                        disabled={filter.operator === "exists"}
                        onChange={(e) => updateFilter(index, { value: e.target.value })}
                      />
                    </EventInlineField>
                  </div>
                  </Fragment>
                ))}
                <button
                  type="button"
                  className="tinyBtn eventInlineAdd"
                  onClick={() => setFilters((c) => [...c, emptyFilter()])}
                >
                  + Add filter
                </button>
              </div>
              </div>
            ) : null}
            </div>

            <div data-pin-target="mappings">
            <EventInlineField
              label="mappings"
              heading={mappings.length > 0 ? "h2" : undefined}
              tip="Copy values from the inbound payload into sequence parameters."
            >
              {mappings.length === 0 ? (
                <button
                  type="button"
                  className="tinyBtn"
                  onClick={() => setMappings((c) => [...c, emptyMapping()])}
                >
                  + Add mapping
                </button>
              ) : null}
            </EventInlineField>

            {mappings.length > 0 ? (
              <div className="eventInlineNest">
              <div className="eventInlineList">
                {mappings.map((mapping, index) => (
                  <div className="eventInlineGroup" key={index}>
                    <button
                      type="button"
                      className="builderPropertyRemove"
                      aria-label={`Remove mapping ${index + 1}`}
                      title="Remove mapping"
                      onClick={() => setMappings((c) => c.filter((_, i) => i !== index))}
                    >
                      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                        <path
                          d="M2 2 L10 10 M10 2 L2 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                    <EventInlineField label="source">
                      <input
                        aria-label={`Mapping ${index + 1} source path`}
                        value={mapping.source_path}
                        placeholder="user.email"
                        onChange={(e) => updateMapping(index, { source_path: e.target.value })}
                      />
                    </EventInlineField>
                    <EventInlineField label="parameter">
                      <input
                        aria-label={`Mapping ${index + 1} parameter`}
                        value={mapping.parameter}
                        placeholder="parameter name"
                        onChange={(e) => updateMapping(index, { parameter: e.target.value })}
                      />
                    </EventInlineField>
                  </div>
                ))}
                <button
                  type="button"
                  className="tinyBtn eventInlineAdd"
                  onClick={() => setMappings((c) => [...c, emptyMapping()])}
                >
                  + Add mapping
                </button>
              </div>
              </div>
            ) : null}
            </div>
          </div>
        ) : null}

        {savedSimulation ? (
          <div className="eventExternal eventSection eventSettingsFields" hidden={!settingsOpen}>
            {simulationEditor}
            {preview ? null : <div className="buttonRow eventSettingsActions">{saveAndDelete}</div>}
          </div>
        ) : eventType === "simulated" && !loading ? (
          <div className="eventExternal eventSection">
            {simulationEditor}
            <SimulationSessions
              eventId={eventId}
              token={simulation.token || ""}
              spaceId={spaceId}
              consoleId={simulation.console_id || ""}
              sequences={sequences}
            />
          </div>
        ) : null}

        {savedSimulation ? (
          <div className="eventSimViews">
            <SegmentToggle
              ariaLabel="simulation view"
              testId="sim-view-toggle"
              value={simView}
              onChange={setSimView}
              options={[
                { value: "sessions", label: "sessions" },
                { value: "endpoints", label: "endpoints" }
              ]}
            />
            <div className="eventExternal">
              <SimulationSessions
                view={simView}
                eventId={eventId}
                token={simulation.token || ""}
                spaceId={spaceId}
                consoleId={simulation.console_id || ""}
                sequences={sequences}
              />
            </div>
          </div>
        ) : null}

        {eventType === "time" ? (
        <div className="eventSection">
          <div className="field" data-pin-target="timezone">
            <FieldLabel tip="Dates and times below are read in this zone. DST is handled automatically.">
              timezone
            </FieldLabel>
            <select
              id="event-timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {timezoneOptions.map((zone) => (
                <option key={zone} value={zone}>
                  {timeZoneLabel(zone)}
                </option>
              ))}
            </select>
          </div>
          {!loading ? (
            <TimeEventGroups
              key={scheduleEpoch}
              groups={groups}
              combinator={combinator}
              timeZoneNote={timeZoneNote}
              onGroupsChange={setGroups}
              onCombinatorChange={setCombinator}
            />
          ) : null}
        </div>
        ) : null}

        {eventType !== "simulated" ? (
        <div className={eventType === "external" ? "eventSection eventSectionFlat" : "eventSection"}>
          <SequenceMultiPicker
            label="sequences"
            tip="Sequences that run when this event fires."
            sequences={sequenceOptions}
            selected={selectedSequences}
            onChange={setSelectedSequences}
            pickerTestId="event-sequence-picker"
            menuTestId="event-sequence-menu"
            pinTarget="sequences"
          />
        </div>
        ) : null}

        {eventType === "time" ? (
        <div className="eventSection">
          <SequenceMultiPicker
            label="recovery"
            tip="Run these if a scheduled fire was missed while the engine was offline."
            sequences={sequenceOptions}
            selected={selectedRecovery}
            onChange={setSelectedRecovery}
            pickerTestId="event-recovery-picker"
            menuTestId="event-recovery-menu"
            placeholder="Add a recovery sequence"
            pinTarget="recovery_sequences"
          />
        </div>
        ) : null}

        {error ? <p className="errorText">{error}</p> : null}

        {preview || savedSimulation ? null : <div className="buttonRow">{saveAndDelete}</div>}
      </div>
    </div>
  );
}
