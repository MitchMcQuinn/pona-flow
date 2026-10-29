import { useCallback, useEffect, useState } from "react";
import {
  fetchCredentials,
  fetchEmbeddingsConfig,
  fetchEmbeddingsHealth,
  reindexEmbeddings,
  saveEmbeddingsConfig,
  type Credential,
  type EmbeddingProvider,
  type EmbeddingsConfig,
  type EmbeddingsHealth,
  type ReindexResult
} from "../../services/api";
import { Toggle } from "../builder/Toggle";
import "../builder/builder.css";

interface EmbeddingsPanelProps {
  spaceId: string | null;
}

function describeRun(result: ReindexResult): string {
  const scope =
    result.labels === null
      ? result.attributiveLabel
      : `${result.labels} vectorized ${result.labels === 1 ? "type" : "types"}`;
  const parts = [`${result.embedded} embedded of ${result.scanned} scanned`];
  if (result.skipped) parts.push(`${result.skipped} skipped (no text)`);
  if (result.failed) parts.push(`${result.failed} failed`);
  if (result.capped) parts.push("stopped at the per-run cap");
  if (result.aborted) parts.push("aborted: the embedding service stopped responding");
  return `${scope}: ${parts.join(", ")}.`;
}

function healthLine(health: EmbeddingsHealth): string {
  if (!health.ok) return health.error || "The embedding service did not respond.";
  const where =
    health.provider === "gemini"
      ? health.baseUrl || "the Gemini API"
      : health.ollamaUrl;
  return `${health.embedModel} answered at ${where} (${health.dimensions} dimensions).`;
}

/**
 * Vector-search settings for one space.
 *
 * Saving probes the model for its vector width, because that number is baked into the Neo4j
 * index — which is also why changing the model or the cloud host clears stored vectors
 * instead of mixing two models' coordinates in one index.
 */
export function EmbeddingsPanel({ spaceId }: EmbeddingsPanelProps) {
  const [config, setConfig] = useState<EmbeddingsConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<EmbeddingProvider>("ollama");
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [embedModel, setEmbedModel] = useState("");
  const [credential, setCredential] = useState("");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<EmbeddingsHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [runSummary, setRunSummary] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!spaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [result, creds] = await Promise.all([
        fetchEmbeddingsConfig(spaceId),
        fetchCredentials(spaceId).catch(() => ({ backend: "", credentials: [] as Credential[] }))
      ]);
      setConfig(result);
      setEnabled(result.enabled);
      setProvider(result.provider);
      setOllamaUrl(result.ollamaUrl);
      setBaseUrl(result.baseUrl);
      setEmbedModel(result.embedModel);
      setCredential(result.credential);
      setCredentials(creds.credentials);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load embedding settings");
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void reload();
    setHealth(null);
    setRunSummary(null);
  }, [reload]);

  async function save() {
    if (!spaceId) return;
    setSaving(true);
    setError(null);
    setRunSummary(null);
    try {
      const result = await saveEmbeddingsConfig(spaceId, {
        enabled,
        provider,
        ollamaUrl: ollamaUrl.trim(),
        baseUrl: baseUrl.trim(),
        embedModel: embedModel.trim(),
        credential: credential.trim()
      });
      setConfig(result);
      setEnabled(result.enabled);
      setProvider(result.provider);
      setOllamaUrl(result.ollamaUrl);
      setBaseUrl(result.baseUrl);
      setEmbedModel(result.embedModel);
      setCredential(result.credential);
      setHealth(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save embedding settings");
    } finally {
      setSaving(false);
    }
  }

  async function check() {
    if (!spaceId) return;
    setChecking(true);
    setError(null);
    try {
      setHealth(await fetchEmbeddingsHealth(spaceId));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to reach the embedding service");
    } finally {
      setChecking(false);
    }
  }

  async function reindex() {
    if (!spaceId) return;
    setReindexing(true);
    setError(null);
    setRunSummary(null);
    try {
      setRunSummary(describeRun(await reindexEmbeddings(spaceId)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to reindex embeddings");
    } finally {
      setReindexing(false);
    }
  }

  if (!spaceId) {
    return <p className="muted">Select a space to configure vector search.</p>;
  }

  const inherited = config?.source === "env";
  const cloud = provider === "gemini";
  const busy = loading || saving || reindexing;
  const credentialNames = credentials.map((item) => item.name);
  const credentialOptions =
    credential && !credentialNames.includes(credential)
      ? [credential, ...credentialNames]
      : credentialNames;

  return (
    <div className="spaceConfigSection embeddingsPanel">
      <div className="rbacHeaderRow">
        <h2>embeddings</h2>
      </div>
      <p className="muted rbacSectionHint">
        Semantic search over this space&apos;s records. A local Ollama model is the default; a
        Gemini-compatible host can embed instead. Vectors are stored on the records themselves.
        Mark a SCHEMA <code>vectorized</code> to include its instances, then reindex. One model
        serves the whole space: its vector width is fixed in the index, so switching models or
        cloud hosts clears what is stored and needs a reindex.
      </p>
      {error ? <div className="errorText">{error}</div> : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {inherited ? (
        <p className="muted">
          {cloud ? (
            <>
              Using the instance defaults (<code>PONA_FLOW_EMBED_PROVIDER</code>,{" "}
              <code>PONA_FLOW_EMBED_MODEL</code>, and <code>PONA_FLOW_EMBED_API_KEY</code>).
              Saving here overrides them for this space.
            </>
          ) : (
            <>
              Using the instance defaults (<code>PONA_FLOW_OLLAMA_URL</code> and{" "}
              <code>PONA_FLOW_OLLAMA_EMBED_MODEL</code>). Saving here overrides them for this
              space.
            </>
          )}
        </p>
      ) : null}

      <div className="builderFormFieldset embeddingsPanelFields">
        <div className="builderRowFlags">
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            label="enabled"
            id="embeddings-enabled-toggle"
            disabled={busy}
          />
        </div>
        <div className="builderRow">
          <div className="builderField">
            <label htmlFor="embeddings-provider-select">provider</label>
            <select
              id="embeddings-provider-select"
              data-testid="embeddings-provider-select"
              value={provider}
              disabled={busy}
              onChange={(e) => setProvider(e.target.value as EmbeddingProvider)}
            >
              <option value="ollama">Local (Ollama)</option>
              <option value="gemini">Cloud (Gemini-compatible)</option>
            </select>
          </div>
        </div>
        {cloud ? (
          <>
            <div className="builderRow">
              <div className="builderField">
                <label htmlFor="embeddings-base-url-input">api root</label>
                <input
                  id="embeddings-base-url-input"
                  className="builderMono"
                  data-testid="embeddings-base-url-input"
                  value={baseUrl}
                  placeholder="https://generativelanguage.googleapis.com/v1beta"
                  disabled={busy}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <span className="muted">
                  Leave blank for the Google Gemini API. Record text and search queries are sent
                  to this host.
                </span>
              </div>
            </div>
            <div className="builderRow">
              <div className="builderField">
                <label htmlFor="embeddings-credential-select">credential</label>
                <select
                  id="embeddings-credential-select"
                  data-testid="embeddings-credential-select"
                  value={credential}
                  disabled={busy}
                  onChange={(e) => setCredential(e.target.value)}
                >
                  <option value="">select a credential</option>
                  {credentialOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <span className="muted">
                  {credentials.length === 0 && !credential
                    ? "Add a credential on the Credentials tab, then choose it here. The value stays in the credential store."
                    : "The API key is read from this credential at call time and is not stored with these settings."}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="builderRow">
            <div className="builderField">
              <label htmlFor="embeddings-url-input">ollama url</label>
              <input
                id="embeddings-url-input"
                className="builderMono"
                data-testid="embeddings-url-input"
                value={ollamaUrl}
                placeholder="http://127.0.0.1:11434"
                disabled={busy}
                onChange={(e) => setOllamaUrl(e.target.value)}
              />
            </div>
          </div>
        )}
        <div className="builderRow">
          <div className="builderField">
            <label htmlFor="embeddings-model-input">embedding model</label>
            <input
              id="embeddings-model-input"
              className="builderMono"
              data-testid="embeddings-model-input"
              value={embedModel}
              placeholder={cloud ? "gemini-embedding-2" : "nomic-embed-text"}
              disabled={busy}
              onChange={(e) => setEmbedModel(e.target.value)}
            />
            <span className="muted">
              {cloud ? (
                <>
                  A Gemini embedding model such as <code>gemini-embedding-2</code>. Its vector
                  width is probed on save.
                </>
              ) : (
                <>
                  Must be an embedding model Ollama has already pulled (
                  <code>ollama pull nomic-embed-text</code>).
                </>
              )}
            </span>
          </div>
        </div>
        {config?.dimensions ? (
          <div className="builderRow">
            <div className="builderField">
              <label>vector dimensions</label>
              <span className="builderMono">{config.dimensions}</span>
              <span className="muted">Probed from the model; not editable.</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="buttonRow">
        <button
          type="button"
          className="btnPrimary"
          data-testid="embeddings-save-btn"
          disabled={busy}
          onClick={save}
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
        <button
          type="button"
          data-testid="embeddings-check-btn"
          disabled={busy || checking}
          onClick={check}
        >
          {checking ? "Checking..." : "Check connection"}
        </button>
        <button
          type="button"
          data-testid="embeddings-reindex-btn"
          disabled={busy || !config?.enabled}
          onClick={reindex}
        >
          {reindexing ? "Reindexing..." : "Reindex space"}
        </button>
      </div>

      {health ? (
        <p className={health.ok ? "muted" : "errorText"}>{healthLine(health)}</p>
      ) : null}
      {runSummary ? <p className="muted">{runSummary}</p> : null}
    </div>
  );
}
