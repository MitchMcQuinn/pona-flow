import { useEffect, useState, type FormEvent } from "react";
import { fetchChatModel, fetchCredentials, saveChatModel } from "../../services/api";
import type { ChatModelRole, ChatModelSettings as ChatModel } from "../../chat/types";

const PROVIDERS: Array<{ id: ChatModelRole["provider"]; label: string }> = [
  { id: "platform", label: "platform" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Gemini" },
  { id: "local_llm", label: "local-llm-server" }
];

function roleFrom(settings: ChatModel): ChatModelRole {
  return settings.planner ?? {
    provider: settings.provider,
    model: settings.model,
    credential_name: settings.credential_name,
    local_llm_base_url: settings.local_llm_base_url,
    local_llm_config_id: settings.local_llm_config_id,
    max_rounds: settings.max_rounds
  };
}

export function ChatModelSettings({ spaceId }: { spaceId: string }) {
  const [planner, setPlanner] = useState<ChatModelRole | null>(null);
  const [surface, setSurface] = useState<ChatModelRole | null>(null);
  const [builder, setBuilder] = useState<ChatModelRole | null>(null);
  const [separateSurface, setSeparateSurface] = useState(false);
  const [separateBuilder, setSeparateBuilder] = useState(false);
  const [platformConfigured, setPlatformConfigured] = useState(false);
  const [credentials, setCredentials] = useState<string[]>([]);
  const [plannerKey, setPlannerKey] = useState("");
  const [surfaceKey, setSurfaceKey] = useState("");
  const [builderKey, setBuilderKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([fetchChatModel(spaceId), fetchCredentials(spaceId)])
      .then(([model, creds]) => {
        if (cancelled) return;
        setPlanner(roleFrom(model));
        setSurface(model.surface);
        setBuilder(model.builder);
        setSeparateSurface(model.surface != null);
        setSeparateBuilder(model.builder != null);
        setPlatformConfigured(Boolean(model.platform_configured));
        setCredentials(creds.credentials.map((credential) => credential.name));
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "failed to load chat model");
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  if (!planner) {
    return error ? <p className="errorText">{error}</p> : <p className="muted">loading chat model…</p>;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!planner) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const next = await saveChatModel(spaceId, {
        planner,
        surface: separateSurface ? surface ?? { ...planner } : null,
        builder: separateBuilder ? builder ?? { ...planner } : null,
        planner_api_key: plannerKey.trim() || undefined,
        surface_api_key: surfaceKey.trim() || undefined,
        builder_api_key: builderKey.trim() || undefined
      });
      setPlanner(roleFrom(next));
      setSurface(next.surface);
      setBuilder(next.builder);
      setSeparateSurface(next.surface != null);
      setSeparateBuilder(next.builder != null);
      setPlatformConfigured(Boolean(next.platform_configured));
      setPlannerKey("");
      setSurfaceKey("");
      setBuilderKey("");
      const names = [next.planner?.credential_name, next.surface?.credential_name, next.builder?.credential_name].filter(
        (name): name is string => Boolean(name)
      );
      setCredentials((current) => Array.from(new Set([...current, ...names])).sort());
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "failed to save chat model");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="spaceConfigSection chatModelForm" onSubmit={save}>
      <h2>chat models</h2>
      <p className="muted rbacSectionHint">
        the consultant writes the routine. the surface model talks through the open questions. the builder files the change. provider keys are stored as space credentials.
      </p>
      <RoleFields
        title="consultant"
        role={planner}
        platformConfigured={platformConfigured}
        credentials={credentials}
        apiKey={plannerKey}
        onRole={setPlanner}
        onApiKey={setPlannerKey}
      />
      <label className="canvasField">
        <span>surface model</span>
        <select
          value={separateSurface ? "separate" : "same"}
          onChange={(event) => {
            const separate = event.target.value === "separate";
            setSeparateSurface(separate);
            if (separate && !surface) setSurface({ ...planner });
          }}
        >
          <option value="same">same as the consultant</option>
          <option value="separate">a different model</option>
        </select>
      </label>
      {separateSurface && surface ? (
        <RoleFields
          title="surface"
          role={surface}
          platformConfigured={platformConfigured}
          credentials={credentials}
          apiKey={surfaceKey}
          onRole={setSurface}
          onApiKey={setSurfaceKey}
        />
      ) : null}
      <label className="canvasField">
        <span>builder model</span>
        <select
          value={separateBuilder ? "separate" : "same"}
          onChange={(event) => {
            const separate = event.target.value === "separate";
            setSeparateBuilder(separate);
            if (separate && !builder) setBuilder({ ...planner });
          }}
        >
          <option value="same">same as the consultant</option>
          <option value="separate">a different model</option>
        </select>
      </label>
      {separateBuilder && builder ? (
        <RoleFields
          title="builder"
          role={builder}
          platformConfigured={platformConfigured}
          credentials={credentials}
          apiKey={builderKey}
          onRole={setBuilder}
          onApiKey={setBuilderKey}
        />
      ) : null}
      {error ? <p className="errorText">{error}</p> : null}
      {saved ? <p className="muted">saved.</p> : null}
      <button type="submit" className="btnPrimary" disabled={busy}>
        {busy ? "saving…" : "save chat models"}
      </button>
    </form>
  );
}

function RoleFields({
  title,
  role,
  platformConfigured,
  credentials,
  apiKey,
  onRole,
  onApiKey
}: {
  title: string;
  role: ChatModelRole;
  platformConfigured: boolean;
  credentials: string[];
  apiKey: string;
  onRole: (role: ChatModelRole) => void;
  onApiKey: (value: string) => void;
}) {
  const needsKey = role.provider === "anthropic" || role.provider === "openai" || role.provider === "gemini";
  const listId = `chat-model-credentials-${title}`;
  return (
    <fieldset className="chatModelRole">
      <legend>{title}</legend>
      <label className="canvasField">
        <span>provider</span>
        <select
          value={role.provider}
          onChange={(event) => onRole({ ...role, provider: event.target.value as ChatModelRole["provider"] })}
        >
          {PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>
      {role.provider === "platform" ? (
        <p className="muted">
          {platformConfigured ? "the server has a platform key." : "the server has no PONA_FLOW_CHAT_API_KEY yet."}
        </p>
      ) : null}
      {role.provider !== "local_llm" ? (
        <label className="canvasField">
          <span>model</span>
          <input
            value={role.model}
            placeholder="leave blank for the provider default"
            onChange={(event) => onRole({ ...role, model: event.target.value })}
          />
        </label>
      ) : null}
      {needsKey ? (
        <>
          <label className="canvasField">
            <span>credential</span>
            <input
              list={listId}
              value={role.credential_name}
              onChange={(event) => onRole({ ...role, credential_name: event.target.value })}
            />
            <datalist id={listId}>
              {credentials.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label className="canvasField">
            <span>new key value</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder="leave blank to keep the stored value"
              onChange={(event) => onApiKey(event.target.value)}
            />
          </label>
        </>
      ) : null}
      {role.provider === "local_llm" ? (
        <>
          <label className="canvasField">
            <span>base url</span>
            <input
              value={role.local_llm_base_url}
              onChange={(event) => onRole({ ...role, local_llm_base_url: event.target.value })}
            />
          </label>
          <label className="canvasField">
            <span>config id</span>
            <input
              value={role.local_llm_config_id}
              onChange={(event) => onRole({ ...role, local_llm_config_id: event.target.value })}
            />
          </label>
        </>
      ) : null}
      <label className="canvasField">
        <span>tool rounds</span>
        <input
          type="number"
          min={4}
          max={48}
          value={role.max_rounds}
          onChange={(event) => onRole({ ...role, max_rounds: Number(event.target.value) })}
        />
      </label>
    </fieldset>
  );
}
