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
import {
  browserTimeZone,
  supportedTimeZones,
  timeZoneLabel
} from "../../services/timezone";
import { InstanceUpdates } from "../settings/InstanceUpdates";
import { TabChromeSettings } from "../settings/TabChrome";
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
  | "audit"
  | "account"
  | "update";

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
  onLoadAuditLog: () => void;
  onClose: () => void;
  onStartTour: () => void;
  userName: string | null;
  userEmail: string | null;
  onSaveTimezone: (timezone: string) => void;
  onLogout: () => void;
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
          {loading ? "loading..." : "refresh"}
        </button>
      </div>
      <p className="muted">
        read-only record of every sequence run in this space, including the parameter map
        collected during the run.
      </p>
      {error ? <p className="errorText">{error}</p> : null}
      {!loading && !error && entries.length === 0 ? (
        <p className="muted">no sequence runs recorded yet.</p>
      ) : null}
      {!error && entries.length > 0 ? (
        <table className="auditLogTable">
          <thead>
            <tr>
              <th>run at (UTC)</th>
              <th>trigger</th>
              <th>sequence(s)</th>
              <th>event</th>
              <th>principal</th>
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

function AccountSection({
  userName,
  userEmail,
  userTimezone,
  onSaveTimezone,
  onLogout
}: {
  userName: string | null;
  userEmail: string | null;
  userTimezone: string | null;
  onSaveTimezone: (timezone: string) => void;
  onLogout: () => void;
}) {
  const zones = useMemo(() => supportedTimeZones(), []);
  const selectedZone = userTimezone || browserTimeZone();
  const displayName = userName?.trim() || userEmail?.trim() || "account";

  return (
    <div className="spaceConfigSection">
      <h2>account</h2>
      <div className="navUserMenuHeader">
        <span className="navUserMenuName">{displayName}</span>
        {userEmail && userEmail !== displayName ? (
          <span className="navUserMenuEmail">{userEmail}</span>
        ) : null}
      </div>
      <div className="field navUserMenuField">
        <label htmlFor="user-timezone">timezone</label>
        <select
          id="user-timezone"
          value={selectedZone}
          onChange={(event) => onSaveTimezone(event.target.value)}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {timeZoneLabel(zone)}
            </option>
          ))}
        </select>
        <span className="navUserMenuHint">used to show event times in your local time.</span>
      </div>
      <button type="button" className="navUserLogoutBtn" onClick={onLogout}>
        log out
      </button>
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
  onLoadAuditLog,
  onClose,
  onStartTour,
  userName,
  userEmail,
  onSaveTimezone,
  onLogout
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
        <div className="canvasInsightBar">
          <button type="button" className="canvasInsightClose" aria-label="close" onClick={onClose}>
            ×
          </button>
        </div>
        <h1>space</h1>
        {!spaceId ? <p className="muted">select a space to configure it.</p> : null}

        <div className="spaceConfigTabs" role="tablist" aria-label="space configuration">
          <button
            type="button"
            className={tab === "settings" ? "active" : undefined}
            data-testid="space-tab-settings"
            onClick={() => setTab("settings")}
          >
            settings
          </button>
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "chat" ? "active" : undefined}
              data-testid="space-tab-chat"
              onClick={() => setTab("chat")}
            >
              chat
            </button>
          ) : null}
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "users" ? "active" : undefined}
              data-testid="space-tab-users"
              onClick={() => setTab("users")}
            >
              users
            </button>
          ) : null}
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "agents" ? "active" : undefined}
              data-testid="space-tab-agents"
              onClick={() => setTab("agents")}
            >
              agents
            </button>
          ) : null}
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "credentials" ? "active" : undefined}
              data-testid="space-tab-credentials"
              onClick={() => setTab("credentials")}
            >
              credentials
            </button>
          ) : null}
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "embeddings" ? "active" : undefined}
              data-testid="space-tab-embeddings"
              onClick={() => setTab("embeddings")}
            >
              embeddings
            </button>
          ) : null}
          {canManageSpace ? (
            <button
              type="button"
              className={tab === "templates" ? "active" : undefined}
              data-testid="space-tab-templates"
              onClick={() => setTab("templates")}
            >
              templates
            </button>
          ) : null}
          <button
            type="button"
            className={tab === "audit" ? "active" : undefined}
            data-testid="space-tab-audit"
            onClick={() => setTab("audit")}
          >
            audit log
          </button>
          <button
            type="button"
            className={tab === "account" ? "active" : undefined}
            data-testid="space-tab-account"
            onClick={() => setTab("account")}
          >
            account
          </button>
          {me?.isSuperadmin ? (
            <button
              type="button"
              className={tab === "update" ? "active" : undefined}
              data-testid="space-tab-update"
              onClick={() => setTab("update")}
            >
              update
            </button>
          ) : null}
        </div>

        <div key={tab} className="screenFade">
        {tab === "settings" ? (
          <div className="spaceConfigSection">
            <h2>settings</h2>
            {recordLoading ? <p className="muted">loading space...</p> : null}
            {displayError ? <p className="builderCheckMsg error">{displayError}</p> : null}
            {duplicate && !displayError ? (
              <p className="builderCheckMsg error">a space with this name already exists.</p>
            ) : null}
            <div className="builderFormFieldset">
              <div className="builderRow">
                <div className="builderField">
                  <label>name</label>
                  <input
                    value={name}
                    placeholder="e.g. test space"
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
                    placeholder="what this space is for. shown to MCP agents as overall guidance for its tools."
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
                  show composed cypher and sqlite previews in the builder.
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
                {savingSpace ? "saving..." : "save changes"}
              </button>
            </div>
            {me?.isSuperadmin ? <TabChromeSettings /> : null}
            {canManageSpace && spaceId ? (
              <div className="spaceResetCard">
                <h3>reset</h3>
                <p className="muted">
                  reset space clears this space graph, records, sequences, events, consoles,
                  and chat. the space stays, along with its members, roles, credentials, and
                  settings.
                </p>
                {me?.isSuperadmin ? (
                  <p className="muted">
                    factory reset erases every space, account, and saved secret on this instance,
                    then opens first-run setup. a sign-in that lives outside this instance, such
                    as clerk, stays.
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
                    reset space
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
                      factory reset
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="spaceTourCard">
              <div>
                <strong>product tour</strong>
                <p className="muted">
                  a two-minute walk through the main parts of pona flow and what they are for.
                </p>
              </div>
              <button type="button" data-testid="space-start-tour-btn" onClick={onStartTour}>
                take the product tour
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

        {tab === "account" ? (
          <AccountSection
            userName={userName}
            userEmail={userEmail}
            userTimezone={me?.timezone ?? null}
            onSaveTimezone={onSaveTimezone}
            onLogout={onLogout}
          />
        ) : null}

        {tab === "update" && me?.isSuperadmin ? (
          <div className="spaceConfigSection">
            <h2>update</h2>
            <InstanceUpdates />
          </div>
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
      {resetKind === "space" ? (
        <ResetConfirmModal
          title="reset space"
          description="this clears the graph and the records, sequences, events, consoles, and chat that belong to this space. members, roles, credentials, and settings stay."
          phrase={storedName}
          saving={resetSaving}
          error={resetError}
          confirmLabel="reset space"
          testId="modal-reset-space"
          onCancel={() => {
            if (!resetSaving) setResetKind(null);
          }}
          onConfirm={confirmReset}
        />
      ) : null}
      {resetKind === "instance" ? (
        <ResetConfirmModal
          title="factory reset"
          description="this erases every space and account stored here, then opens first-run setup. a sign-in that lives outside this instance, such as clerk, stays."
          phrase="RESET INSTANCE"
          saving={resetSaving}
          error={resetError}
          confirmLabel="factory reset"
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
