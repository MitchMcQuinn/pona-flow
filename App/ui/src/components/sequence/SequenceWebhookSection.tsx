import { useState } from "react";
import type { ExecutionPackage, ExecutionStepParameter } from "../../services/api";

interface SequenceWebhookSectionProps {
  spaceId: string;
  sequenceId: string;
  executionPackage: ExecutionPackage | null;
  composeError: string | null;
  currentValues: Record<string, unknown>;
}

function apiOrigin(): string {
  if (typeof window !== "undefined" && window.location) return window.location.origin;
  return "";
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Caller-supplied inputs across a sequence's steps — same rules as the webhook discovery list. */
export function callerInputParameters(pkg: ExecutionPackage): ExecutionStepParameter[] {
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

function paramHasFilledValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return String(value).trim() !== "";
}

function paramsPayload(
  inputs: ExecutionStepParameter[],
  currentValues: Record<string, unknown>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const parameter of inputs) {
    const filled = currentValues[parameter.name];
    if (paramHasFilledValue(filled)) {
      payload[parameter.name] = filled;
      continue;
    }
    if (paramHasFilledValue(parameter.default_value)) {
      payload[parameter.name] = parameter.default_value;
      continue;
    }
    payload[parameter.name] = `<${parameter.name}>`;
  }
  return payload;
}

export function buildSequenceCurl(options: {
  origin: string;
  spaceId: string;
  sequenceId: string;
  inputs: ExecutionStepParameter[];
  currentValues: Record<string, unknown>;
}): string {
  const url = `${options.origin}/api/spaces/${encodeURIComponent(options.spaceId)}/sequences/${encodeURIComponent(options.sequenceId)}/run`;
  const body = JSON.stringify({ params: paramsPayload(options.inputs, options.currentValues) }, null, 2);
  return [
    `curl -X POST ${shellSingleQuote(url)} \\`,
    `  -H "X-Pona-Flow-Key: $STG_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${shellSingleQuote(body)}`
  ].join("\n");
}

/**
 * Collapsible webhook helper for a selected sequence: copy a ready-to-run curl command
 * and inspect the caller-supplied parameter inputs the body should include.
 */
export function SequenceWebhookSection({
  spaceId,
  sequenceId,
  executionPackage,
  composeError,
  currentValues
}: SequenceWebhookSectionProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const loading = executionPackage === null && !composeError;
  const inputs = executionPackage ? callerInputParameters(executionPackage) : [];
  const curl = buildSequenceCurl({
    origin: apiOrigin(),
    spaceId,
    sequenceId,
    inputs,
    currentValues
  });

  async function copyCurl() {
    try {
      await navigator.clipboard.writeText(curl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="builderStepParams sequenceWebhook" data-testid="sequence-webhook">
      <button
        type="button"
        className={"builderStepParamsToggle" + (open ? " is-open" : "")}
        aria-expanded={open}
        data-testid="sequence-webhook-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        <span>Webhook{inputs.length ? ` (${inputs.length})` : ""}</span>
        <span className="builderStepParamsChevron" aria-hidden>
          ▸
        </span>
      </button>

      {open ? (
        <div className="builderStepParamsBody sequenceWebhookBody">
          <p className="muted sequenceWebhookHint">
            Copy a curl command to run this sequence from an agent or script. Replace{" "}
            <code>$STG_KEY</code> with an agent key from Space settings → Agents.
          </p>

          <div className="sequenceWebhookCopyRow">
            <button
              type="button"
              className="tinyBtn"
              data-testid="sequence-webhook-copy"
              disabled={loading}
              onClick={copyCurl}
            >
              {copied ? "Copied" : "Copy curl"}
            </button>
          </div>
          <pre className="sequenceWebhookCurl" data-testid="sequence-webhook-curl">
            {curl}
          </pre>

          <h3 className="sequenceWebhookInputsHead">Parameter inputs</h3>
          {loading ? (
            <p className="muted">Collecting inputs from the sequence…</p>
          ) : composeError ? (
            <p className="muted">Inputs unavailable: {composeError}</p>
          ) : inputs.length === 0 ? (
            <p className="muted">This sequence has no caller-supplied inputs.</p>
          ) : (
            <table className="responseParamsTable" data-testid="sequence-webhook-params">
              <thead>
                <tr>
                  <th>name</th>
                  <th>type</th>
                  <th>required</th>
                </tr>
              </thead>
              <tbody>
                {inputs.map((parameter) => (
                  <tr key={parameter.name} data-testid={`sequence-webhook-param-${parameter.name}`}>
                    <th>{parameter.name}</th>
                    <td>
                      <code>{parameter.value_type || "string"}</code>
                    </td>
                    <td>{parameter.is_required ? "required" : "optional"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
}
