import { useCallback, useEffect, useRef, useState } from "react";
import {
  advanceSimulationSession,
  clearSimulationSessionError,
  createSimulationSession,
  deleteSimulationSession,
  renameSimulationSession,
  fetchSimulationSession,
  fetchSimulationSessions,
  type SimulationSession
} from "../../services/api";
import { EventInlineField } from "./EventInlineField";

function apiOrigin(): string {
  if (typeof window !== "undefined" && window.location) return window.location.origin;
  return "";
}

function nowLocalInput(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function sessionName(session: { name?: string | null; worldStartAt: string }): string {
  const custom = session.name?.trim();
  return custom || formatWhen(session.worldStartAt);
}

function CopyField({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="agentTokenCode">
      <code data-testid={testId}>{value}</code>
      <button type="button" className="btnPrimary" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

interface SimulationSessionsProps {
  eventId: string | null;
  token: string;
  /** Saved events show one pane at a time. Omit to show the pre-save endpoint note. */
  view?: "endpoints" | "sessions";
}

/** In-panel session runner plus the public URLs a test harness can call. */
export function SimulationSessions({ eventId, token, view }: SimulationSessionsProps) {
  const [startAt, setStartAt] = useState(nowLocalInput);
  const [sessions, setSessions] = useState<SimulationSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SimulationSession | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const nameDraftRef = useRef("");
  const nameSaveTimer = useRef<number | null>(null);
  const nameSaveGen = useRef(0);
  const detailRef = useRef<SimulationSession | null>(null);
  const eventIdRef = useRef(eventId);
  detailRef.current = detail;
  eventIdRef.current = eventId;
  const [error, setError] = useState<string | null>(null);
  const [trackedView, setTrackedView] = useState(view);
  if (view !== trackedView) {
    setTrackedView(view);
    if (view === "sessions") setSelectedId(null);
  }

  const origin = apiOrigin();
  const base = token ? `${origin}/api/sim/${token}` : "";

  const reload = useCallback(async () => {
    if (!eventId) return;
    const rows = await fetchSimulationSessions(eventId);
    setSessions(rows);
    return rows;
  }, [eventId]);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    reload().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load sessions");
    });
    return () => {
      cancelled = true;
    };
  }, [eventId, reload]);

  useEffect(() => {
    if (!eventId || !selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    fetchSimulationSession(eventId, selectedId)
      .then((row) => {
        if (cancelled) return;
        const shown = sessionName(row);
        nameDraftRef.current = shown;
        setDetail(row);
        setNameDraft(shown);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load session");
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, selectedId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Simulation request failed");
    } finally {
      setBusy(false);
    }
  }

  function clearNameSaveTimer() {
    if (nameSaveTimer.current != null) {
      window.clearTimeout(nameSaveTimer.current);
      nameSaveTimer.current = null;
    }
  }

  async function persistName(raw: string, restoreIfBlank: boolean) {
    const current = detailRef.current;
    const id = eventIdRef.current;
    if (!id || !current?.id) return;
    const fallback = formatWhen(current.worldStartAt);
    const next = raw.trim();
    if (!next && !restoreIfBlank) return;
    const custom = next && next !== fallback ? next : "";
    const stored = (current.name || "").trim();
    if (custom === stored) {
      if (restoreIfBlank) {
        const shown = sessionName({ ...current, name: custom || null });
        nameDraftRef.current = shown;
        setNameDraft(shown);
      }
      return;
    }
    const gen = ++nameSaveGen.current;
    try {
      const updated = await renameSimulationSession(id, current.id, custom);
      if (gen !== nameSaveGen.current || detailRef.current?.id !== current.id) return;
      setDetail(updated);
      await reload();
      const shown = sessionName(updated);
      const stillEditing = nameDraftRef.current.trim() !== raw.trim();
      if (!stillEditing) {
        nameDraftRef.current = shown;
        setNameDraft(shown);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rename session");
    }
  }

  function scheduleNameSave(raw: string) {
    clearNameSaveTimer();
    nameSaveTimer.current = window.setTimeout(() => {
      nameSaveTimer.current = null;
      void persistName(raw, false);
    }, 400);
  }

  useEffect(() => clearNameSaveTimer, [selectedId]);

  async function handleCreate() {
    if (!eventId) return;
    const iso = new Date(startAt).toISOString();
    await run(async () => {
      const created = await createSimulationSession(eventId, iso);
      await reload();
      setSelectedId(created.id);
      setDetail(created);
    });
  }

  async function handleAdvance() {
    if (!eventId || !selectedId) return;
    await run(async () => {
      const next = await advanceSimulationSession(eventId, selectedId);
      setDetail(next);
      await reload();
    });
  }

  async function handleClear() {
    if (!eventId || !selectedId) return;
    await run(async () => {
      const next = await clearSimulationSessionError(eventId, selectedId);
      setDetail(next);
      await reload();
    });
  }

  async function handleDeleteSession(sessionId: string) {
    if (!eventId) return;
    await run(async () => {
      await deleteSimulationSession(eventId, sessionId);
      await reload();
      if (selectedId === sessionId) {
        setSelectedId(null);
        setDetail(null);
      }
    });
  }

  async function handleDelete() {
    if (!selectedId) return;
    await handleDeleteSession(selectedId);
  }

  const endpointTip =
    "These URLs are the secret — no login is required. The same actions are available to a signed-in user or agent key at /api/events/{event_id}/sessions.";
  const showEndpoints = view !== "sessions";
  const showSessions = view !== "endpoints";

  return (
    <div className="simSessions">
      {showEndpoints && base ? (
        <>
          <EventInlineField label="create" tip={endpointTip}>
            <CopyField
              value={`POST ${base}/sessions\n{"world_start_at":"<ISO-8601>"}`}
              testId="sim-url-create"
            />
          </EventInlineField>
          <EventInlineField label="delete">
            <CopyField value={`DELETE ${base}/sessions/{session_id}`} testId="sim-url-delete" />
          </EventInlineField>
          <EventInlineField label="tic">
            <CopyField value={`POST ${base}/sessions/{session_id}/tic`} testId="sim-url-tic" />
          </EventInlineField>
          <EventInlineField label="clear error">
            <CopyField
              value={`POST ${base}/sessions/{session_id}/clear-error`}
              testId="sim-url-clear"
            />
          </EventInlineField>
        </>
      ) : showEndpoints ? (
        <EventInlineField label="session endpoints" tip={endpointTip}>
          <p className="muted">Save to generate session URLs.</p>
        </EventInlineField>
      ) : null}

      {showSessions && eventId && !selectedId ? (
        <>
          <EventInlineField label="start" htmlFor="sim-session-start">
            <input
              id="sim-session-start"
              data-testid="sim-session-start"
              type="datetime-local"
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
            <button
              type="button"
              className="btnPrimary simSessionCreate"
              data-testid="sim-session-create"
              disabled={busy}
              onClick={handleCreate}
            >
              + New session
            </button>
          </EventInlineField>

          {sessions.length === 0 ? (
            <p className="muted">No sessions yet.</p>
          ) : (
            <ul className="simSessionList">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className="simSessionListOpen"
                    data-testid="sim-session-item"
                    onClick={() => setSelectedId(session.id)}
                  >
                    <span className="simSessionListTitle">{sessionName(session)}</span>
                    <span className="simSessionListMeta">
                      tic {session.currentTic} · {session.status}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="simSessionDelete"
                    aria-label={`Delete session ${sessionName(session)}`}
                    title="Delete session"
                    data-testid="sim-session-list-delete"
                    disabled={busy}
                    onClick={() => void handleDeleteSession(session.id)}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path
                        d="M3 4.5h10M6 4.5V3.5h4v1M5.5 4.5v8h5v-8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {showSessions && eventId && selectedId ? (
        <div className="simSessionRun" data-testid="sim-session-detail">
          <button
            type="button"
            className="simSessionBack"
            data-testid="sim-session-back"
            onClick={() => setSelectedId(null)}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path fill="currentColor" d="M9.8 2.8 4.5 8l5.3 5.2V2.8z" />
            </svg>
            back to sessions
          </button>
          {detail ? (
            <>
              <div className="builderField builderPropertyName simSessionName">
                <input
                  id="sim-session-name"
                  className="builderPropertyNameInput"
                  aria-label="session name"
                  data-testid="sim-session-name"
                  value={nameDraft}
                  placeholder={formatWhen(detail.worldStartAt)}
                  onChange={(event) => {
                    nameDraftRef.current = event.target.value;
                    setNameDraft(event.target.value);
                    scheduleNameSave(event.target.value);
                  }}
                  onBlur={() => {
                    clearNameSaveTimer();
                    void persistName(nameDraftRef.current, true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </div>
              <p className="simSessionRunMeta">
                tic {detail.currentTic} · {detail.status} · {formatWhen(detail.currentWorldTime)}
              </p>
              <div className="simSessionActions">
                {detail.status === "error" ? (
                  <button
                    type="button"
                    className="tinyBtn"
                    data-testid="sim-session-clear"
                    disabled={busy}
                    onClick={handleClear}
                  >
                    Clear error
                  </button>
                ) : null}
                <button
                  type="button"
                  className="tinyBtn danger"
                  data-testid="sim-session-delete"
                  disabled={busy}
                  onClick={handleDelete}
                >
                  Delete
                </button>
              </div>
              {detail.errorMessage ? <p className="errorText">{detail.errorMessage}</p> : null}
              <div className="simEmissionsBlock">
                <h2 className="simEmissionsHeading">emissions</h2>
                {(detail.emissions || []).length === 0 ? (
                  <p className="muted">No emissions yet.</p>
                ) : (
                  <div className="eventInlineNest">
                    <ul className="simEmissions">
                      {(detail.emissions || []).map((emission) => (
                        <li key={emission.id} data-testid="sim-emission">
                          <strong>
                            tic {emission.tic} · {emission.probabilityName || emission.probabilityId}
                          </strong>
                          {emission.cancelled ? " · cancelled" : ""}
                          {emission.runStatus ? ` · ${emission.runStatus}` : ""}
                          {emission.outcome ? <pre>{JSON.stringify(emission.outcome)}</pre> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btnPrimary simSessionAdvance"
                data-testid="sim-session-advance"
                disabled={busy || detail.status === "error"}
                onClick={handleAdvance}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path fill="currentColor" d="M5.25 3.5v9l7.25-4.5L5.25 3.5z" />
                </svg>
                Advance tic
              </button>
            </>
          ) : (
            <p className="muted">Loading session...</p>
          )}
        </div>
      ) : null}

      {error ? <p className="errorText">{error}</p> : null}
    </div>
  );
}
