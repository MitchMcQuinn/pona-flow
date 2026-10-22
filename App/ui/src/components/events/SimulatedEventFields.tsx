import { forwardRef, useImperativeHandle, useState } from "react";
import { FieldLabel } from "../builder/FieldTip";
import { Picker } from "../builder/Picker";
import { SegmentToggle } from "../builder/SegmentToggle";
import "../builder/builder.css";
import type {
  ProbabilitySchedule,
  SequenceSummary,
  SimulationOutcome,
  SimulationPackage,
  SimulationProbability,
  TicUnit
} from "../../state/types";

const TIC_UNITS: TicUnit[] = ["seconds", "minutes", "hours", "days"];

function localId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

function CardRemove({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="builderPropertyRemove"
      aria-label={label}
      title={label}
      onClick={onClick}
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
  );
}

function emptyOutcome(): SimulationOutcome {
  return {
    id: localId("out"),
    label: "",
    weight: "1",
    weight_sequence_id: "",
    payload: {},
    payload_mode: "fields"
  };
}

function emptyProbability(): SimulationProbability {
  return {
    id: localId("prb"),
    name: "",
    description: "",
    priority: 1,
    schedule: { type: "recurring", every_x: 1, delay_y: 0 },
    outcomes: [emptyOutcome()]
  };
}

export function emptySimulationPackage(): SimulationPackage {
  return {
    tic_unit: "minutes",
    tic_duration: 15,
    sequence_id: "",
    probabilities: [emptyProbability()]
  };
}

function asSchedule(raw: Partial<ProbabilitySchedule> | undefined): ProbabilitySchedule {
  if (raw?.type === "scheduled") {
    const tics = Array.isArray(raw.tics) ? raw.tics.map((tic) => Number(tic)).filter((n) => Number.isFinite(n)) : [];
    return { type: "scheduled", tics };
  }
  if (raw?.type === "random") {
    return {
      type: "random",
      every_x: Number(raw.every_x) || 1,
      percent: Number(raw.percent) || 0
    };
  }
  const recurring = raw?.type === "recurring" ? raw : undefined;
  return {
    type: "recurring",
    every_x: Number(recurring?.every_x) || 1,
    delay_y: Number(recurring?.delay_y) || 0
  };
}

function asOutcome(raw: Partial<SimulationOutcome> | undefined): SimulationOutcome {
  const weight =
    raw?.weight === undefined || raw.weight === null ? "1" : String(raw.weight);
  return {
    id: raw?.id || localId("out"),
    label: raw?.label || "",
    weight,
    weight_sequence_id: raw?.weight_sequence_id || "",
    payload: raw?.payload && typeof raw.payload === "object" ? raw.payload : {},
    payload_mode: raw?.payload_mode === "json" ? "json" : "fields"
  };
}

/** Turn a stored package (or an empty one) into a form the editor can render. */
export function simulationPackageFromApi(raw: Partial<SimulationPackage> | undefined): SimulationPackage {
  const ticUnit = TIC_UNITS.includes(raw?.tic_unit as TicUnit) ? (raw?.tic_unit as TicUnit) : "minutes";
  const duration = Number(raw?.tic_duration);
  const probabilities = Array.isArray(raw?.probabilities)
    ? raw.probabilities.map((item) => ({
        id: item?.id || localId("prb"),
        name: item?.name || "",
        description: item?.description || "",
        priority: Number.isFinite(Number(item?.priority)) ? Number(item?.priority) : 1,
        schedule: asSchedule(item?.schedule),
        outcomes:
          Array.isArray(item?.outcomes) && item.outcomes.length > 0
            ? item.outcomes.map((outcome) => asOutcome(outcome))
            : [emptyOutcome()]
      }))
    : [];
  return {
    token: raw?.token,
    tic_unit: ticUnit,
    tic_duration: Number.isFinite(duration) && duration > 0 ? duration : 15,
    sequence_id: raw?.sequence_id || "",
    probabilities: probabilities.length > 0 ? probabilities : [emptyProbability()]
  };
}

type PayloadPair = { id: string; key: string; value: string };

function valueToField(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function fieldToValue(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text !== "" && !Number.isNaN(Number(text))) return Number(text);
  try {
    return JSON.parse(text);
  } catch {
    return raw;
  }
}

function pairsFromPayload(payload: Record<string, unknown>): PayloadPair[] {
  const entries = Object.entries(payload);
  if (entries.length === 0) return [{ id: localId("pair"), key: "", value: "" }];
  return entries.map(([key, value]) => ({ id: localId("pair"), key, value: valueToField(value) }));
}

function payloadFromPairs(pairs: PayloadPair[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const pair of pairs) {
    if (!pair.key.trim()) continue;
    payload[pair.key.trim()] = fieldToValue(pair.value);
  }
  return payload;
}

function parsePayloadJson(
  text: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Custom payload must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Custom payload is not valid JSON" };
  }
}

export interface SimulatedEventFieldsHandle {
  /** Null when the form can be saved. Otherwise a message to show. */
  validate(): string | null;
}

interface SimulatedEventFieldsProps {
  initial: SimulationPackage;
  sequences: SequenceSummary[];
  onChange: (next: SimulationPackage) => void;
}

export const SimulatedEventFields = forwardRef<SimulatedEventFieldsHandle, SimulatedEventFieldsProps>(
  function SimulatedEventFields({ initial, sequences, onChange }, ref) {
    const [pkg, setPkg] = useState<SimulationPackage>(initial);
    const [pairs, setPairs] = useState<Record<string, PayloadPair[]>>(() => {
      const seeded: Record<string, PayloadPair[]> = {};
      for (const probability of initial.probabilities) {
        for (const outcome of probability.outcomes) {
          seeded[outcome.id] = pairsFromPayload(outcome.payload || {});
        }
      }
      return seeded;
    });
    const [jsonText, setJsonText] = useState<Record<string, string>>(() => {
      const seeded: Record<string, string> = {};
      for (const probability of initial.probabilities) {
        for (const outcome of probability.outcomes) {
          if (outcome.payload_mode === "json") {
            seeded[outcome.id] = JSON.stringify(outcome.payload || {}, null, 2);
          }
        }
      }
      return seeded;
    });
    const [jsonError, setJsonError] = useState<Record<string, string>>({});

    function commit(next: SimulationPackage) {
      setPkg(next);
      onChange(next);
    }

    useImperativeHandle(ref, () => ({
      validate() {
        for (const probability of pkg.probabilities) {
          for (const outcome of probability.outcomes) {
            if (outcome.payload_mode !== "json") continue;
            const text = jsonText[outcome.id] ?? JSON.stringify(outcome.payload || {}, null, 2);
            const parsed = parsePayloadJson(text);
            if (!parsed.ok) {
              return `${outcome.label.trim() || "Outcome"}: ${parsed.error}`;
            }
          }
        }
        return null;
      }
    }));

    function updateProbability(id: string, patch: Partial<SimulationProbability>) {
      commit({
        ...pkg,
        probabilities: pkg.probabilities.map((item) => (item.id === id ? { ...item, ...patch } : item))
      });
    }

    function updateSchedule(id: string, schedule: ProbabilitySchedule) {
      updateProbability(id, { schedule });
    }

    function updateOutcome(probabilityId: string, outcomeId: string, patch: Partial<SimulationOutcome>) {
      const probability = pkg.probabilities.find((item) => item.id === probabilityId);
      if (!probability) return;
      updateProbability(probabilityId, {
        outcomes: probability.outcomes.map((item) => (item.id === outcomeId ? { ...item, ...patch } : item))
      });
    }

    function outcomePairs(outcome: SimulationOutcome): PayloadPair[] {
      return pairs[outcome.id] || pairsFromPayload(outcome.payload || {});
    }

    function setOutcomePairs(probabilityId: string, outcome: SimulationOutcome, nextPairs: PayloadPair[]) {
      setPairs((current) => ({ ...current, [outcome.id]: nextPairs }));
      updateOutcome(probabilityId, outcome.id, { payload: payloadFromPairs(nextPairs), payload_mode: "fields" });
    }

    return (
      <div className="simFields" data-testid="sim-fields">
        <div className="eventInlineRow">
          <div className="field">
            <FieldLabel tip="Each tic moves the in-world clock by this amount. Tics advance only when a session is stepped.">
              tic unit
            </FieldLabel>
            <Picker
              id="sim-tic-unit"
              ariaLabel="tic unit"
              value={pkg.tic_unit}
              placeholder="Please select"
              options={TIC_UNITS.map((unit) => ({ value: unit, label: unit }))}
              onSelect={(value) => commit({ ...pkg, tic_unit: value as TicUnit })}
            />
          </div>
          <div className="field">
            <FieldLabel>duration</FieldLabel>
            <input
              id="sim-tic-duration"
              type="number"
              min={1}
              value={pkg.tic_duration}
              onChange={(event) =>
                commit({ ...pkg, tic_duration: Number(event.target.value) || 0 })
              }
            />
          </div>
          <div className="field">
            <FieldLabel tip="When an outcome is chosen, this sequence runs with the outcome payload. Leave empty to record the emission only.">
              sequence
            </FieldLabel>
            <Picker
              id="sim-sequence"
              ariaLabel="sequence"
              toggleTestId="sim-sequence-toggle"
              menuTestId="sim-sequence-menu"
              value={pkg.sequence_id || ""}
              placeholder="Record only"
              options={[
                { value: "", label: "Record only" },
                ...sequences.map((sequence) => ({ value: sequence.id, label: sequence.label }))
              ]}
              onSelect={(value) => commit({ ...pkg, sequence_id: value })}
            />
          </div>
        </div>

        <h2 className="builderPanelTitle simSectionTitle">probabilities</h2>
        <div className="eventGroups" data-testid="sim-probabilities">
          {pkg.probabilities.map((probability, index) => {
            const schedule = probability.schedule;
            return (
              <div className="eventGroup eventCardRemovable" key={probability.id}>
                <CardRemove
                  label="Remove probability"
                  onClick={() =>
                    commit({
                      ...pkg,
                      probabilities: pkg.probabilities.filter((item) => item.id !== probability.id)
                    })
                  }
                />
                <div
                  className={
                    probability.name.trim()
                      ? "builderField builderPropertyName"
                      : "builderField builderFieldMissing builderPropertyName"
                  }
                >
                  <input
                    id={index === 0 ? "sim-probability-name" : `sim-probability-name-${probability.id}`}
                    className="builderPropertyNameInput"
                    aria-label="probability name"
                    value={probability.name}
                    placeholder="Enter a probability name"
                    onChange={(event) => updateProbability(probability.id, { name: event.target.value })}
                  />
                </div>
                <div className="field">
                  <FieldLabel>description</FieldLabel>
                  <input
                    id={`sim-probability-note-${probability.id}`}
                    value={probability.description}
                    placeholder="Enter an optional description"
                    onChange={(event) =>
                      updateProbability(probability.id, { description: event.target.value })
                    }
                  />
                </div>
                <div className="eventInlineRow">
                  <div className="field">
                    <FieldLabel tip="Lower numbers run first. Equal priorities are shuffled.">
                      priority
                    </FieldLabel>
                    <input
                      id={`sim-priority-${probability.id}`}
                      type="number"
                      value={probability.priority}
                      onChange={(event) =>
                        updateProbability(probability.id, { priority: Number(event.target.value) || 0 })
                      }
                    />
                  </div>
                  <div className="field">
                    <FieldLabel>schedule</FieldLabel>
                    <Picker
                      id={`sim-schedule-${probability.id}`}
                      ariaLabel="schedule"
                      value={schedule.type}
                      placeholder="Please select"
                      options={[
                        { value: "recurring", label: "recurring" },
                        { value: "scheduled", label: "scheduled tics" },
                        { value: "random", label: "random" }
                      ]}
                      onSelect={(type) => {
                        if (type === "scheduled") updateSchedule(probability.id, { type: "scheduled", tics: [1] });
                        else if (type === "random") {
                          updateSchedule(probability.id, { type: "random", every_x: 1, percent: 50 });
                        } else updateSchedule(probability.id, { type: "recurring", every_x: 1, delay_y: 0 });
                      }}
                    />
                  </div>
                  {schedule.type === "recurring" ? (
                    <>
                      <div className="field">
                        <FieldLabel tip="How often this probability is considered.">every</FieldLabel>
                        <input
                          type="number"
                          min={1}
                          value={schedule.every_x}
                          onChange={(event) =>
                            updateSchedule(probability.id, {
                              type: "recurring",
                              every_x: Number(event.target.value) || 0,
                              delay_y: schedule.delay_y
                            })
                          }
                        />
                      </div>
                      <div className="field">
                        <FieldLabel tip="Skip this many tics before the first check.">delay</FieldLabel>
                        <input
                          type="number"
                          min={0}
                          value={schedule.delay_y}
                          onChange={(event) =>
                            updateSchedule(probability.id, {
                              type: "recurring",
                              every_x: schedule.every_x,
                              delay_y: Number(event.target.value) || 0
                            })
                          }
                        />
                      </div>
                    </>
                  ) : null}
                  {schedule.type === "random" ? (
                    <>
                      <div className="field">
                        <FieldLabel tip="How often this probability is considered.">every</FieldLabel>
                        <input
                          type="number"
                          min={1}
                          value={schedule.every_x}
                          onChange={(event) =>
                            updateSchedule(probability.id, {
                              type: "random",
                              every_x: Number(event.target.value) || 0,
                              percent: schedule.percent
                            })
                          }
                        />
                      </div>
                      <div className="field">
                        <FieldLabel tip="Chance this probability fires on a matching tic.">percent</FieldLabel>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={schedule.percent}
                          onChange={(event) =>
                            updateSchedule(probability.id, {
                              type: "random",
                              every_x: schedule.every_x,
                              percent: Number(event.target.value) || 0
                            })
                          }
                        />
                      </div>
                    </>
                  ) : null}
                  {schedule.type === "scheduled" ? (
                    <div className="field">
                      <FieldLabel tip="Comma-separated tic numbers when this probability is due.">
                        tics
                      </FieldLabel>
                      <input
                        value={schedule.tics.join(", ")}
                        placeholder="1, 5, 10"
                        onChange={(event) => {
                          const tics = event.target.value
                            .split(",")
                            .map((part) => Number(part.trim()))
                            .filter((n) => Number.isFinite(n));
                          updateSchedule(probability.id, { type: "scheduled", tics });
                        }}
                      />
                    </div>
                  ) : null}
                </div>

                <div className="simOutcomes">
                <h3 className="builderPanelTitle simOutcomesTitle">outcomes</h3>
                {probability.outcomes.map((outcome, outcomeIndex) => {
                  const weightRef = outcome.weight.trim().startsWith("$");
                  const rowPairs = outcomePairs(outcome);
                  return (
                    <div className="simOutcome eventCardRemovable" key={outcome.id}>
                      <CardRemove
                        label="Remove outcome"
                        onClick={() =>
                          updateProbability(probability.id, {
                            outcomes: probability.outcomes.filter((item) => item.id !== outcome.id)
                          })
                        }
                      />
                      <div className="eventInlineRow simOutcomeTitleRow">
                        <div
                          className={
                            outcome.label.trim()
                              ? "builderField builderPropertyName"
                              : "builderField builderFieldMissing builderPropertyName"
                          }
                        >
                          <input
                            id={`sim-outcome-label-${outcome.id}`}
                            className="builderPropertyNameInput"
                            aria-label="outcome label"
                            value={outcome.label}
                            placeholder="Enter an outcome label"
                            onChange={(event) =>
                              updateOutcome(probability.id, outcome.id, { label: event.target.value })
                            }
                          />
                        </div>
                        <div className="field simOutcomeWeight">
                          <FieldLabel tip="A number, or $parameter from the weight sequence. Negatives become 0. If every weight is 0, the run is cancelled.">
                            weight
                          </FieldLabel>
                          <input
                            id={
                              outcomeIndex === 0 && index === 0
                                ? "sim-outcome-weight"
                                : `sim-outcome-weight-${outcome.id}`
                            }
                            value={outcome.weight}
                            placeholder="5 or $rain_score"
                            onChange={(event) =>
                              updateOutcome(probability.id, outcome.id, { weight: event.target.value })
                            }
                          />
                        </div>
                      </div>
                      {weightRef ? (
                        <div className="field">
                          <FieldLabel tip={`Runs first. The weight is that sequence’s value for ${outcome.weight.trim()}. If it is missing or not a number, the parameter default is used, then 0.`}>
                            weight sequence
                          </FieldLabel>
                          <Picker
                            id={`sim-weight-sequence-${outcome.id}`}
                            ariaLabel="weight sequence"
                            value={outcome.weight_sequence_id || ""}
                            placeholder="Select a sequence"
                            options={sequences.map((sequence) => ({
                              value: sequence.id,
                              label: sequence.label
                            }))}
                            emptyHint="No sequences available"
                            onSelect={(value) =>
                              updateOutcome(probability.id, outcome.id, {
                                weight_sequence_id: value
                              })
                            }
                          />
                        </div>
                      ) : null}

                      <div className="field">
                        <div className="simPayloadRow">
                          <FieldLabel>payload</FieldLabel>
                          <SegmentToggle
                            ariaLabel="payload format"
                            testId={`sim-payload-mode-${outcome.id}`}
                            value={outcome.payload_mode === "json" ? "json" : "fields"}
                            onChange={(mode) => {
                              if (mode === "json") {
                                if (outcome.payload_mode === "json") return;
                                const payload = payloadFromPairs(outcomePairs(outcome));
                                setJsonText((current) => ({
                                  ...current,
                                  [outcome.id]: JSON.stringify(payload, null, 2)
                                }));
                                updateOutcome(probability.id, outcome.id, {
                                  payload,
                                  payload_mode: "json"
                                });
                                return;
                              }
                              if (outcome.payload_mode !== "json") return;
                              const text = jsonText[outcome.id] ?? JSON.stringify(outcome.payload || {}, null, 2);
                              const parsed = parsePayloadJson(text);
                              if (!parsed.ok) {
                                setJsonError((current) => ({ ...current, [outcome.id]: parsed.error }));
                                return;
                              }
                              setPairs((current) => ({
                                ...current,
                                [outcome.id]: pairsFromPayload(parsed.value)
                              }));
                              setJsonError((current) => ({ ...current, [outcome.id]: "" }));
                              updateOutcome(probability.id, outcome.id, {
                                payload: parsed.value,
                                payload_mode: "fields"
                              });
                            }}
                            options={[
                              { value: "fields", label: "fields" },
                              { value: "json", label: "json" }
                            ]}
                          />
                        </div>
                        {outcome.payload_mode === "json" ? (
                          <>
                            <textarea
                              rows={5}
                              value={jsonText[outcome.id] ?? JSON.stringify(outcome.payload || {}, null, 2)}
                              onChange={(event) => {
                                const text = event.target.value;
                                setJsonText((current) => ({ ...current, [outcome.id]: text }));
                                const parsed = parsePayloadJson(text);
                                if (!parsed.ok) {
                                  setJsonError((current) => ({ ...current, [outcome.id]: parsed.error }));
                                  return;
                                }
                                setJsonError((current) => ({ ...current, [outcome.id]: "" }));
                                updateOutcome(probability.id, outcome.id, {
                                  payload: parsed.value,
                                  payload_mode: "json"
                                });
                              }}
                            />
                            {jsonError[outcome.id] ? (
                              <span className="errorText">{jsonError[outcome.id]}</span>
                            ) : null}
                          </>
                        ) : (
                          <>
                            {rowPairs.map((pair) => (
                              <div className="eventFilterRow" key={pair.id}>
                                <input
                                  aria-label="Payload key"
                                  value={pair.key}
                                  placeholder="key"
                                  onChange={(event) =>
                                    setOutcomePairs(
                                      probability.id,
                                      outcome,
                                      rowPairs.map((item) =>
                                        item.id === pair.id ? { ...item, key: event.target.value } : item
                                      )
                                    )
                                  }
                                />
                                <input
                                  aria-label="Payload value"
                                  value={pair.value}
                                  placeholder="value"
                                  onChange={(event) =>
                                    setOutcomePairs(
                                      probability.id,
                                      outcome,
                                      rowPairs.map((item) =>
                                        item.id === pair.id ? { ...item, value: event.target.value } : item
                                      )
                                    )
                                  }
                                />
                                <button
                                  type="button"
                                  className="tinyBtn danger"
                                  onClick={() =>
                                    setOutcomePairs(
                                      probability.id,
                                      outcome,
                                      rowPairs.filter((item) => item.id !== pair.id)
                                    )
                                  }
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              className="tinyBtn"
                              onClick={() =>
                                setOutcomePairs(probability.id, outcome, [
                                  ...rowPairs,
                                  { id: localId("pair"), key: "", value: "" }
                                ])
                              }
                            >
                              + Add field
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  className="tinyBtn"
                  onClick={() =>
                    updateProbability(probability.id, {
                      outcomes: [...probability.outcomes, emptyOutcome()]
                    })
                  }
                >
                  + Add outcome
                </button>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            className="tinyBtn"
            onClick={() => commit({ ...pkg, probabilities: [...pkg.probabilities, emptyProbability()] })}
          >
            + Add probability
          </button>
        </div>
      </div>
    );
  }
);
