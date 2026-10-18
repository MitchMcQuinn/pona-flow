import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  applyInstanceUpdate,
  fetchInstanceUpdates,
  fetchInstanceVersion,
  saveInstanceUpdateCredentials,
  type InstanceUpdateStatus,
  type InstanceVersion
} from "../../services/api";

function shortSha(sha: string): string {
  return (sha || "").slice(0, 7) || "—";
}

export function InstanceUpdates() {
  const [status, setStatus] = useState<InstanceUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [token, setToken] = useState("");
  const [appName, setAppName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchInstanceUpdates();
      setStatus(next);
      setAppName((current) => current || next.fly_app_name || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load updates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveCredentials(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: { fly_api_token?: string; fly_app_name?: string } = {};
      if (token.trim()) body.fly_api_token = token.trim();
      if (appName.trim()) body.fly_app_name = appName.trim();
      await saveInstanceUpdateCredentials(body);
      setToken("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save credentials");
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    const before = status;
    setUpdating(true);
    setError(null);
    setNotice(null);
    try {
      await applyInstanceUpdate();
    } catch {
      // The process often restarts mid-request; treat disconnect as in-progress.
    }
    // Poll the cheap version endpoint (not GitHub) until the restarted process answers.
    const deadline = Date.now() + 180_000;
    let restarted: InstanceVersion | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const version = await fetchInstanceVersion();
        if (!before || version.started_at !== before.started_at) {
          restarted = version;
          break;
        }
      } catch {
        /* still restarting */
      }
    }
    setUpdating(false);
    if (!restarted) {
      setNotice("Update requested. Reload this page in a minute if the version hasn't changed.");
      return;
    }
    if (before && restarted.build_sha === before.current_sha) {
      setNotice(
        "Restarted, but the newest version isn't published yet — it's usually ready 5–10 " +
          "minutes after a change lands on main. Try again shortly."
      );
    }
    await load();
  }

  const headline = !status
    ? "Instance updates"
    : status.up_to_date
      ? "This instance is on latest main"
      : status.behind
        ? `${status.commits.length || "New"} commit${status.commits.length === 1 ? "" : "s"} on main`
        : "Instance updates";

  return (
    <div className="instanceUpdates" data-testid="instance-updates">
      <div className="instanceUpdatesHead">
        <span className="instanceUpdatesTitle">{headline}</span>
        {status ? (
          <span className="navUserMenuHint">
            {shortSha(status.current_sha)} → {shortSha(status.latest_sha)}
          </span>
        ) : null}
      </div>
      {loading ? <p className="navUserMenuHint">Checking GitHub…</p> : null}
      {error ? <p className="errorText">{error}</p> : null}
      {status?.github_error ? <p className="navUserMenuHint">{status.github_error}</p> : null}
      {notice ? <p className="navUserMenuHint">{notice}</p> : null}
      {status && status.commits.length > 0 ? (
        <ul className="instanceUpdateCommits">
          {status.commits.map((commit) => (
            <li key={commit.sha}>
              <a href={commit.url || undefined} target="_blank" rel="noopener noreferrer">
                {commit.message || shortSha(commit.sha)}
              </a>
              <span className="navUserMenuHint">{shortSha(commit.sha)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {status && !status.fly_token_configured ? (
        <form className="instanceUpdateCreds" onSubmit={saveCredentials}>
          <p className="navUserMenuHint">
            Paste a Fly deploy token to update from this menu. Create one under Fly → Account →
            Access Tokens, or skip and run <code>{status.manual_hint}</code>.
          </p>
          <label className="field navUserMenuField">
            Fly app name
            <input
              type="text"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              placeholder="pona-flow-instance"
              autoComplete="off"
            />
          </label>
          <label className="field navUserMenuField">
            Fly deploy token
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button type="submit" className="tinyBtn" disabled={saving || (!token.trim() && !appName.trim())}>
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      ) : null}
      {status?.can_update ? (
        <button
          type="button"
          className="btn instanceUpdateBtn"
          data-testid="instance-update-btn"
          disabled={updating}
          onClick={() => void apply()}
        >
          {updating ? "Updating…" : "Update to latest main"}
        </button>
      ) : null}
      {status?.up_to_date ? <p className="navUserMenuHint">No update needed.</p> : null}
      {status && !status.can_update && status.behind && status.fly_token_configured ? (
        <p className="navUserMenuHint">{status.manual_hint}</p>
      ) : null}
    </div>
  );
}
