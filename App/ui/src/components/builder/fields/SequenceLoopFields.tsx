import { useMemo } from "react";
import {
  DEFAULT_MAX_ITERATIONS,
  LOOP_COMPARISON_OPERATORS,
  LOOP_TYPES,
  LOOP_TYPE_LABELS,
  isDagLoop
} from "@pona-flow/authoring";
import type {
  LoopComparisonOperator,
  LoopConfig,
  LoopType
} from "@pona-flow/authoring";
import type { ExecutionAvailableParameters } from "../../../services/api";
import { Picker } from "../Picker";

interface SequenceLoopFieldsProps {
  loop: LoopConfig;
  onLoop: (loop: LoopConfig) => void;
  disabled: boolean;
  /**
   * Names the sequence's steps publish, from the last compose. Empty for a sequence
   * that has never been saved — there is no STEP chain to compose yet.
   */
  availableParameters: ExecutionAvailableParameters[];
  /** True before the first save, when the pickers cannot be populated. */
  unsaved: boolean;
  warnings: string[];
}

/**
 * Sequence-level loop configuration.
 *
 * The cycle itself is drawn in the graph — a POINTS_TO edge back to an earlier STEP —
 * so nothing here says *where* the loop is. These fields only say when it ends, which
 * is why the same chain can be run once, N times, or once per row without redrawing it.
 *
 * The pickers are fed by the compose response rather than the builder's own QueryObject:
 * a sequence's read query is one node plus `-[*]->`, so the builder never sees the steps
 * it will traverse, let alone the aliases they project.
 */
export function SequenceLoopFields({
  loop,
  onLoop,
  disabled,
  availableParameters,
  unsaved,
  warnings
}: SequenceLoopFieldsProps) {
  const aliasOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const entry of availableParameters) {
      for (const alias of entry.aliases ?? []) {
        const name = (alias || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        options.push({
          value: name,
          label: entry.label ? `${name}  (${entry.label})` : name
        });
      }
    }
    return options;
  }, [availableParameters]);

  const type = loop.type;
  const looping = !isDagLoop(loop);
  const condition = loop.condition ?? {
    parameter: "",
    operator: "=" as LoopComparisonOperator,
    value: ""
  };

  function patch(next: Partial<LoopConfig>) {
    onLoop({ ...loop, ...next });
  }

  return (
    <section className="builderBlock createSequenceFields">
      <div className="builderField">
        <label>sequence type</label>
        <Picker
          value={type}
          placeholder="DAG (no looping)"
          disabled={disabled}
          options={LOOP_TYPES.map((value) => ({
            value,
            label: LOOP_TYPE_LABELS[value as LoopType]
          }))}
          onSelect={(value) => patch({ type: value as LoopType })}
        />
        <span className="createSequenceHint">
          {type === "dag"
            ? "Each step runs once, so a transition back to an earlier step ends the run."
            : "Draw the cycle as a transition from a later step back to an earlier one. This sets when it stops."}
        </span>
      </div>

      {type === "for" ? (
        <div className="builderField">
          <div className="createSequenceLabelRow">
            <label>iterations</label>
          </div>
          <input
            type="number"
            min={0}
            value={loop.count ?? ""}
            placeholder="How many passes"
            disabled={disabled}
            onChange={(e) =>
              patch({ count: e.target.value === "" ? undefined : Number(e.target.value) })
            }
          />
          <span className="createSequenceHint">Zero skips the looped steps entirely.</span>
        </div>
      ) : null}

      {type === "for_while" ? (
        <>
          <div className="builderField">
            <label>while parameter</label>
            <Picker
              value={condition.parameter}
              placeholder={unsaved ? "Save the sequence first" : "Please select"}
              disabled={disabled || unsaved}
              options={aliasOptions}
              emptyHint="No RETURN aliases found on this sequence's steps."
              onSelect={(value) => patch({ condition: { ...condition, parameter: value } })}
            />
          </div>
          <div className="builderField">
            <label>operator</label>
            <select
              value={condition.operator}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  condition: {
                    ...condition,
                    operator: e.target.value as LoopComparisonOperator
                  }
                })
              }
            >
              {LOOP_COMPARISON_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </div>
          <div className="builderField">
            <label>value</label>
            <input
              className="builderMono"
              value={condition.value}
              placeholder="true"
              disabled={disabled}
              onChange={(e) => patch({ condition: { ...condition, value: e.target.value } })}
            />
            <span className="createSequenceHint">
              Tested before every pass, including the first — an already-false condition
              skips the looped steps.
            </span>
          </div>
        </>
      ) : null}

      {type === "for_each" ? (
        <div className="builderField">
          <label>iterate rows of</label>
          <Picker
            value={loop.source ?? ""}
            placeholder={unsaved ? "Save the sequence first" : "Please select"}
            disabled={disabled || unsaved}
            options={aliasOptions}
            emptyHint="No RETURN aliases found on this sequence's steps."
            onSelect={(value) => patch({ source: value })}
          />
          <span className="createSequenceHint">
            One pass per row. Each pass binds that row&rsquo;s columns under their aliases,
            so the looped steps see one entity at a time.
          </span>
        </div>
      ) : null}

      {looping ? (
        <div className="builderField">
          <label>maximum iterations (optional)</label>
          <input
            type="number"
            min={1}
            value={loop.max_iterations ?? ""}
            placeholder={String(DEFAULT_MAX_ITERATIONS)}
            disabled={disabled}
            onChange={(e) =>
              patch({
                max_iterations: e.target.value === "" ? undefined : Number(e.target.value)
              })
            }
          />
          <span className="createSequenceHint">
            Safety cap: a run that exceeds it fails instead of looping forever.
          </span>
        </div>
      ) : null}

      {looping && unsaved ? (
        <span className="createSequenceHint">
          A sequence has to be saved once before its steps can be inspected, so the
          pickers stay empty until then.
        </span>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="createSequenceLoopWarnings">
          {warnings.map((warning, index) => (
            <li key={index} className="createSequenceRequired">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
