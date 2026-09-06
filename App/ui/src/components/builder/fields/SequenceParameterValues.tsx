import { isEmptySequenceBindingValue } from "@pona-flow/authoring";
import type { ExecutionStepParameter } from "../../../services/api";
import { TypedValueInput } from "./TypedValueInput";

export function bindingToInputString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function bindableStepParameters(pkg: {
  steps?: Array<{ parameters?: ExecutionStepParameter[] }>;
  response_parameters?: Array<{ parameter: string }>;
}): ExecutionStepParameter[] {
  const responseNames = new Set(
    (pkg.response_parameters ?? [])
      .map((responseParam) => (responseParam.parameter || "").trim())
      .filter((name) => name.length > 0)
  );
  const seen = new Set<string>();
  const params: ExecutionStepParameter[] = [];
  for (const step of pkg.steps ?? []) {
    for (const parameter of step.parameters ?? []) {
      const name = (parameter.name || "").trim();
      if (!name || seen.has(name) || responseNames.has(name) || parameter.auto_generate) {
        continue;
      }
      seen.add(name);
      params.push(parameter);
    }
  }
  return params;
}

export function boundParameterNames(values: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>();
  if (!values) return names;
  for (const [key, value] of Object.entries(values)) {
    const name = key.trim();
    if (!name || isEmptySequenceBindingValue(value)) continue;
    names.add(name);
  }
  return names;
}

interface SequenceParameterValuesProps {
  parameters: ExecutionStepParameter[];
  values: Record<string, string>;
  onChange: (name: string, raw: string) => void;
  loading: boolean;
  /** True before an entry STEP is chosen, when there is nothing to inspect. */
  waitingForEntry: boolean;
}

/**
 * Sequence-level values for the STEP parameters this chain will run.
 *
 * Definitions stay on the STEPs; filling a value here bakes it into the sequence
 * so a run does not pause (or ask MCP/webhook callers) for that name.
 */
export function SequenceParameterValues({
  parameters,
  values,
  onChange,
  loading,
  waitingForEntry
}: SequenceParameterValuesProps) {
  return (
    <section className="builderBlock createSequenceFields" data-testid="sequence-parameter-values">
      <div className="builderHeadRow">
        <label>Parameter values</label>
      </div>
      <span className="createSequenceHint">
        Pre-set a STEP parameter for this sequence only. Leave it blank to collect the
        value when the sequence runs.
      </span>

      {waitingForEntry ? (
        <p className="createSequenceHint">Pick an entry STEP to see the parameters it uses.</p>
      ) : loading ? (
        <p className="createSequenceHint">Loading parameters from this sequence&rsquo;s steps…</p>
      ) : parameters.length === 0 ? (
        <p className="createSequenceHint">This chain has no caller-supplied STEP parameters.</p>
      ) : (
        parameters.map((parameter) => {
          const name = parameter.name;
          return (
            <div key={name} className="builderField" data-testid={`sequence-param-value-${name}`}>
              <div className="createSequenceLabelRow">
                <label htmlFor={`seq-param-${name}`}>{name}</label>
                {parameter.is_required ? (
                  <span className="createSequenceHint">pauses for input if left blank</span>
                ) : (
                  <span className="createSequenceHint">optional</span>
                )}
              </div>
              <TypedValueInput
                id={`seq-param-${name}`}
                valueType={parameter.value_type || "string"}
                options={parameter.options}
                minChoices={parameter.min_choices}
                maxChoices={parameter.max_choices}
                value={values[name] ?? ""}
                onChange={(raw) => onChange(name, raw)}
                placeholder={parameter.value_type === "string" ? "Leave blank to collect at run time" : undefined}
              />
            </div>
          );
        })
      )}
    </section>
  );
}
