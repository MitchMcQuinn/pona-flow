import { forwardRef, useImperativeHandle, useState } from "react";
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
        <div className="eventRow">
          <div className="field">
            <label htmlFor="sim-tic-unit">Tic unit</label>
            <select
              id="sim-tic-unit"
              value={pkg.tic_unit}
              onChange={(event) => commit({ ...pkg, tic_unit: event.target.value as TicUnit })}
            >
              {TIC_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sim-tic-duration">Tic duration</label>
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
        </div>
        <span className="eventHint">
          Each tic moves the in-world clock by this duration. Tics advance only when a session
          is stepped, not on a wall-clock schedule.
        </span>

        <div className="field">
          <label htmlFor="sim-sequence">Sequence to run</label>
          <select
            id="sim-sequence"
            value={pkg.sequence_id || ""}
            onChange={(event) => commit({ ...pkg, sequence_id: event.target.value })}
          >
            <option value="">Record only</option>
            {sequences.map((sequence) => (
              <option key={sequence.id} value={sequence.id}>
                {sequence.label}
              </option>
            ))}
          </select>
          <span className="eventHint">
            When an outcome is chosen, this sequence runs with the outcome payload as its
            parameters. Leave it empty to store the emission without running a sequence.
          </span>
        </div>

        <div className="eventGroups" data-testid="sim-probabilities">
          {pkg.probabilities.map((probability, index) => {
            const schedule = probability.schedule;
            return (
              <div className="eventGroup" key={probability.id}>
                <div className="eventGroupHeader">
                  <span className="eventGroupTitle">Probability {index + 1}</span>
                  <button
                    type="button"
                    className="tinyBtn danger"
                    onClick={() =>
                      commit({
                        ...pkg,
                        probabilities: pkg.probabilities.filter((item) => item.id !== probability.id)
                      })
                    }
                  >
                    Remove
                  </button>
                </div>

                <div className="field">
                  <label htmlFor={`sim-probability-name-${probability.id}`}>Name</label>
                  <input
                    id={index === 0 ? "sim-probability-name" : `sim-probability-name-${probability.id}`}
                    value={probability.name}
                    placeholder="e.g. Weather"
                    onChange={(event) => updateProbability(probability.id, { name: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`sim-probability-note-${probability.id}`}>Description</label>
                  <input
                    id={`sim-probability-note-${probability.id}`}
                    value={probability.description}
                    onChange={(event) =>
                      updateProbability(probability.id, { description: event.target.value })
                    }
                  />
                </div>
                <div className="eventRow">
                  <div className="field">
                    <label htmlFor={`sim-priority-${probability.id}`}>Priority</label>
                    <input
                      id={`sim-priority-${probability.id}`}
                      type="number"
                      value={probability.priority}
                      onChange={(event) =>
                        updateProbability(probability.id, { priority: Number(event.target.value) || 0 })
                      }
                    />
                    <span className="eventHint">Lower numbers run first. Equal priorities are shuffled.</span>
                  </div>
                  <div className="field">
                    <label htmlFor={`sim-schedule-${probability.id}`}>Schedule</label>
                    <select
                      id={`sim-schedule-${probability.id}`}
                      value={schedule.type}
                      onChange={(event) => {
                        const type = event.target.value;
                        if (type === "scheduled") updateSchedule(probability.id, { type: "scheduled", tics: [1] });
                        else if (type === "random") {
                          updateSchedule(probability.id, { type: "random", every_x: 1, percent: 50 });
                        } else updateSchedule(probability.id, { type: "recurring", every_x: 1, delay_y: 0 });
                      }}
                    >
                      <option value="recurring">Recurring</option>
                      <option value="scheduled">Scheduled tics</option>
                      <option value="random">Random</option>
                    </select>
                  </div>
                </div>

                {schedule.type === "recurring" ? (
                  <div className="eventRow">
                    <div className="field">
                      <label>Every X tics</label>
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
                      <label>Delay Y tics</label>
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
                  </div>
                ) : null}

                {schedule.type === "random" ? (
                  <div className="eventRow">
                    <div className="field">
                      <label>Every X tics</label>
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
                      <label>Percent</label>
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
                  </div>
                ) : null}

                {schedule.type === "scheduled" ? (
                  <div className="field">
                    <label>Tic numbers (comma separated)</label>
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

                {probability.outcomes.map((outcome, outcomeIndex) => {
                  const weightRef = outcome.weight.trim().startsWith("$");
                  const rowPairs = outcomePairs(outcome);
                  return (
                    <div className="simOutcome" key={outcome.id}>
                      <div className="eventGroupHeader">
                        <span className="eventGroupTitle">Outcome {outcomeIndex + 1}</span>
                        <button
                          type="button"
                          className="tinyBtn danger"
                          onClick={() =>
                            updateProbability(probability.id, {
                              outcomes: probability.outcomes.filter((item) => item.id !== outcome.id)
                            })
                          }
                        >
                          Remove
                        </button>
                      </div>
                      <div className="eventRow">
                        <div className="field">
                          <label htmlFor={`sim-outcome-label-${outcome.id}`}>Label</label>
                          <input
                            id={`sim-outcome-label-${outcome.id}`}
                            value={outcome.label}
                            onChange={(event) =>
                              updateOutcome(probability.id, outcome.id, { label: event.target.value })
                            }
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={outcomeIndex === 0 && index === 0 ? "sim-outcome-weight" : `sim-outcome-weight-${outcome.id}`}>
                            Weight
                          </label>
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
                          <span className="eventHint">
                            A number, or $parameter read from the weight sequence. Negatives become 0.
                            If every weight is 0, the run is cancelled.
                          </span>
                        </div>
                      </div>
                      {weightRef ? (
                        <div className="field">
                          <label htmlFor={`sim-weight-sequence-${outcome.id}`}>Weight sequence</label>
                          <select
                            id={`sim-weight-sequence-${outcome.id}`}
                            value={outcome.weight_sequence_id || ""}
                            onChange={(event) =>
                              updateOutcome(probability.id, outcome.id, {
                                weight_sequence_id: event.target.value
                              })
                            }
                          >
                            <option value="">Select a sequence</option>
                            {sequences.map((sequence) => (
                              <option key={sequence.id} value={sequence.id}>
                                {sequence.label}
                              </option>
                            ))}
                          </select>
                          <span className="eventHint">
                            Runs before the outcome is chosen. The weight is that sequence&apos;s resolved
                            value for {outcome.weight.trim()}. If it is missing or not a number, the
                            parameter default is used, then 0.
                          </span>
                        </div>
                      ) : null}

                      <div className="field">
                        <label>Payload</label>
                        <div className="eventChips">
                          <button
                            type="button"
                            className={`eventChip${outcome.payload_mode !== "json" ? " active" : ""}`}
                            onClick={() => {
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
                          >
                            Fields
                          </button>
                          <button
                            type="button"
                            className={`eventChip${outcome.payload_mode === "json" ? " active" : ""}`}
                            onClick={() => {
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
                            }}
                          >
                            JSON
                          </button>
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
