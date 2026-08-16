import { useCallback, useEffect, useState } from "react";
import {
  fetchEmbeddingsConfig,
  fetchEmbeddingsHealth,
  reindexEmbeddings,
  saveEmbeddingsConfig,
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
  if (result.aborted) parts.push("aborted: Ollama stopped responding");
  return `${scope}: ${parts.join(", ")}.`;
}

/**
 * Vector-search settings for one space.
 *
 * Saving probes the model for its vector width, because that number is baked into the Neo4j
 * index — which is also why changing the model clears stored vectors instead of mixing two
 * models' coordinates in one index.
 */
export function EmbeddingsPanel({ spaceId }: EmbeddingsPanelProps) {
  const [config, setConfig] = useState<EmbeddingsConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [embedModel, setEmbedModel] = useState("");
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
      const result = await fetchEmbeddingsConfig(spaceId);
      setConfig(result);
      setEnabled(result.enabled);
      setOllamaUrl(result.ollamaUrl);
      setEmbedModel(result.embedModel);
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
        ollamaUrl: ollamaUrl.trim(),
        embedModel: embedModel.trim()
      });
      setConfig(result);
      setEnabled(result.enabled);
      setOllamaUrl(result.ollamaUrl);
      setEmbedModel(result.embedModel);
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
  const busy = loading || saving || reindexing;

  return (
    <>
      <div className="rbacHeaderRow">
        <h3>Embeddings</h3>
      </div>
      <p className="muted rbacSectionHint">
        Semantic search over this space&apos;s records, embedded by a local{" "}
        <a href="https://ollama.com" target="_blank" rel="noreferrer">
          Ollama
        </a>{" "}
        model and stored on the records themselves. Mark a SCHEMA <code>is_vectorized</code> to
        include its instances, then reindex. One model serves the whole space: its vector width
        is fixed in the index, so switching models clears what is stored and needs a reindex.
      </p>
      {error ? <div className="errorText">{error}</div> : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {inherited ? (
        <p className="muted">
          Using the instance defaults (<code>PONA_FLOW_OLLAMA_URL</code> and{" "}
          <code>PONA_FLOW_OLLAMA_EMBED_MODEL</code>). Saving here overrides them for this space.
        </p>
      ) : null}

      <div className="builderFormFieldset">
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
            <label>ollama url</label>
            <input
              className="builderMono"
              data-testid="embeddings-url-input"
              value={ollamaUrl}
              placeholder="http://127.0.0.1:11434"
              disabled={busy}
              onChange={(e) => setOllamaUrl(e.target.value)}
            />
          </div>
        </div>
        <div className="builderRow">
          <div className="builderField">
            <label>embedding model</label>
            <input
              className="builderMono"
              data-testid="embeddings-model-input"
              value={embedModel}
              placeholder="nomic-embed-text"
              disabled={busy}
              onChange={(e) => setEmbedModel(e.target.value)}
            />
            <span className="muted">
              Must be an embedding model Ollama has already pulled (
              <code>ollama pull nomic-embed-text</code>).
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
        <p className={health.ok ? "muted" : "errorText"}>
          {health.ok
            ? `Ollama answered at ${health.ollamaUrl} with ${health.embedModel} (${health.dimensions} dimensions).`
            : health.error}
        </p>
      ) : null}
      {runSummary ? <p className="muted">{runSummary}</p> : null}
    </>
  );
}
