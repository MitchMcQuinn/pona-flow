import { useCallback, useEffect, useState } from "react";
import {
  advanceSimulationSession,
  clearSimulationSessionError,
  createSimulationSession,
  deleteSimulationSession,
  fetchSimulationSession,
  fetchSimulationSessions,
  type SimulationSession
} from "../../services/api";

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
}

/** In-panel session runner plus the public URLs a test harness can call. */
export function SimulationSessions({ eventId, token }: SimulationSessionsProps) {
  const [startAt, setStartAt] = useState(nowLocalInput);
  const [sessions, setSessions] = useState<SimulationSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SimulationSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    reload()
      .then((rows) => {
        if (cancelled || !rows) return;
        setSelectedId((current) => current ?? rows[0]?.id ?? null);
      })
      .catch((err: unknown) => {
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
    fetchSimulationSession(eventId, selectedId)
      .then((row) => {
        if (!cancelled) setDetail(row);
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

  async function handleDelete() {
    if (!eventId || !selectedId) return;
    const removing = selectedId;
    await run(async () => {
      await deleteSimulationSession(eventId, removing);
      const rows = await reload();
      const nextId = rows?.find((row) => row.id !== removing)?.id ?? null;
      setSelectedId(nextId);
      if (!nextId) setDetail(null);
    });
  }

  return (
    <div className="simSessions">
      <div className="field">
        <label>Session endpoints</label>
        {base ? (
          <>
            <CopyField
              value={`POST ${base}/sessions\n{"world_start_at":"<ISO-8601>"}`}
              testId="sim-url-create"
            />
            <CopyField
              value={`DELETE ${base}/sessions/{session_id}`}
              testId="sim-url-delete"
            />
            <CopyField
              value={`POST ${base}/sessions/{session_id}/tic`}
              testId="sim-url-tic"
            />
            <CopyField
              value={`POST ${base}/sessions/{session_id}/clear-error`}
              testId="sim-url-clear"
            />
            <span className="eventHint">
              These URLs are the secret; no login is required. The same actions are available
              to a signed-in user or agent key at{" "}
              <code>{`/api/events/${eventId ?? "{event_id}"}/sessions`}</code>.
            </span>
          </>
        ) : (
          <p className="muted">The session URLs are generated when you first save this event.</p>
        )}
      </div>

      {eventId ? (
        <>
          <div className="eventRow">
            <div className="field">
              <label htmlFor="sim-session-start">In-world start</label>
              <input
                id="sim-session-start"
                data-testid="sim-session-start"
                type="datetime-local"
                value={startAt}
                onChange={(event) => setStartAt(event.target.value)}
              />
            </div>
            <div className="field">
              <label>&nbsp;</label>
              <button
                type="button"
                className="tinyBtn"
                data-testid="sim-session-create"
                disabled={busy}
                onClick={handleCreate}
              >
                New session
              </button>
            </div>
          </div>

          <div className="field">
            <label>Sessions</label>
            {sessions.length === 0 ? (
              <p className="muted">No sessions yet.</p>
            ) : (
              <div className="eventChips">
                {sessions.map((session) => (
                  <button
                    type="button"
                    key={session.id}
                    className={`eventChip${session.id === selectedId ? " active" : ""}`}
                    onClick={() => setSelectedId(session.id)}
                  >
                    tic {session.currentTic} · {session.status}
                  </button>
                ))}
              </div>
            )}
          </div>

          {detail ? (
            <div className="eventGroup" data-testid="sim-session-detail">
              <div className="eventGroupHeader">
                <span className="eventGroupTitle">
                  Tic {detail.currentTic} · {formatWhen(detail.currentWorldTime)}
                </span>
                <button
                  type="button"
                  className="tinyBtn"
                  data-testid="sim-session-advance"
                  disabled={busy || detail.status === "error"}
                  onClick={handleAdvance}
                >
                  Advance tic
                </button>
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
              {(detail.emissions || []).length === 0 ? (
                <p className="muted">No emissions yet.</p>
              ) : (
                <ul className="simEmissions">
                  {(detail.emissions || []).map((emission) => (
                    <li key={emission.id} data-testid="sim-emission">
                      <strong>
                        tic {emission.tic} · {emission.probabilityName || emission.probabilityId}
                      </strong>
                      {emission.cancelled ? " · cancelled" : ""}
                      {emission.runStatus ? ` · ${emission.runStatus}` : ""}
                      {emission.outcome ? (
                        <pre>{JSON.stringify(emission.outcome)}</pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </>
      ) : null}

      {error ? <p className="errorText">{error}</p> : null}
    </div>
  );
}
