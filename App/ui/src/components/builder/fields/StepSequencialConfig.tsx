import { useEffect, useState } from "react";
import {
  callStepWarnings,
  formatStepBodyJson,
  HTTP_DEFAULT_TIMEOUT_SECONDS,
  LLM_DEFAULT_TIMEOUT_SECONDS,
  validateStepBodyJson,
  waitStepWarnings,
  type WaitMode
} from "@pona-flow/authoring";
import { useBuilder } from "../../../state/builder/BuilderContext";
import { stepCreateReferencesExistingNode } from "../../../state/builder/cardReset";
import type {
  HttpMethod,
  NodePattern,
  SequencialProperties,
  StepResponseParameter,
  StepType
} from "../../../state/builder/types";
import { fetchEvents, fetchLocalLlmConfigs } from "../../../services/api";
import type { EventSummary } from "../../../state/types";
import { SegmentToggle } from "../SegmentToggle";
import { DurationField } from "./DurationField";
import { StepBodyEditor } from "./StepBodyEditor";
import { StepResponseParametersSection } from "./StepResponseParametersSection";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function formatHeadersJson(headers: Record<string, unknown> | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return "";
  try {
    return JSON.stringify(headers, null, 2);
  } catch {
    return "";
  }
}

/** Prefer an explicit endpoint; otherwise use the space table default (if any). */
function resolveStepEndpoint(current: string | undefined, spaceDefault: string): string {
  const trimmed = (current ?? "").trim();
  if (trimmed) return trimmed;
  return (spaceDefault ?? "").trim();
}

function mergeSequencialProperties(
  sp: SequencialProperties,
  spaceDefaultEndpoint: string,
  patch: Partial<SequencialProperties>
): SequencialProperties {
  return {
    ...sp,
    ...patch,
    endpoint: resolveStepEndpoint(
      patch.endpoint !== undefined ? patch.endpoint : sp.endpoint,
      spaceDefaultEndpoint
    )
  };
}

interface CallRetryFieldsProps {
  sp: SequencialProperties;
  timeoutDefault: number;
  warnings: string[];
  onCommit: (patch: Partial<SequencialProperties>) => void;
}

function CallRetryFields({ sp, timeoutDefault, warnings, onCommit }: CallRetryFieldsProps) {
  return (
    <>
      <DurationField
        label="timeout"
        allowParameter
        testId="builder-call-timeout"
        value={sp.timeout_seconds ?? timeoutDefault}
        hint="How long this call may run before it fails. Failure publishes ok=false (HTTP also publishes status) for edge conditions, and retries if attempts remain."
        onChange={(next) => onCommit({ timeout_seconds: next })}
      />
      {warnings.length > 0 ? (
        <span className="builderCheckMsg error">{warnings[0]}</span>
      ) : null}
      <div className="builderField">
        <label>max attempts</label>
        <input
          type="number"
          min={1}
          max={20}
          data-testid="builder-call-max-attempts"
          value={sp.max_attempts ?? 1}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onCommit({ max_attempts: Math.trunc(n) });
          }}
        />
        <span className="createSequenceHint">
          Includes the first try. After the last failure the walk continues with ok=false so an
          edge can escalate.
        </span>
      </div>
      <DurationField
        label="retry backoff"
        allowParameter
        testId="builder-call-backoff"
        value={sp.backoff_seconds ?? 0}
        hint="Wait between retries. 0 retries immediately; longer values park the run until the scheduler wakes it."
        onChange={(next) => onCommit({ backoff_seconds: next })}
      />
    </>
  );
}

interface StepSequencialConfigProps {
  node: NodePattern;
  onPatch: (patch: Partial<NodePattern>) => void;
  bodyCheckKey?: string;
}

export function StepSequencialConfig({
  node,
  onPatch,
  bodyCheckKey
}: StepSequencialConfigProps) {
  const { state, dispatch } = useBuilder();
  const highlightParameters = !stepCreateReferencesExistingNode(state.query);
  const sp: SequencialProperties = node.sequencial_properties ?? {};
  const stepType: StepType =
    sp.step_type === "code"
      ? "code"
      : sp.step_type === "local_llm"
        ? "local_llm"
        : sp.step_type === "wait"
          ? "wait"
          : sp.step_type === "join"
            ? "join"
            : "http";
  const waitMode: WaitMode =
    sp.wait_mode === "until" || sp.wait_mode === "event" ? sp.wait_mode : "duration";

  const [bodyRaw, setBodyRaw] = useState(() => formatStepBodyJson(sp.body));
  const [headersRaw, setHeadersRaw] = useState(() => formatHeadersJson(sp.headers));
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [localLlmConfigs, setLocalLlmConfigs] = useState<
    Array<{ id: string; name: string; model: string }>
  >([]);
  const [localLlmLoadError, setLocalLlmLoadError] = useState<string | null>(null);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventsLoadError, setEventsLoadError] = useState<string | null>(null);

  function reportCheck(result: { valid: boolean; message: string }) {
    if (!bodyCheckKey) return;
    dispatch({
      type: "SET_CHECK",
      key: bodyCheckKey,
      check: result.valid
        ? { status: "ok", message: result.message }
        : { status: "error", message: result.message }
    });
  }

  function reportBodyCheck(raw: string) {
    const result = validateStepBodyJson(raw);
    reportCheck(result);
    return result;
  }

  function commitSequencial(patch: Partial<SequencialProperties>) {
    onPatch({
      sequencial_properties: mergeSequencialProperties(sp, state.spaceDefaultEndpoint, patch)
    });
  }

  function commitBodyRaw(raw: string) {
    const result = reportBodyCheck(raw);
    if (result.valid) {
      commitSequencial({ body: result.value ?? {} });
    }
  }

  function commitHeadersRaw(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      setHeadersError(null);
      commitSequencial({ headers: {} });
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setHeadersError("Headers must be a JSON object.");
        return;
      }
      setHeadersError(null);
      commitSequencial({ headers: parsed as Record<string, unknown> });
    } catch {
      setHeadersError("Invalid JSON.");
    }
  }

  function setResponseParameters(response_parameters: StepResponseParameter[]) {
    // Keep the editing buffer intact (including in-progress empty rows) so the
    // "+ ADD RESPONSE PARAMETER" button can grow the list and users can type
    // freely. Trimming/dropping empty rows happens at serialize time
    // (composer `normalizeStepResponseParameters`), not on every keystroke.
    commitSequencial({
      response_parameters: response_parameters.length > 0 ? response_parameters : undefined
    });
  }

  const endpointValue = resolveStepEndpoint(sp.endpoint, state.spaceDefaultEndpoint);

  // Apply the space default endpoint when the field is still empty (HTTP steps only).
  useEffect(() => {
    if (stepType !== "http") return;
    const spaceEp = (state.spaceDefaultEndpoint ?? "").trim();
    if (!spaceEp || (sp.endpoint ?? "").trim()) return;
    commitSequencial({ endpoint: spaceEp, body: sp.body ?? {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.spaceDefaultEndpoint, stepType]);

  useEffect(() => {
    if (stepType !== "http") return;
    const formatted = formatStepBodyJson(sp.body);
    setBodyRaw(formatted);
    reportBodyCheck(formatted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp.body, stepType]);

  useEffect(() => {
    setHeadersRaw(formatHeadersJson(sp.headers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp.headers]);

  useEffect(() => {
    if (stepType !== "code") return;
    reportCheck({
      valid: false,
      message: "Code-execution STEPs are no longer supported."
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepType]);

  // Local LLM mode: require a selected config.
  useEffect(() => {
    if (stepType !== "local_llm") return;
    const ok = Boolean((sp.local_llm_config_id ?? "").trim());
    reportCheck({
      valid: ok,
      message: ok ? "valid" : "required"
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepType, sp.local_llm_config_id]);

  useEffect(() => {
    if (stepType !== "wait") return;
    const warnings = waitStepWarnings({ ...sp, step_type: "wait" });
    reportCheck({
      valid: warnings.length === 0,
      message: warnings[0] ?? "valid"
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stepType,
    waitMode,
    sp.wait_duration_seconds,
    sp.wait_until,
    sp.wait_event_id
  ]);

  useEffect(() => {
    if (stepType !== "local_llm" || !state.spaceId) return;
    let cancelled = false;
    setLocalLlmLoadError(null);
    fetchLocalLlmConfigs(state.spaceId)
      .then((list) => {
        if (cancelled) return;
        setLocalLlmConfigs(
          list.map((c) => ({ id: c.id, name: c.name, model: c.model }))
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setLocalLlmLoadError(
          err instanceof Error ? err.message : "Could not load local LLM configs."
        );
        setLocalLlmConfigs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [stepType, state.spaceId]);

  useEffect(() => {
    if (stepType !== "wait" || !state.spaceId) return;
    let cancelled = false;
    setEventsLoadError(null);
    fetchEvents(state.spaceId)
      .then((list) => {
        if (cancelled) return;
        setEvents(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setEventsLoadError(err instanceof Error ? err.message : "Could not load events.");
        setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [stepType, state.spaceId]);

  function switchStepType(next: StepType) {
    if (next === stepType) return;
    if (next === "wait") {
      commitSequencial({ step_type: "wait", wait_mode: waitMode || "duration" });
      return;
    }
    if (next === "join") {
      commitSequencial({ step_type: "join" });
      return;
    }
    commitSequencial({ step_type: next });
  }

  const bodyCheck = bodyCheckKey ? state.checks[bodyCheckKey] : undefined;
  const localLlmMissing = !(sp.local_llm_config_id ?? "").trim();
  const waitWarnings = stepType === "wait" ? waitStepWarnings({ ...sp, step_type: "wait" }) : [];
  const callWarnings =
    stepType === "http" || stepType === "local_llm" ? callStepWarnings({ ...sp, step_type: stepType }) : [];
  const selectedWaitEvent = events.find((event) => event.id === (sp.wait_event_id ?? "").trim());
  const waitEventAlsoTargetsThis =
    Boolean(state.query.id) &&
    Boolean(selectedWaitEvent?.sequences?.includes(state.query.id));

  function isoToDatetimeLocal(iso: string): string {
    const trimmed = iso.trim();
    if (!trimmed || trimmed.startsWith("$")) return trimmed;
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return trimmed;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function datetimeLocalToIso(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("$")) return trimmed;
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return trimmed;
    return date.toISOString();
  }

  return (
    <div className="builderBlock">
      {stepType === "code" ? (
        <div className="builderField">
          <p className="muted">
            This STEP was a code-execution step, which is no longer supported. Convert it to
            an HTTP request or Local LLM step, or delete it.
          </p>
          <button type="button" onClick={() => switchStepType("http")}>
            Convert to HTTP request
          </button>
          <button type="button" onClick={() => switchStepType("local_llm")}>
            Convert to Local LLM
          </button>
        </div>
      ) : (
        <>
          <div className="builderField builderSegmentField">
            <label id="builder-step-type-label">step type</label>
            <SegmentToggle
              labelledBy="builder-step-type-label"
              value={stepType}
              testId="builder-step-type"
              options={[
                { value: "http", label: "HTTP request" },
                { value: "local_llm", label: "Local LLM" },
                { value: "wait", label: "Wait" },
                { value: "join", label: "Join" }
              ]}
              onChange={switchStepType}
            />
          </div>
          {stepType === "local_llm" ? (
            <>
              <div className="builderField">
                <label>
                  local LLM config
                  {localLlmLoadError ? (
                    <span className="builderCheckMsg error">{localLlmLoadError}</span>
                  ) : localLlmMissing ? (
                    <span className="builderCheckMsg error">required</span>
                  ) : bodyCheck?.status === "ok" ? (
                    <span className="builderCheckMsg ok">{bodyCheck.message}</span>
                  ) : null}
                </label>
                <select
                  value={sp.local_llm_config_id ?? ""}
                  onChange={(e) => commitSequencial({ local_llm_config_id: e.target.value })}
                >
                  <option value="" disabled>
                    Select a saved config
                  </option>
                  {localLlmConfigs.map((config) => (
                    <option key={config.id} value={config.id}>
                      {config.name} ({config.model})
                    </option>
                  ))}
                </select>
              </div>
              <p className="muted">
                At run time this step calls Ollama with the saved config. The prompt is always the
                sequence parameter <code>prompt</code> (<code>$prompt</code>). The optional
                parameters <code>system_prompt</code>, <code>response_format</code>,{" "}
                <code>json_schema</code>, <code>temperature</code>, <code>top_p</code>,{" "}
                <code>top_k</code>, <code>min_p</code>, <code>repeat_penalty</code>,{" "}
                <code>num_ctx</code>, <code>num_predict</code>, <code>seed</code> and{" "}
                <code>stop</code> override the saved config for a single run — leave one blank to
                keep the config&apos;s value.
              </p>
              <CallRetryFields
                sp={sp}
                timeoutDefault={LLM_DEFAULT_TIMEOUT_SECONDS}
                warnings={callWarnings}
                onCommit={commitSequencial}
              />
            </>
          ) : stepType === "wait" ? (
            <>
              <div className="builderField builderSegmentField">
                <label id="builder-wait-mode-label">wait for</label>
                {waitWarnings.length > 0 ? (
                  <span className="builderCheckMsg error">{waitWarnings[0]}</span>
                ) : bodyCheck?.status === "ok" ? (
                  <span className="builderCheckMsg ok">{bodyCheck.message}</span>
                ) : null}
                <SegmentToggle
                  labelledBy="builder-wait-mode-label"
                  value={waitMode}
                  testId="builder-wait-mode"
                  options={[
                    { value: "duration", label: "Duration" },
                    { value: "until", label: "Until" },
                    { value: "event", label: "Event" }
                  ]}
                  onChange={(mode) => commitSequencial({ wait_mode: mode })}
                />
              </div>
              {waitMode === "duration" ? (
                <DurationField
                  label="duration"
                  allowParameter
                  testId="builder-wait-duration"
                  value={sp.wait_duration_seconds ?? 0}
                  hint="The run parks and resumes after this delay. $parameter values are seconds."
                  onChange={(next) => commitSequencial({ wait_duration_seconds: next })}
                />
              ) : null}
              {waitMode === "until" ? (
                <div className="builderField">
                  <label>until</label>
                  <input
                    type="datetime-local"
                    data-testid="builder-wait-until"
                    value={isoToDatetimeLocal(String(sp.wait_until ?? ""))}
                    onChange={(e) =>
                      commitSequencial({ wait_until: datetimeLocalToIso(e.target.value) })
                    }
                  />
                  <span className="createSequenceHint">
                    ISO datetime. A $parameter is also allowed below.
                  </span>
                  <input
                    className="builderMono"
                    placeholder="$wake_at"
                    value={
                      String(sp.wait_until ?? "").trim().startsWith("$")
                        ? String(sp.wait_until)
                        : ""
                    }
                    onChange={(e) => commitSequencial({ wait_until: e.target.value })}
                  />
                </div>
              ) : null}
              {waitMode === "event" ? (
                <div className="builderField">
                  <label>
                    event
                    {eventsLoadError ? (
                      <span className="builderCheckMsg error">{eventsLoadError}</span>
                    ) : null}
                  </label>
                  <select
                    data-testid="builder-wait-event"
                    value={sp.wait_event_id ?? ""}
                    onChange={(e) => commitSequencial({ wait_event_id: e.target.value })}
                  >
                    <option value="" disabled>
                      Select an event
                    </option>
                    {events.map((event) => (
                      <option key={event.id} value={event.id}>
                        {event.name} ({event.type})
                      </option>
                    ))}
                  </select>
                  <span className="createSequenceHint">
                    The run parks until this event fires. Time and external events both work.
                  </span>
                  {waitEventAlsoTargetsThis ? (
                    <span className="builderCheckMsg error">
                      This sequence is also a target of that event, so a fire would start a new
                      run and resume this waiter.
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : stepType === "join" ? (
            <p className="muted">
              A join continues only after every inbound arm that actually ran has finished.
              Draw the arms into this step; the outgoing edge is what happens next. Unused
              conditional branches do not block it. Arms still run one at a time — this is a
              meeting point, not parallel execution.
            </p>
          ) : (
            <>
              <div className="builderField">
                <label>endpoint</label>
                <input
                  className="builderMono"
                  placeholder={state.spaceDefaultEndpoint.trim() || "https://api.example.com/webhook"}
                  value={endpointValue}
                  onChange={(e) => commitSequencial({ endpoint: e.target.value, body: sp.body ?? {} })}
                />
              </div>
              <div className="builderField">
                <label>method</label>
                <select
                  value={sp.method ?? "POST"}
                  onChange={(e) => commitSequencial({ method: e.target.value as HttpMethod })}
                >
                  {HTTP_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </div>
              <div className="builderField">
                <label>
                  headers (JSON)
                  {headersError ? <span className="builderCheckMsg error">{headersError}</span> : null}
                </label>
                <input
                  className="builderMono"
                  placeholder='{"Authorization": "Bearer $token"}'
                  value={headersRaw}
                  onChange={(e) => {
                    setHeadersRaw(e.target.value);
                    commitHeadersRaw(e.target.value);
                  }}
                />
              </div>
              <div className="builderField">
                <label>
                  body (JSON)
                  {bodyCheck && bodyCheck.status !== "idle" ? (
                    <span className={`builderCheckMsg ${bodyCheck.status}`}>{bodyCheck.message}</span>
                  ) : null}
                </label>
                <StepBodyEditor
                  value={bodyRaw}
                  readOnly={false}
                  highlightParameters={highlightParameters}
                  parameters={state.query.parameters}
                  placeholder='{"key": "$paramName"}'
                  onChange={(raw) => {
                    setBodyRaw(raw);
                    commitBodyRaw(raw);
                  }}
                  onBlur={() => {
                    const result = reportBodyCheck(bodyRaw);
                    if (result.valid) {
                      setBodyRaw(formatStepBodyJson(result.value));
                    }
                  }}
                />
              </div>
              <CallRetryFields
                sp={sp}
                timeoutDefault={HTTP_DEFAULT_TIMEOUT_SECONDS}
                warnings={callWarnings}
                onCommit={commitSequencial}
              />
            </>
          )}
        </>
      )}

      {stepType === "wait" || stepType === "join" ? null : (
        <StepResponseParametersSection
          items={sp.response_parameters ?? []}
          onChange={setResponseParameters}
        />
      )}
    </div>
  );
}
