import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  applyInstanceUpdate,
  fetchInstanceUpdates,
  fetchInstanceVersion,
  saveInstanceUpdateCredentials,
  type InstanceUpdateStatus,
  type InstanceVersion
} from "../../services/api";
import { applyInstanceTitle } from "../../services/tabChrome";

function shortSha(sha: string): string {
  return (sha || "").slice(0, 7) || "—";
}

function FlyCredentials({
  intro,
  appName,
  token,
  saving,
  onAppName,
  onToken,
  onSubmit
}: {
  intro: ReactNode;
  appName: string;
  token: string;
  saving: boolean;
  onAppName: (value: string) => void;
  onToken: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="instanceUpdateCreds" onSubmit={onSubmit}>
      <p className="navUserMenuHint">{intro}</p>
      <label className="field navUserMenuField">
        fly app name
        <input
          type="text"
          value={appName}
          onChange={(e) => onAppName(e.target.value)}
          placeholder="pona-flow-instance"
          autoComplete="off"
        />
      </label>
      <label className="field navUserMenuField">
        fly deploy token
        <input
          type="password"
          value={token}
          onChange={(e) => onToken(e.target.value)}
          autoComplete="off"
        />
      </label>
      <button type="submit" className="tinyBtn" disabled={saving || (!token.trim() && !appName.trim())}>
        {saving ? "saving…" : "save"}
      </button>
    </form>
  );
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
      setError(e instanceof Error ? e.message : "failed to load updates");
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
      if (appName.trim()) applyInstanceTitle(appName);
      setToken("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save credentials");
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
    } catch (e) {
      // A restart often drops the response. A JSON error from the server is real.
      const message = e instanceof Error ? e.message : "";
      const disconnected = e instanceof TypeError || message === "Failed to fetch";
      if (!disconnected && message && message !== "Failed to start instance update") {
        setError(message);
        setUpdating(false);
        return;
      }
    }
    // Poll the cheap version endpoint (not GitHub) until the restarted process answers.
    const deadline = Date.now() + 180_000;
    let restarted: InstanceVersion | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const version = await fetchInstanceVersion();
        if (
          before?.update_method === "docker" &&
          version.update_result &&
          version.update_result.ok === false
        ) {
          setError(version.update_result.error || "local update failed");
          setUpdating(false);
          await load();
          return;
        }
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
      setNotice("update requested. reload this page in a minute if the version hasn't changed.");
      return;
    }
    if (before && restarted.build_sha === before.current_sha) {
      setNotice(
        "restarted onto the image already published. a commit only becomes an image after " +
          "CI succeeds — if that run failed, waiting longer will not publish it."
      );
    }
    await load();
  }

  const headline = !status
    ? "instance updates"
    : status.up_to_date
      ? "this instance is on latest main"
      : status.behind
        ? `${status.commits.length || "new"} commit${status.commits.length === 1 ? "" : "s"} on main`
        : "instance updates";

  const localMethod = status?.update_method === "docker" || status?.update_method === "git";
  const buttonLabel = updating ? "updating…" : localMethod ? "update locally" : "update to latest main";

  const flyForm = (
    <FlyCredentials
      intro={
        status && status.on_fly ? (
          <>
            paste an app deploy token for this app to update from this menu. create one under Fly →
            Account → Access Tokens and select this app, or skip and run <code>{status.manual_hint}</code>.
          </>
        ) : (
          "paste an app deploy token to update a Fly app from this menu."
        )
      }
      appName={appName}
      token={token}
      saving={saving}
      onAppName={setAppName}
      onToken={setToken}
      onSubmit={(event) => void saveCredentials(event)}
    />
  );

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
      {loading ? <p className="navUserMenuHint">checking GitHub…</p> : null}
      {error ? <p className="errorText">{error}</p> : null}
      {status?.github_error ? <p className="navUserMenuHint">{status.github_error}</p> : null}
      {notice ? <p className="navUserMenuHint">{notice}</p> : null}
      {!updating && status?.local_update_error ? (
        <p className="errorText">{status.local_update_error}</p>
      ) : null}
      {status && status.update_method !== "git" && status.publish_status === "failure" ? (
        <p className="errorText">
          {status.publish_error}{" "}
          {status.publish_url ? (
            <a href={status.publish_url} target="_blank" rel="noopener noreferrer">
              view the CI run
            </a>
          ) : null}
        </p>
      ) : null}
      {status && status.update_method !== "git" && status.publish_status === "in_progress" ? (
        <p className="navUserMenuHint">{status.publish_error}</p>
      ) : null}
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
      {status?.update_method === "docker" && status.can_update ? (
        <p className="navUserMenuHint">
          pulls {status.image} and restarts this container. your data stays on its volumes.
        </p>
      ) : null}
      {status?.update_method === "git" ? (
        <p className="navUserMenuHint">
          this copy is the source checkout
          {status.project_dir ? (
            <>
              {" "}
              at <code>{status.project_dir}</code>
            </>
          ) : null}
          .
          {status.can_update ? (
            <>
              {" "}
              update locally fast-forwards that folder to origin/{status.branch} and restarts the
              server.
            </>
          ) : null}
        </p>
      ) : null}
      {status?.git_error ? <p className="navUserMenuHint">{status.git_error}</p> : null}
      {status?.version_pin && status.behind ? (
        <p className="navUserMenuHint">
          this install is pinned to {status.version_pin}. set PONA_FLOW_VERSION=main in .env and
          restart to update from this menu.
        </p>
      ) : null}
      {status?.update_method === "docker" &&
      !status.local_updater_ready &&
      !status.up_to_date &&
      !status.version_pin ? (
        <p className="navUserMenuHint">
          the local updater is not running. in{" "}
          {status.project_dir ? (
            <code>{status.project_dir}</code>
          ) : (
            "the folder that contains docker-compose.yml"
          )}{" "}
          run <code>docker compose up -d</code>, then use update locally here.
        </p>
      ) : null}
      {status?.update_method === "manual" && !status.on_fly && status.behind ? (
        <>
          <p className="navUserMenuHint">
            run this in the folder that contains docker-compose.yml
            {status.project_dir ? (
              <>
                {" "}
                (<code>{status.project_dir}</code>)
              </>
            ) : (
              " — the folder where you ran docker compose up"
            )}
            :
          </p>
          <p className="instanceUpdateCmd">
            <code>{status.manual_hint}</code>
          </p>
          <p className="navUserMenuHint">
            a current compose file includes a local updater. after it is running, this menu can pull
            and restart the app.
          </p>
        </>
      ) : null}
      {status && !status.fly_token_configured && status.on_fly ? flyForm : null}
      {status &&
      !status.fly_token_configured &&
      !status.on_fly &&
      status.update_method !== "docker" &&
      !status.up_to_date ? (
        <details className="instanceUpdateFly">
          <summary>this copy runs on Fly</summary>
          {flyForm}
        </details>
      ) : null}
      {status?.can_update ? (
        <button
          type="button"
          className="btn instanceUpdateBtn"
          data-testid="instance-update-btn"
          disabled={updating}
          onClick={() => void apply()}
        >
          {buttonLabel}
        </button>
      ) : null}
      {status?.up_to_date ? <p className="navUserMenuHint">no update needed.</p> : null}
      {status &&
      !status.can_update &&
      status.behind &&
      status.fly_token_configured &&
      status.update_method === "fly" &&
      status.publish_status !== "failure" &&
      status.publish_status !== "in_progress" ? (
        <p className="navUserMenuHint">{status.manual_hint}</p>
      ) : null}
    </div>
  );
}
