import { useEffect, useState, type FormEvent } from "react";
import { fetchChatModel, fetchCredentials, saveChatModel } from "../../services/api";
import type { ChatModelSettings as ChatModel } from "../../chat/types";

const PROVIDERS: Array<{ id: ChatModel["provider"]; label: string }> = [
  { id: "platform", label: "Platform" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Gemini" },
  { id: "local_llm", label: "local-llm-server" }
];

export function ChatModelSettings({ spaceId }: { spaceId: string }) {
  const [settings, setSettings] = useState<ChatModel | null>(null);
  const [credentials, setCredentials] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([fetchChatModel(spaceId), fetchCredentials(spaceId)])
      .then(([model, creds]) => {
        if (cancelled) return;
        setSettings(model);
        setCredentials(creds.credentials.map((credential) => credential.name));
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load chat model");
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  if (!settings) {
    return error ? <p className="errorText">{error}</p> : <p className="muted">Loading chat model…</p>;
  }

  const needsKey = settings.provider === "anthropic" || settings.provider === "openai" || settings.provider === "gemini";

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const next = await saveChatModel(spaceId, {
        ...settings,
        api_key: apiKey.trim() || undefined
      });
      setSettings(next);
      setApiKey("");
      if (next.credential_name && !credentials.includes(next.credential_name)) {
        setCredentials((current) => [...current, next.credential_name].sort());
      }
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save chat model");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="spaceConfigSection chatModelForm" onSubmit={save}>
      <h2>chat model</h2>
      <p className="muted rbacSectionHint">
        Chat mode uses this model for the space. Provider keys are stored as space credentials.
      </p>
      <label className="canvasField">
        <span>Provider</span>
        <select
          value={settings.provider}
          onChange={(event) =>
            setSettings({ ...settings, provider: event.target.value as ChatModel["provider"] })
          }
        >
          {PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>
      {settings.provider === "platform" ? (
        <p className="muted">
          {settings.platform_configured
            ? "The server has a platform key."
            : "The server has no PONA_FLOW_CHAT_API_KEY yet."}
        </p>
      ) : null}
      {settings.provider !== "local_llm" ? (
        <label className="canvasField">
          <span>Model</span>
          <input
            value={settings.model}
            placeholder="Leave blank for the provider default"
            onChange={(event) => setSettings({ ...settings, model: event.target.value })}
          />
        </label>
      ) : null}
      {needsKey ? (
        <>
          <label className="canvasField">
            <span>Credential</span>
            <input
              list="chat-model-credentials"
              value={settings.credential_name}
              onChange={(event) => setSettings({ ...settings, credential_name: event.target.value })}
            />
            <datalist id="chat-model-credentials">
              {credentials.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label className="canvasField">
            <span>New key value</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder="Leave blank to keep the stored value"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        </>
      ) : null}
      {settings.provider === "local_llm" ? (
        <>
          <label className="canvasField">
            <span>Base URL</span>
            <input
              value={settings.local_llm_base_url}
              onChange={(event) => setSettings({ ...settings, local_llm_base_url: event.target.value })}
            />
          </label>
          <label className="canvasField">
            <span>Config id</span>
            <input
              value={settings.local_llm_config_id}
              onChange={(event) => setSettings({ ...settings, local_llm_config_id: event.target.value })}
            />
          </label>
        </>
      ) : null}
      <label className="canvasField">
        <span>Tool rounds</span>
        <input
          type="number"
          min={4}
          max={48}
          value={settings.max_rounds}
          onChange={(event) =>
            setSettings({ ...settings, max_rounds: Number(event.target.value) })
          }
        />
      </label>
      {error ? <p className="errorText">{error}</p> : null}
      {saved ? <p className="muted">Saved.</p> : null}
      <button type="submit" className="btnPrimary" disabled={busy}>
        {busy ? "Saving…" : "Save chat model"}
      </button>
    </form>
  );
}
