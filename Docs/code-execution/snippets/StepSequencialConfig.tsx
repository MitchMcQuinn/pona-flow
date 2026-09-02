import { useEffect, useState } from "react";
import { useBuilder } from "../../../state/builder/BuilderContext";
import { stepCreateReferencesExistingNode } from "../../../state/builder/cardReset";
import type {
  CodeLanguage,
  HttpMethod,
  NodePattern,
  SequencialProperties,
  StepType
} from "../../../state/builder/types";
import { fetchCodeResource } from "../../../services/resources";
import { fetchLocalLlmConfigs } from "../../../services/api";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const CODE_LANGUAGES: Array<{ value: CodeLanguage; label: string }> = [
  { value: "python", label: "Python" },
  { value: "javascript", label: "JavaScript" }
];

const CODE_PLACEHOLDER: Record<CodeLanguage, string> = {
  python:
    '# $param tokens are replaced with their values before the code runs in a sandbox.\n# Return JSON via print, e.g.\n# print(json.dumps({"total": $amount}))',
  javascript:
    '// $param tokens are replaced with their values before the code runs in a sandbox.\n// Return JSON via console.log, e.g.\n// console.log(JSON.stringify({ total: $amount }));'
};

function formatHeadersJson(headers: Record<string, unknown> | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return "";
  try {
    return JSON.stringify(headers, null, 2);
  } catch {
    return "";
  }
}
import {
  formatStepBodyJson,
  validateStepBodyJson
} from "@pona-flow/authoring";
import { SegmentToggle } from "../SegmentToggle";
import { StepBodyEditor } from "./StepBodyEditor";
import { StepResponseParametersSection } from "./StepResponseParametersSection";
import type { StepResponseParameter } from "../../../state/builder/types";

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

/** Validate the code-execution form: name and code are required. */
export function validateStepCodeConfig(sp: SequencialProperties): {
  valid: boolean;
  message: string;
} {
  if (!(sp.resource_name ?? "").trim()) {
    return { valid: false, message: "required" };
  }
  if (!(sp.code ?? "").trim()) {
    return { valid: false, message: "required" };
  }
  return { valid: true, message: "valid" };
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
    sp.step_type === "code" ? "code" : sp.step_type === "local_llm" ? "local_llm" : "http";

  const [bodyRaw, setBodyRaw] = useState(() => formatStepBodyJson(sp.body));
  const [headersRaw, setHeadersRaw] = useState(() => formatHeadersJson(sp.headers));
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [resourceLoadError, setResourceLoadError] = useState<string | null>(null);
  const [localLlmConfigs, setLocalLlmConfigs] = useState<
    Array<{ id: string; name: string; model: string }>
  >([]);
  const [localLlmLoadError, setLocalLlmLoadError] = useState<string | null>(null);

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

  // Code mode: keep the card check in sync with the name/code form state.
  useEffect(() => {
    if (stepType !== "code") return;
    reportCheck(validateStepCodeConfig(sp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepType, sp.resource_name, sp.code]);

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

  // Editing an existing code step: the entity payload carries only the resource UID,
  // so fetch the script (code + name/description/language) from the resources API.
  useEffect(() => {
    if (stepType !== "code") return;
    const resourceId = (sp.resource_id ?? "").trim();
    if (!resourceId || sp.code !== undefined || !state.spaceId) return;
    let cancelled = false;
    setResourceLoadError(null);
    fetchCodeResource(state.spaceId, resourceId)
      .then((resource) => {
        if (cancelled) return;
        commitSequencial({
          resource_name: resource.name,
          resource_description: resource.description,
          language: resource.language,
          code: resource.code
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setResourceLoadError(err instanceof Error ? err.message : "Could not load code resource.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepType, sp.resource_id, sp.code, state.spaceId]);

  function switchStepType(next: StepType) {
    if (next === stepType) return;
    commitSequencial({ step_type: next });
  }

  const bodyCheck = bodyCheckKey ? state.checks[bodyCheckKey] : undefined;
  const language: CodeLanguage = sp.language === "javascript" ? "javascript" : "python";
  const nameMissing = !(sp.resource_name ?? "").trim();
  const codeMissing = !(sp.code ?? "").trim();
  const localLlmMissing = !(sp.local_llm_config_id ?? "").trim();

  return (
    <div className="builderBlock">
      <div className="builderField builderSegmentField">
        <label id="builder-step-type-label">step type</label>
        <SegmentToggle
          labelledBy="builder-step-type-label"
          value={stepType}
          options={[
            { value: "http", label: "HTTP request" },
            { value: "code", label: "Code execution" },
            { value: "local_llm", label: "Local LLM" }
          ]}
          onChange={switchStepType}
        />
      </div>

      {stepType === "code" ? (
        <>
          <div className="builderField builderSegmentField">
            <label id="builder-step-language-label">language</label>
            <SegmentToggle
              labelledBy="builder-step-language-label"
              value={language}
              options={CODE_LANGUAGES.map((lang) => ({
                value: lang.value,
                label: lang.label
              }))}
              onChange={(next) => commitSequencial({ language: next })}
            />
          </div>
          <div className="builderField">
            <label>
              name
              {nameMissing ? <span className="builderCheckMsg error">required</span> : null}
            </label>
            <input
              placeholder="Resource name"
              value={sp.resource_name ?? ""}
              onChange={(e) => commitSequencial({ resource_name: e.target.value })}
            />
          </div>
          <div className="builderField">
            <label>
              code
              {resourceLoadError ? (
                <span className="builderCheckMsg error">{resourceLoadError}</span>
              ) : codeMissing ? (
                <span className="builderCheckMsg error">required</span>
              ) : bodyCheck?.status === "ok" ? (
                <span className="builderCheckMsg ok">{bodyCheck.message}</span>
              ) : null}
            </label>
            <StepBodyEditor
              value={sp.code ?? ""}
              readOnly={false}
              highlightParameters={highlightParameters}
              parameters={state.query.parameters}
              placeholder={CODE_PLACEHOLDER[language]}
              onChange={(raw) => commitSequencial({ code: raw })}
            />
          </div>
        </>
      ) : stepType === "local_llm" ? (
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
        </>
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
        </>
      )}

      <StepResponseParametersSection
        items={sp.response_parameters ?? []}
        onChange={setResponseParameters}
      />
    </div>
  );
}
