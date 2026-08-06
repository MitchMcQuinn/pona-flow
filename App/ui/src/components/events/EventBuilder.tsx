import { useEffect, useMemo, useState } from "react";
import type {
  Combinator,
  EventRuleGroup,
  EventType,
  ExternalFilter,
  ExternalFilterOperator,
  ExternalParamMapping,
  SequenceSummary
} from "../../state/types";
import { deleteEvent, fetchEvent, generateId, saveEvent } from "../../services/api";
import { browserTimeZone, supportedTimeZones, timeZoneLabel } from "../../services/timezone";
import "./events.css";

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
  onCancel: () => void;
}

const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" }
];

const MONTHS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Jan" },
  { value: 2, label: "Feb" },
  { value: 3, label: "Mar" },
  { value: 4, label: "Apr" },
  { value: 5, label: "May" },
  { value: 6, label: "Jun" },
  { value: 7, label: "Jul" },
  { value: 8, label: "Aug" },
  { value: 9, label: "Sep" },
  { value: 10, label: "Oct" },
  { value: 11, label: "Nov" },
  { value: 12, label: "Dec" }
];

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
function CopyField({ value }: { value: string }) {
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
      <code>{value}</code>
      <button type="button" className="btnPrimary" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function parseNumberList(text: string): number[] | null {
  const values = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
  return values.length > 0 ? values : null;
}

function formatNumberList(values: number[] | null): string {
  return values && values.length > 0 ? values.join(", ") : "";
}

/** Normalize a stored time-of-day for an <input type="time"> (tolerates a legacy "z"). */
function timeToInput(value: string | null): string {
  if (!value) return "";
  return value.trim().toLowerCase().replace(/z$/, "");
}

/** Times are stored as a plain local "HH:MM" (interpreted in the event's timezone). */
function inputToTime(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function toggleValue(current: number[] | null, value: number): number[] | null {
  const set = new Set(current ?? []);
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
  const next = Array.from(set).sort((a, b) => a - b);
  return next.length > 0 ? next : null;
}

export function EventBuilder({
  spaceId,
  sequences,
  eventId,
  defaultTimezone,
  onSaved,
  onDeleted,
  onCancel
}: EventBuilderProps) {
  const newEventTimezone = defaultTimezone || browserTimeZone();

  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [eventType, setEventType] = useState<EventType>("time");
  const [combinator, setCombinator] = useState<Combinator>("OR");
  const [timezone, setTimezone] = useState<string>(newEventTimezone);
  const [groups, setGroups] = useState<EventRuleGroup[]>([emptyGroup()]);
  const [selectedSequences, setSelectedSequences] = useState<string[]>([]);
  const [selectedRecovery, setSelectedRecovery] = useState<string[]>([]);
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  // External-trigger state (used when eventType === "external").
  const [ingestToken, setIngestToken] = useState<string>("");
  const [secret, setSecret] = useState<string>("");
  const [externalCombinator, setExternalCombinator] = useState<Combinator>("AND");
  const [filters, setFilters] = useState<ExternalFilter[]>([]);
  const [mappings, setMappings] = useState<ExternalParamMapping[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!eventId) {
      setName("");
      setEnabled(true);
      setEventType("time");
      setCombinator("OR");
      setTimezone(newEventTimezone);
      setGroups([emptyGroup()]);
      setSelectedSequences([]);
      setSelectedRecovery([]);
      setParameters({});
      setIngestToken("");
      setSecret("");
      setExternalCombinator("AND");
      setFilters([]);
      setMappings([]);
      setError(null);
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
        setEventType(detail.type === "external" ? "external" : "time");
        setCombinator(detail.eventPackage.combinator || "OR");
        // Legacy events have no timezone — their values were authored in UTC.
        setTimezone(detail.eventPackage.timezone || "UTC");
        setGroups(
          detail.eventPackage.groups.length > 0
            ? detail.eventPackage.groups.map((group) => ({ ...emptyGroup(), ...group }))
            : [emptyGroup()]
        );
        setSelectedSequences(detail.sequences);
        setSelectedRecovery(detail.recoverySequences);
        setParameters(detail.eventPackage.parameters || {});
        const ext = detail.externalPackage;
        setIngestToken(ext.ingest_token || "");
        setSecret(ext.secret || "");
        setExternalCombinator(ext.combinator || "AND");
        setFilters(Array.isArray(ext.filters) ? ext.filters : []);
        setMappings(Array.isArray(ext.param_mappings) ? ext.param_mappings : []);
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
  }, [eventId]);

  function updateGroup(index: number, patch: Partial<EventRuleGroup>) {
    setGroups((current) =>
      current.map((group, i) => (i === index ? { ...group, ...patch } : group))
    );
  }

  function addGroup() {
    setGroups((current) => [...current, emptyGroup()]);
  }

  function removeGroup(index: number) {
    setGroups((current) =>
      current.length <= 1 ? current : current.filter((_, i) => i !== index)
    );
  }

  function toggleSequence(list: string[], setList: (next: string[]) => void, id: string) {
    setList(list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]);
  }

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
    setBusy(true);
    setError(null);
    try {
      const id = eventId ?? (await generateId());
      const result = await saveEvent({
        id,
        spaceId,
        name: name.trim(),
        enabled,
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
        sequences: selectedSequences,
        recoverySequences: selectedRecovery
      });
      // The backend mints the ingest token on first save; surface it immediately so
      // the inbound URL is visible without a reload.
      if (result.ingest_token) setIngestToken(result.ingest_token);
      onSaved(id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save event");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!eventId) return;
    if (!window.confirm(`Delete event "${name || eventId}"?`)) return;
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

  return (
    <div className="panel configPanel eventBuilder">
      <div className="panel__body">
        <h2>{eventId ? "Edit event" : "New event"}</h2>
        <p className="muted">
          {eventType === "external"
            ? "External triggers run the selected sequences when a matching payload is POSTed to the event's inbound URL."
            : "Time-bound triggers run the selected sequences when the rules below are met. All rules (dates and times) are evaluated in the event timezone below."}
        </p>

        {loading ? <p className="muted">Loading event...</p> : null}

        <div className="field">
          <label htmlFor="event-name">Name</label>
          <input
            id="event-name"
            value={name}
            placeholder="e.g. Weekday morning report"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="event-type">Trigger type</label>
          <select
            id="event-type"
            value={eventType}
            onChange={(e) => setEventType(e.target.value as EventType)}
          >
            <option value="time">Time schedule</option>
            <option value="external">External event (inbound webhook)</option>
          </select>
        </div>

        <div className="field eventInlineField">
          <label className="eventCheckboxLabel">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
        </div>

        {eventType === "external" ? (
          <div className="eventExternal">
            <div className="field">
              <label>Inbound URL</label>
              {ingestUrl ? (
                <CopyField value={ingestUrl} />
              ) : (
                <p className="muted">
                  The inbound URL is generated when you first save this event.
                </p>
              )}
              <span className="eventHint">
                External services POST their payload here to trigger the sequences below.
              </span>
            </div>

            <div className="field">
              <label htmlFor="event-secret">Signing secret (optional)</label>
              <input
                id="event-secret"
                value={secret}
                placeholder="Shared secret for HMAC-SHA256 verification"
                onChange={(e) => setSecret(e.target.value)}
              />
              <span className="eventHint">
                When set, callers must send an <code>X-Pona-Signature</code> HMAC-SHA256 of
                the raw body. Leave blank to accept any request to the URL above.
              </span>
            </div>

            <div className="field">
              <label htmlFor="event-ext-combinator">Match filters</label>
              <select
                id="event-ext-combinator"
                value={externalCombinator}
                onChange={(e) => setExternalCombinator(e.target.value as Combinator)}
              >
                <option value="AND">All filters (AND)</option>
                <option value="OR">Any filter (OR)</option>
              </select>
              <span className="eventHint">
                Only payloads matching these filters fire the event. No filters = fire on
                every request.
              </span>
            </div>

            <div className="eventGroups">
              {filters.map((filter, index) => (
                <div className="eventFilterRow" key={index}>
                  <input
                    aria-label={`Filter ${index + 1} path`}
                    value={filter.path}
                    placeholder="payload path e.g. event.type"
                    onChange={(e) => updateFilter(index, { path: e.target.value })}
                  />
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
                  <input
                    aria-label={`Filter ${index + 1} value`}
                    value={filter.value}
                    placeholder="value"
                    disabled={filter.operator === "exists"}
                    onChange={(e) => updateFilter(index, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="tinyBtn danger"
                    onClick={() => setFilters((c) => c.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="tinyBtn"
                onClick={() => setFilters((c) => [...c, emptyFilter()])}
              >
                + Add filter
              </button>
            </div>

            <div className="field">
              <label>Payload to parameter mappings</label>
              <span className="eventHint">
                Extract values from the inbound payload into named sequence parameters.
              </span>
            </div>

            <div className="eventGroups">
              {mappings.map((mapping, index) => (
                <div className="eventFilterRow" key={index}>
                  <input
                    aria-label={`Mapping ${index + 1} source path`}
                    value={mapping.source_path}
                    placeholder="payload path e.g. user.email"
                    onChange={(e) => updateMapping(index, { source_path: e.target.value })}
                  />
                  <span className="eventMapArrow">→</span>
                  <input
                    aria-label={`Mapping ${index + 1} parameter`}
                    value={mapping.parameter}
                    placeholder="parameter name"
                    onChange={(e) => updateMapping(index, { parameter: e.target.value })}
                  />
                  <button
                    type="button"
                    className="tinyBtn danger"
                    onClick={() => setMappings((c) => c.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="tinyBtn"
                onClick={() => setMappings((c) => [...c, emptyMapping()])}
              >
                + Add mapping
              </button>
            </div>
          </div>
        ) : null}

        {eventType === "time" ? (
        <>
        <div className="field">
          <label htmlFor="event-timezone">Timezone</label>
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
          <span className="eventHint">
            Rules below are evaluated in this zone (DST handled automatically).
          </span>
        </div>

        <div className="field">
          <label htmlFor="event-combinator">Match</label>
          <select
            id="event-combinator"
            value={combinator}
            onChange={(e) => setCombinator(e.target.value as Combinator)}
          >
            <option value="OR">Any group (OR)</option>
            <option value="AND">All groups (AND)</option>
          </select>
        </div>

        <div className="eventGroups">
          {groups.map((group, index) => (
            <div className="eventGroup" key={index}>
              <div className="eventGroupHeader">
                <span className="eventGroupTitle">Group {index + 1}</span>
                <select
                  aria-label={`Group ${index + 1} combinator`}
                  value={group.combinator}
                  onChange={(e) => updateGroup(index, { combinator: e.target.value as Combinator })}
                >
                  <option value="AND">AND</option>
                  <option value="OR">OR</option>
                </select>
                <button
                  type="button"
                  className="tinyBtn danger"
                  disabled={groups.length <= 1}
                  onClick={() => removeGroup(index)}
                >
                  Remove
                </button>
              </div>

              <div className="field">
                <label>Weekdays</label>
                <div className="eventChips">
                  {WEEKDAYS.map((day) => (
                    <button
                      type="button"
                      key={day.value}
                      className={`eventChip${(group.is_weekday ?? []).includes(day.value) ? " active" : ""}`}
                      onClick={() =>
                        updateGroup(index, { is_weekday: toggleValue(group.is_weekday, day.value) })
                      }
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>Months</label>
                <div className="eventChips">
                  {MONTHS.map((month) => (
                    <button
                      type="button"
                      key={month.value}
                      className={`eventChip${(group.is_month ?? []).includes(month.value) ? " active" : ""}`}
                      onClick={() =>
                        updateGroup(index, { is_month: toggleValue(group.is_month, month.value) })
                      }
                    >
                      {month.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label htmlFor={`group-${index}-ordinal`}>Days of month (1-31, comma separated)</label>
                <input
                  id={`group-${index}-ordinal`}
                  value={formatNumberList(group.is_date_ordinal)}
                  placeholder="e.g. 1, 15"
                  onChange={(e) => updateGroup(index, { is_date_ordinal: parseNumberList(e.target.value) })}
                />
              </div>

              <div className="field">
                <label htmlFor={`group-${index}-years`}>Years (comma separated)</label>
                <input
                  id={`group-${index}-years`}
                  value={formatNumberList(group.is_year)}
                  placeholder="e.g. 2026, 2027"
                  onChange={(e) => updateGroup(index, { is_year: parseNumberList(e.target.value) })}
                />
              </div>

              <div className="eventRow">
                <div className="field">
                  <label htmlFor={`group-${index}-date`}>Exact date</label>
                  <input
                    id={`group-${index}-date`}
                    type="date"
                    value={group.is_date ?? ""}
                    onChange={(e) => updateGroup(index, { is_date: e.target.value || null })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`group-${index}-time`}>Time of day ({timeZoneNote})</label>
                  <input
                    id={`group-${index}-time`}
                    type="time"
                    value={timeToInput(group.is_time)}
                    onChange={(e) => updateGroup(index, { is_time: inputToTime(e.target.value) })}
                  />
                  <span className="eventHint">Empty = midnight (00:00).</span>
                </div>
              </div>
            </div>
          ))}
          <button type="button" className="tinyBtn" onClick={addGroup}>
            + Add group
          </button>
        </div>
        </>
        ) : null}

        <div className="field">
          <label>Sequences to run</label>
          {sequenceOptions.length === 0 ? (
            <p className="muted">No sequences available in this space.</p>
          ) : (
            <div className="eventSeqList">
              {sequenceOptions.map((sequence) => (
                <label key={sequence.id} className="eventCheckboxLabel">
                  <input
                    type="checkbox"
                    checked={selectedSequences.includes(sequence.id)}
                    onChange={() =>
                      toggleSequence(selectedSequences, setSelectedSequences, sequence.id)
                    }
                  />
                  {sequence.label}
                </label>
              ))}
            </div>
          )}
        </div>

        {eventType === "time" ? (
        <div className="field">
          <label>Recovery sequences (run if a fire was missed while offline)</label>
          {sequenceOptions.length === 0 ? (
            <p className="muted">No sequences available in this space.</p>
          ) : (
            <div className="eventSeqList">
              {sequenceOptions.map((sequence) => (
                <label key={sequence.id} className="eventCheckboxLabel">
                  <input
                    type="checkbox"
                    checked={selectedRecovery.includes(sequence.id)}
                    onChange={() =>
                      toggleSequence(selectedRecovery, setSelectedRecovery, sequence.id)
                    }
                  />
                  {sequence.label}
                </label>
              ))}
            </div>
          )}
        </div>
        ) : null}

        {error ? <p className="errorText">{error}</p> : null}

        <div className="buttonRow">
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
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
