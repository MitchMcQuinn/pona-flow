import { Fragment, useEffect, useMemo, useState } from "react";
import {
  factoryResetInstance,
  fetchSpaceRecord,
  resetSpaceData,
  type CreateSpaceInput
} from "../../services/api";
import type { AppState, AuditEntry, Me, SequenceSummary } from "../../state/types";
import {
  isValidSpaceNameInput,
  normalizeSpaceName,
  sanitizeSpaceNameInput
} from "../../utils/spaceName";
import { ChatModelSettings } from "./ChatModelSettings";
import { AgentsPanel } from "../agents/AgentsPanel";
import { Toggle } from "../builder/Toggle";
import { CredentialsPanel } from "../credentials/CredentialsPanel";
import { EmbeddingsPanel } from "../embeddings/EmbeddingsPanel";
import { TemplatesPanel } from "../templates/TemplatesPanel";
import { UsersPanel } from "../users/UsersPanel";
import { AuditParameterMap } from "./AuditParameterMap";
import { ResetConfirmModal } from "./ResetConfirmModal";
import "../builder/builder.css";

type SpaceConfigTab =
  | "settings"
  | "chat"
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
  onStartTour: () => void;
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
        <h2>audit log</h2>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      <p className="muted">
        Read-only record of every sequence run in this space, including the parameter map
        collected during the run.
      </p>
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
              <Fragment key={entry.id}>
                <tr>
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
                <tr className="auditParamRow">
                  <td colSpan={5}>
                    <AuditParameterMap map={entry.parameterMap} />
                  </td>
                </tr>
              </Fragment>
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
  onClose,
  onStartTour
}: SpaceConfigPanelProps) {
  const [tab, setTab] = useState<SpaceConfigTab>("settings");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [description, setDescription] = useState("");
  const [devMode, setDevMode] = useState(false);
  const [storedName, setStoredName] = useState("");
  const [recordLoading, setRecordLoading] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [resetKind, setResetKind] = useState<null | "space" | "instance">(null);
  const [resetSaving, setResetSaving] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const canManageSpace = Boolean(permissions?.manageSpace || me?.isSuperadmin);

  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    setRecordLoading(true);
    setRecordError(null);
    fetchSpaceRecord(spaceId)
      .then((record) => {
        if (cancelled) return;
        setName(record.name);
        setStoredName(record.name);
        setEndpoint(record.endpoint ?? "");
        setDescription(record.description ?? "");
        setDevMode(Boolean(record.dev_mode));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRecordError(error instanceof Error ? error.message : "Failed to load space");
        const fallback = spaces.find((space) => space.id === spaceId)?.label ?? spaceId;
        setName(fallback);
        setStoredName(fallback);
        setEndpoint("");
        setDescription("");
        setDevMode(false);
      })
      .finally(() => {
        if (!cancelled) setRecordLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Reload when the selected space changes, not when the spaces list identity
    // updates after save — that refetch was overwriting the just-saved toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  useEffect(() => {
    if (tab === "audit") onLoadAuditLog();
  }, [tab, onLoadAuditLog]);

  useEffect(() => {
    setLocalError(null);
  }, [name, endpoint, description, devMode]);

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
      setLocalError("Name needs at least one letter or number.");
      return;
    }
    if (duplicate) {
      setLocalError("A space with this name already exists.");
      return;
    }
    await onSaveSpace({
      name: trimmedName,
      endpoint: endpoint.trim(),
      description: description.trim(),
      dev_mode: devMode
    });
    setStoredName(trimmedName);
  }

  async function confirmReset() {
    if (!spaceId || !resetKind) return;
    setResetSaving(true);
    setResetError(null);
    try {
      if (resetKind === "space") {
        await resetSpaceData(spaceId, storedName);
      } else {
        await factoryResetInstance();
      }
      window.location.reload();
    } catch (error: unknown) {
      setResetError(error instanceof Error ? error.message : "Reset failed");
      setResetSaving(false);
    }
  }

  return (
    <div className="panel configPanel spaceConfigPanel">
      <div className="panel__body">
        <div className="rbacHeaderRow">
          <h1>space</h1>
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
              className={tab === "chat" ? "active" : undefined}
              data-testid="space-tab-chat"
              onClick={() => setTab("chat")}
            >
              Chat
            </button>
          ) : null}
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
            <h2>settings</h2>
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
              <div className="builderRowFlags">
                <Toggle
                  checked={devMode}
                  onChange={setDevMode}
                  label="dev mode"
                  id="space-dev-mode-toggle"
                  disabled={!canManageSpace || savingSpace || recordLoading}
                />
                <span className="muted">
                  Show composed Cypher and SQLite previews in the builder.
                </span>
              </div>
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
            {canManageSpace && spaceId ? (
              <div className="spaceResetCard">
                <h3>Reset</h3>
                <p className="muted">
                  Reset space clears this space's graph, records, sequences, events, consoles,
                  and chat. The space stays, along with its members, roles, credentials, and
                  settings.
                </p>
                {me?.isSuperadmin ? (
                  <p className="muted">
                    Factory reset erases every space, account, and saved secret on this instance,
                    then opens first-run setup. A sign-in that lives outside this instance, such
                    as Clerk, stays.
                  </p>
                ) : null}
                <div className="spaceResetActions">
                  <button
                    type="button"
                    className="btnDanger"
                    data-testid="space-reset-btn"
                    disabled={!storedName || recordLoading}
                    onClick={() => {
                      setResetError(null);
                      setResetKind("space");
                    }}
                  >
                    Reset space
                  </button>
                  {me?.isSuperadmin ? (
                    <button
                      type="button"
                      className="btnDanger"
                      data-testid="instance-reset-btn"
                      onClick={() => {
                        setResetError(null);
                        setResetKind("instance");
                      }}
                    >
                      Factory reset
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="spaceTourCard">
              <div>
                <strong>Product tour</strong>
                <p className="muted">
                  A two-minute walk through the main parts of pona flow and what they're for.
                </p>
              </div>
              <button type="button" data-testid="space-start-tour-btn" onClick={onStartTour}>
                Take the product tour
              </button>
            </div>
          </div>
        ) : null}

        {tab === "chat" && canManageSpace && spaceId ? <ChatModelSettings spaceId={spaceId} /> : null}

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
      {resetKind === "space" ? (
        <ResetConfirmModal
          title="Reset space"
          description="This clears the graph and the records, sequences, events, consoles, and chat that belong to this space. Members, roles, credentials, and settings stay."
          phrase={storedName}
          saving={resetSaving}
          error={resetError}
          confirmLabel="Reset space"
          testId="modal-reset-space"
          onCancel={() => {
            if (!resetSaving) setResetKind(null);
          }}
          onConfirm={confirmReset}
        />
      ) : null}
      {resetKind === "instance" ? (
        <ResetConfirmModal
          title="Factory reset"
          description="This erases every space and account stored here, then opens first-run setup. A sign-in that lives outside this instance, such as Clerk, stays."
          phrase="RESET INSTANCE"
          saving={resetSaving}
          error={resetError}
          confirmLabel="Factory reset"
          testId="modal-reset-instance"
          onCancel={() => {
            if (!resetSaving) setResetKind(null);
          }}
          onConfirm={confirmReset}
        />
      ) : null}
    </div>
  );
}
