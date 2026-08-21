import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createLocalLlmConfig,
  deleteLocalLlmConfig,
  fetchLocalLlmConfigs,
  fetchLocalLlmHealth,
  fetchLocalLlmModels,
  replaceLocalLlmConfig,
  runLocalLlmConfig,
  type LocalLlmConfig,
  type LocalLlmConfigInput,
  type LocalLlmOptions,
  type LocalLlmResponseFormat
} from "../../services/api";
import "../builder/builder.css";

interface LocalLlmsPanelProps {
  spaceId: string | null;
  onClose: () => void;
}

const OPTION_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "repeat_penalty",
  "num_ctx",
  "num_predict",
  "seed"
] as const;

const INT_KEYS = new Set(["top_k", "num_ctx", "num_predict", "seed"]);

const OPTION_HELP: Record<(typeof OPTION_KEYS)[number], string> = {
  temperature: "Controls randomness. Higher is more creative; 0 is nearly deterministic.",
  top_p: "Nucleus sampling: only tokens in the top probability mass are considered (0–1).",
  top_k: "Limits sampling to the K most likely next tokens.",
  min_p: "Drops tokens below this fraction of the top token's probability (0–1).",
  repeat_penalty: "How strongly to penalize repeated tokens (1.0 = none).",
  num_ctx: "Context window size in tokens.",
  num_predict: "Max tokens to generate.",
  seed: "Fixed seed for reproducible output."
};

type Draft = {
  name: string;
  model: string;
  systemPrompt: string;
  options: Record<(typeof OPTION_KEYS)[number], string>;
  stop: string;
  formatType: "text" | "json_schema";
  schemaText: string;
};

function emptyDraft(model = ""): Draft {
  return {
    name: "",
    model,
    systemPrompt: "",
    options: {
      temperature: "",
      top_p: "",
      top_k: "",
      min_p: "",
      repeat_penalty: "",
      num_ctx: "",
      num_predict: "",
      seed: ""
    },
    stop: "",
    formatType: "text",
    schemaText: ""
  };
}

function draftFromConfig(config: LocalLlmConfig): Draft {
  const options = emptyDraft().options;
  for (const key of OPTION_KEYS) {
    const value = config.options[key];
    options[key] = value === undefined || value === null ? "" : String(value);
  }
  return {
    name: config.name,
    model: config.model,
    systemPrompt: config.systemPrompt,
    options,
    stop: Array.isArray(config.options.stop) ? config.options.stop.join(", ") : "",
    formatType: config.responseFormat.type,
    schemaText:
      config.responseFormat.type === "json_schema" && config.responseFormat.json_schema
        ? JSON.stringify(config.responseFormat.json_schema, null, 2)
        : ""
  };
}

function payloadFromDraft(draft: Draft): LocalLlmConfigInput {
  const options: LocalLlmOptions = {};
  for (const key of OPTION_KEYS) {
    const raw = draft.options[key].trim();
    if (!raw) continue;
    const num = INT_KEYS.has(key) ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    if (!Number.isNaN(num)) options[key] = num;
  }
  const stop = draft.stop
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (stop.length) options.stop = stop;

  const response_format: LocalLlmResponseFormat = { type: draft.formatType };
  if (draft.formatType === "json_schema") {
    const raw = draft.schemaText.trim();
    if (!raw) throw new Error("JSON schema is required when format is JSON schema");
    response_format.json_schema = JSON.parse(raw) as Record<string, unknown>;
  }

  return {
    name: draft.name.trim(),
    model: draft.model.trim(),
    system_prompt: draft.systemPrompt,
    options,
    response_format
  };
}

/**
 * Manage named local Ollama configs for the current space (list + editor + test run).
 */
export function LocalLlmsPanel({ spaceId, onClose }: LocalLlmsPanelProps) {
  const [configs, setConfigs] = useState<LocalLlmConfig[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [healthLine, setHealthLine] = useState("checking Ollama…");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ message: string; kind: "ok" | "error" } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [testPrompt, setTestPrompt] = useState("");
  const [testOutput, setTestOutput] = useState("");
  const [running, setRunning] = useState(false);

  const selected = useMemo(
    () => configs.find((c) => c.id === selectedId) ?? null,
    [configs, selectedId]
  );

  const reload = useCallback(async (): Promise<LocalLlmConfig[]> => {
    if (!spaceId) return [];
    setLoading(true);
    setError(null);
    try {
      const [list, health] = await Promise.all([
        fetchLocalLlmConfigs(spaceId),
        fetchLocalLlmHealth(spaceId)
      ]);
      setConfigs(list);
      setHealthLine(
        health.ollama
          ? `Ollama ok${health.ollamaUrl ? ` · ${health.ollamaUrl}` : ""}`
          : `Ollama unreachable${health.ollamaError ? `: ${health.ollamaError}` : ""}`
      );
      try {
        const modelList = await fetchLocalLlmModels(spaceId);
        setModels(modelList.map((m) => m.name).filter(Boolean));
      } catch {
        setModels([]);
      }
      return list;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load local LLMs");
      return [];
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void reload().then((list) => {
      if (list.length && !selectedId && !isNew) {
        setSelectedId(list[0].id);
        setDraft(draftFromConfig(list[0]));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  useEffect(() => {
    if (isNew || !selected) return;
    setDraft(draftFromConfig(selected));
    setStatus(null);
    setTestOutput("");
  }, [selected, isNew]);

  function startNew() {
    setIsNew(true);
    setSelectedId(null);
    setDraft(emptyDraft(models[0] || ""));
    setStatus(null);
    setTestOutput("");
  }

  function selectConfig(id: string) {
    setIsNew(false);
    setSelectedId(id);
  }

  async function save() {
    if (!spaceId) return;
    setSaving(true);
    setStatus(null);
    try {
      const payload = payloadFromDraft(draft);
      if (!payload.name) throw new Error("Name is required");
      if (!payload.model) throw new Error("Model is required");
      const saved = isNew
        ? await createLocalLlmConfig(spaceId, payload)
        : await replaceLocalLlmConfig(spaceId, selectedId!, payload);
      const list = await reload();
      setIsNew(false);
      setSelectedId(saved.id);
      const next = list.find((c) => c.id === saved.id) ?? saved;
      setDraft(draftFromConfig(next));
      setStatus({ message: "Saved.", kind: "ok" });
    } catch (e: unknown) {
      setStatus({
        message: e instanceof Error ? e.message : "Save failed",
        kind: "error"
      });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!spaceId || !selectedId || isNew) return;
    if (!window.confirm(`Delete config “${draft.name || selectedId}”?`)) return;
    setSaving(true);
    try {
      await deleteLocalLlmConfig(spaceId, selectedId);
      setSelectedId(null);
      setIsNew(false);
      setDraft(emptyDraft(models[0] || ""));
      const list = await reload();
      if (list[0]) {
        setSelectedId(list[0].id);
        setDraft(draftFromConfig(list[0]));
      }
      setStatus({ message: "Deleted.", kind: "ok" });
    } catch (e: unknown) {
      setStatus({
        message: e instanceof Error ? e.message : "Delete failed",
        kind: "error"
      });
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!spaceId || !selectedId || isNew) return;
    setRunning(true);
    setTestOutput("");
    try {
      const result = await runLocalLlmConfig(spaceId, selectedId, testPrompt);
      setTestOutput(
        JSON.stringify(
          {
            model: result.model,
            response: result.response,
            parsed: result.parsed,
            done_reason: result.doneReason,
            eval_count: result.evalCount
          },
          null,
          2
        )
      );
    } catch (e: unknown) {
      setTestOutput(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  const showEditor = isNew || Boolean(selected);

  if (!spaceId) {
    return (
      <div className="panel configPanel">
        <div className="panel__body">
          <div className="rbacHeaderRow">
            <h3>Local LLMs</h3>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="muted">Select a space to manage local LLM configs.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel configPanel localLlmsPanel">
      <div className="panel__body">
        <div className="rbacHeaderRow">
          <div>
            <h3>Local LLMs</h3>
            <p className="muted localLlmsHealth">{healthLine}</p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted">
          Named Ollama setups for Local LLM steps. At run time the sequence&apos;s{" "}
          <code>$prompt</code> parameter is sent and the model comes from the saved config. The
          values below are the defaults: a step can override the system prompt, any option, and
          the response format for a single run through its optional sequence parameters.
        </p>
        {error ? <p className="errorText">{error}</p> : null}
        {loading ? <p className="muted">Loading…</p> : null}

        <div className="localLlmsLayout">
          <aside className="localLlmsSidebar">
            <button type="button" className="btnPrimary" onClick={startNew}>
              New config
            </button>
            <ul className="localLlmsList">
              {configs.map((config) => (
                <li key={config.id}>
                  <button
                    type="button"
                    className={
                      !isNew && config.id === selectedId
                        ? "localLlmsListBtn active"
                        : "localLlmsListBtn"
                    }
                    onClick={() => selectConfig(config.id)}
                  >
                    <span className="localLlmsListName">{config.name}</span>
                    <span className="muted localLlmsListMeta">{config.model}</span>
                  </button>
                </li>
              ))}
            </ul>
            {!loading && configs.length === 0 ? (
              <p className="muted">No configs yet.</p>
            ) : null}
          </aside>

          <div className="localLlmsMain">
            {!showEditor ? (
              <p className="muted">Select a config or create a new one.</p>
            ) : (
              <>
                <div className="rbacHeaderRow">
                  <h4>{isNew ? "New config" : draft.name || "Edit config"}</h4>
                  <div className="inlineActions">
                    <button
                      type="button"
                      className="btnPrimary"
                      disabled={saving}
                      onClick={() => void save()}
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    {!isNew ? (
                      <button
                        type="button"
                        className="danger"
                        disabled={saving}
                        onClick={() => void remove()}
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>
                {status ? (
                  <p className={status.kind === "error" ? "errorText" : "muted"}>
                    {status.message}
                  </p>
                ) : null}

                <div className="builderField">
                  <label>name</label>
                  <input
                    value={draft.name}
                    placeholder="Ticket classifier"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
                <div className="builderField">
                  <label>model</label>
                  {models.length > 0 ? (
                    <select
                      value={draft.model}
                      onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                    >
                      {!models.includes(draft.model) && draft.model ? (
                        <option value={draft.model}>{draft.model}</option>
                      ) : null}
                      {models.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="builderMono"
                      value={draft.model}
                      placeholder="llama3.2"
                      onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                    />
                  )}
                </div>
                <div className="builderField">
                  <label>system prompt</label>
                  <textarea
                    rows={6}
                    value={draft.systemPrompt}
                    placeholder="You are a careful assistant…"
                    onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  />
                </div>

                <h4 className="navSectionHeader">Model options</h4>
                <div className="localLlmsOptionsGrid">
                  {OPTION_KEYS.map((key) => (
                    <div className="builderField" key={key}>
                      <label title={OPTION_HELP[key]}>{key.replace(/_/g, " ")}</label>
                      <input
                        type="number"
                        step={INT_KEYS.has(key) ? 1 : "any"}
                        value={draft.options[key]}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            options: { ...draft.options, [key]: e.target.value }
                          })
                        }
                      />
                    </div>
                  ))}
                  <div className="builderField localLlmsStopField">
                    <label>stop (comma-separated)</label>
                    <input
                      value={draft.stop}
                      placeholder="END, ###"
                      onChange={(e) => setDraft({ ...draft, stop: e.target.value })}
                    />
                  </div>
                </div>

                <h4 className="navSectionHeader">Response format</h4>
                <div className="builderField builderSegmentField">
                  <label>
                    <input
                      type="radio"
                      name="local-llm-format"
                      checked={draft.formatType === "text"}
                      onChange={() => setDraft({ ...draft, formatType: "text" })}
                    />{" "}
                    text
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="local-llm-format"
                      checked={draft.formatType === "json_schema"}
                      onChange={() => setDraft({ ...draft, formatType: "json_schema" })}
                    />{" "}
                    JSON schema
                  </label>
                </div>
                {draft.formatType === "json_schema" ? (
                  <div className="builderField">
                    <label>JSON schema</label>
                    <textarea
                      className="builderMono"
                      rows={8}
                      value={draft.schemaText}
                      placeholder='{"type":"object","properties":{...}}'
                      onChange={(e) => setDraft({ ...draft, schemaText: e.target.value })}
                    />
                  </div>
                ) : null}

                {!isNew && selectedId ? (
                  <>
                    <h4 className="navSectionHeader">Test</h4>
                    <div className="builderField">
                      <label>prompt</label>
                      <textarea
                        rows={3}
                        value={testPrompt}
                        placeholder="Your input here"
                        onChange={(e) => setTestPrompt(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className="btnPrimary"
                      disabled={running || !testPrompt.trim()}
                      onClick={() => void runTest()}
                    >
                      {running ? "Running…" : "Run"}
                    </button>
                    {testOutput ? (
                      <pre className="localLlmsOutput builderMono">{testOutput}</pre>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
