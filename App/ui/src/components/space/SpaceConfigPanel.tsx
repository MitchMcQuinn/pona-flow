import { useEffect, useMemo, useState } from "react";
import {
  fetchSharedSequenceLabels,
  fetchSpaceRecord,
  type CreateSpaceInput
} from "../../services/api";
import type { AppState, AuditEntry, Me, SequenceSummary } from "../../state/types";
import {
  isValidSpaceNameInput,
  normalizeSpaceName,
  sanitizeSpaceNameInput
} from "../../utils/spaceName";
import { AgentsPanel } from "../agents/AgentsPanel";
import { CredentialsPanel } from "../credentials/CredentialsPanel";
import { EmbeddingsPanel } from "../embeddings/EmbeddingsPanel";
import { SpaceLabelsPicker } from "../modals/SpaceLabelsPicker";
import { TemplatesPanel } from "../templates/TemplatesPanel";
import { UsersPanel } from "../users/UsersPanel";

type SpaceConfigTab =
  | "settings"
  | "users"
  | "agents"
  | "credentials"
  | "embeddings"
  | "templates"
  | "audit";

interface SpaceConfigPanelProps {
  spaceId: string | null;
  spaces: Array<{ id: string; label: string }>;
  me: Me | null;
  permissions: AppState["permissions"];
  sequences: SequenceSummary[];
  events: AppState["events"]["items"];
  auditLog: AppState["auditLog"];
  onSaveSpace: (values: CreateSpaceInput) => Promise<void>;
  savingSpace: boolean;
  saveError: string | null;
  onDeleteSpace: () => void;
  onLoadAuditLog: () => void;
  onClose: () => void;
}

function AuditLogSection({
  entries,
  loading,
  error,
  sequences,
  events,
  onRefresh
}: {
  entries: AuditEntry[];
  loading: boolean;
  error: string | null;
  sequences: SequenceSummary[];
  events: AppState["events"]["items"];
  onRefresh: () => void;
}) {
  const sequenceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const sequence of sequences) map.set(sequence.id, sequence.label);
    return map;
  }, [sequences]);

  const eventLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const trigger of events) map.set(trigger.id, trigger.name);
    return map;
  }, [events]);

  return (
    <div className="spaceConfigSection">
      <div className="rbacHeaderRow">
        <h3>Audit log</h3>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      <p className="muted">Read-only record of every sequence run in this space.</p>
      {error ? <p className="errorText">{error}</p> : null}
      {!loading && !error && entries.length === 0 ? (
        <p className="muted">No sequence runs recorded yet.</p>
      ) : null}
      {!error && entries.length > 0 ? (
        <table className="auditLogTable">
          <thead>
            <tr>
              <th>Run at (UTC)</th>
              <th>Trigger</th>
              <th>Sequence(s)</th>
              <th>Event</th>
              <th>Principal</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.runAt}</td>
                <td>{entry.trigger}</td>
                <td>
                  {entry.sequenceIds.length === 0
                    ? "-"
                    : entry.sequenceIds.map((id) => sequenceLabels.get(id) ?? id).join(", ")}
                </td>
                <td>{entry.eventId ? eventLabels.get(entry.eventId) ?? entry.eventId : "-"}</td>
                <td>{entry.principalEmail ?? entry.principalId ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function SpaceConfigPanel({
  spaceId,
  spaces,
  me,
  permissions,
  sequences,
  events,
  auditLog,
  onSaveSpace,
  savingSpace,
  saveError,
  onDeleteSpace,
  onLoadAuditLog,
  onClose
}: SpaceConfigPanelProps) {
  const [tab, setTab] = useState<SpaceConfigTab>("settings");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [recordLoading, setRecordLoading] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [sharedSequenceLabels, setSharedSequenceLabels] = useState<string[]>([]);
  const [labelsLoading, setLabelsLoading] = useState(false);

  const canManageSpace = Boolean(permissions?.manageSpace || me?.isSuperadmin);

  useEffect(() => {
    if (!spaceId) return;
    setRecordLoading(true);
    setRecordError(null);
    fetchSpaceRecord(spaceId)
      .then((record) => {
        setName(record.name);
        setEndpoint(record.endpoint ?? "");
        setDescription(record.description ?? "");
        setLabels(record.sequence_labels ?? record.labels ?? []);
      })
      .catch((error: unknown) => {
        setRecordError(error instanceof Error ? error.message : "Failed to load space");
        setName(spaces.find((space) => space.id === spaceId)?.label ?? spaceId);
        setEndpoint("");
        setDescription("");
        setLabels([]);
      })
      .finally(() => setRecordLoading(false));
  }, [spaceId, spaces]);

  useEffect(() => {
    let cancelled = false;
    setLabelsLoading(true);
    fetchSharedSequenceLabels()
      .then((options) => {
        if (!cancelled) setSharedSequenceLabels(options);
      })
      .catch(() => {
        if (!cancelled) setSharedSequenceLabels([]);
      })
      .finally(() => {
        if (!cancelled) setLabelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  useEffect(() => {
    if (tab === "audit") onLoadAuditLog();
  }, [tab, onLoadAuditLog]);

  useEffect(() => {
    setLocalError(null);
  }, [name, endpoint, description, labels]);

  const trimmedName = name.trim();
  const normalizedName = useMemo(() => normalizeSpaceName(trimmedName), [trimmedName]);
  const excludedNormalized = spaceId ? normalizeSpaceName(spaceId) : "";
  const duplicate = useMemo(
    () =>
      normalizedName.length > 0 &&
      spaces.some((space) => {
        const normalizedExisting = normalizeSpaceName(space.id);
        if (excludedNormalized && normalizedExisting === excludedNormalized) return false;
        return (
          normalizedExisting === normalizedName ||
          normalizeSpaceName(space.label) === normalizedName
        );
      }),
    [spaces, normalizedName, excludedNormalized]
  );
  const nameValid = isValidSpaceNameInput(name);
  const displayError = localError || saveError || recordError;
  const canSave = Boolean(spaceId && canManageSpace && nameValid && !duplicate && !savingSpace);

  async function save() {
    if (!spaceId) return;
    if (!trimmedName) {
      setLocalError("Name is required.");
      return;
    }
    if (!nameValid) {
      setLocalError("Name may only contain letters, numbers, and spaces.");
      return;
    }
    if (duplicate) {
      setLocalError("A space with this name already exists.");
      return;
    }
    await onSaveSpace({
      name: trimmedName,
      endpoint: endpoint.trim(),
      labels,
      description: description.trim()
    });
  }

  return (
    <div className="panel configPanel spaceConfigPanel">
      <div className="panel__body">
        <div className="rbacHeaderRow">
          <h2>Space</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {!spaceId ? <p className="muted">Select a space to configure it.</p> : null}

        <div className="spaceConfigTabs" role="tablist" aria-label="Space configuration">
          <button
            type="button"
            className={tab === "settings" ? "active" : undefined}
            data-testid="space-tab-settings"
            onClick={() => setTab("settings")}
          >
            Settings
          </button>
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "users" ? "active" : undefined}
              data-testid="space-tab-users"
              onClick={() => setTab("users")}
            >
              Users
            </button>
          ) : null}
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "agents" ? "active" : undefined}
              data-testid="space-tab-agents"
              onClick={() => setTab("agents")}
            >
              Agents
            </button>
          ) : null}
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "credentials" ? "active" : undefined}
              data-testid="space-tab-credentials"
              onClick={() => setTab("credentials")}
            >
              Credentials
            </button>
          ) : null}
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "embeddings" ? "active" : undefined}
              data-testid="space-tab-embeddings"
              onClick={() => setTab("embeddings")}
            >
              Embeddings
            </button>
          ) : null}
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "templates" ? "active" : undefined}
              data-testid="space-tab-templates"
              onClick={() => setTab("templates")}
            >
              Templates
            </button>
          ) : null}
          <button
            type="button"
            className={tab === "audit" ? "active" : undefined}
            data-testid="space-tab-audit"
            onClick={() => setTab("audit")}
          >
            Audit log
          </button>
        </div>

        {tab === "settings" ? (
          <div className="spaceConfigSection">
            <h3>Settings</h3>
            {recordLoading ? <p className="muted">Loading space...</p> : null}
            {displayError ? <p className="builderCheckMsg error">{displayError}</p> : null}
            {duplicate && !displayError ? (
              <p className="builderCheckMsg error">A space with this name already exists.</p>
            ) : null}
            <div className="builderFormFieldset">
              <div className="builderRow">
                <div className="builderField">
                  <label>name</label>
                  <input
                    value={name}
                    placeholder="e.g. Test space"
                    disabled={!canManageSpace || savingSpace || recordLoading}
                    onChange={(e) => setName(sanitizeSpaceNameInput(e.target.value))}
                  />
                </div>
              </div>
              <div className="builderRow">
                <div className="builderField">
                  <label>endpoint (optional)</label>
                  <input
                    value={endpoint}
                    placeholder="https://..."
                    disabled={!canManageSpace || savingSpace || recordLoading}
                    onChange={(e) => setEndpoint(e.target.value)}
                  />
                </div>
              </div>
              <div className="builderRow">
                <div className="builderField">
                  <label>description (optional)</label>
                  <textarea
                    value={description}
                    rows={3}
                    placeholder="What this space is for. Shown to MCP agents as overall guidance for its tools."
                    disabled={!canManageSpace || savingSpace || recordLoading}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>
              {!labelsLoading && sharedSequenceLabels.length > 0 ? (
                <div className="builderRow">
                  <div className="builderField">
                    <label>shared sequences (optional)</label>
                    <SpaceLabelsPicker
                      options={sharedSequenceLabels}
                      selected={labels}
                      onChange={setLabels}
                      disabled={!canManageSpace || savingSpace || recordLoading}
                      loading={labelsLoading}
                    />
                  </div>
                </div>
              ) : null}
            </div>
            <div className="buttonRow">
              <button
                type="button"
                className="btnPrimary"
                data-testid="space-settings-save-btn"
                disabled={!canSave}
                onClick={save}
              >
                {savingSpace ? "Saving..." : "Save changes"}
              </button>
              {canManageSpace ? (
                <button
                  type="button"
                  className="btnDanger"
                  data-testid="space-delete-btn"
                  onClick={onDeleteSpace}
                >
                  Delete space
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {tab === "users" && canManageSpace ? (
          <UsersPanel
            spaceId={spaceId}
            me={me}
            sequences={sequences}
            embedded
          />
        ) : null}

        {tab === "agents" && canManageSpace ? <AgentsPanel spaceId={spaceId} /> : null}

        {tab === "credentials" && canManageSpace ? (
          <CredentialsPanel spaceId={spaceId} />
        ) : null}

        {tab === "embeddings" && canManageSpace ? (
          <EmbeddingsPanel spaceId={spaceId} />
        ) : null}

        {tab === "templates" && canManageSpace ? (
          <TemplatesPanel spaceId={spaceId} />
        ) : null}

        {tab === "audit" ? (
          <AuditLogSection
            entries={auditLog.entries}
            loading={auditLog.loading}
            error={auditLog.error}
            sequences={sequences}
            events={events}
            onRefresh={onLoadAuditLog}
          />
        ) : null}
      </div>
    </div>
  );
}
