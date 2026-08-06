import { useCallback, useEffect, useState } from "react";
import {
  deleteCredential,
  fetchCredentials,
  upsertCredential,
  type Credential
} from "../../services/api";

interface CredentialsPanelProps {
  spaceId: string | null;
}

function formatDate(value: string | null): string {
  if (!value) return "never";
  const parsed = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

/** A read-only value in a code block with a one-click copy button. */
function CopyField({ value }: { value: string }) {
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
      <code>{value}</code>
      <button type="button" className="btnPrimary" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function CredentialsPanel({ spaceId }: CredentialsPanelProps) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [backend, setBackend] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const writable = backend === "local";

  const reload = useCallback(async () => {
    if (!spaceId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCredentials(spaceId);
      setCredentials(result.credentials);
      setBackend(result.backend);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load credentials");
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<void>) {
    try {
      await action();
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!spaceId || !newName.trim()) return;
    await run(async () => {
      await upsertCredential(
        spaceId,
        newName.trim(),
        newValue ? newValue : undefined,
        newDescription.trim()
      );
      setNewName("");
      setNewValue("");
      setNewDescription("");
    });
  }

  if (!spaceId) {
    return <p className="muted">Select a space to manage its credentials.</p>;
  }

  return (
    <>
      <div className="rbacHeaderRow">
        <h3>Credentials</h3>
      </div>
      <p className="muted rbacSectionHint">
        Securely store API keys and authorization secrets for this space. Reference a
        credential from a workflow step&apos;s headers or body as{" "}
        <code>$secret.&lt;NAME&gt;</code> (for example{" "}
        <code>{'"Authorization": "Bearer $secret.MY_API_KEY"'}</code>). The value is resolved
        only when the request runs and is never stored in the workflow, run history, or logs.
      </p>
      {error ? <div className="errorText">{error}</div> : null}
      {loading ? <p className="muted">Loading…</p> : null}

      <h3 className="navSectionHeader">Storage</h3>
      {writable ? (
        <p className="muted rbacSectionHint">
          This instance stores credentials in its local <code>.env</code> file
          (<code>local</code> backend).
        </p>
      ) : (
        <p className="muted rbacSectionHint">
          This instance uses the <code>{backend || "passthrough"}</code> backend: secret
          values are injected by the hosting platform, not written here. You can still
          register a credential name below; set its value in your platform&apos;s secret
          store under the env key shown for each entry.
        </p>
      )}

      <form className="rbacInviteRow" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Name (e.g. STRIPE_KEY)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          type="password"
          placeholder={writable ? "Value (secret)" : "Value (set on platform)"}
          value={newValue}
          autoComplete="new-password"
          disabled={!writable}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <input
          type="text"
          placeholder="Description (optional)"
          value={newDescription}
          onChange={(e) => setNewDescription(e.target.value)}
        />
        <button className="btnPrimary" type="submit" disabled={!newName.trim()}>
          Save credential
        </button>
      </form>

      <h3 className="navSectionHeader">Stored credentials</h3>
      {credentials.length === 0 ? (
        <p className="muted">No credentials yet.</p>
      ) : (
        <ul className="rbacMemberList">
          {credentials.map((cred) => (
            <li key={cred.id} className="rbacMemberRow">
              <div className="rbacMemberHead">
                <div className="rbacMemberId">
                  <span>{cred.name}</span>
                  <span className="rbacSubId">
                    env key {cred.envKey} · updated {formatDate(cred.modifiedDate)}
                  </span>
                  {cred.description ? (
                    <span className="rbacSubId">{cred.description}</span>
                  ) : null}
                  {cred.configured ? (
                    <span className="rbacBadge">configured</span>
                  ) : (
                    <span className="rbacBadge">no value set</span>
                  )}
                </div>
                <div className="rbacMemberControls">
                  <button
                    className="btnDanger"
                    type="button"
                    onClick={() => run(() => deleteCredential(spaceId, cred.name))}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <CopyField value={`$secret.${cred.name}`} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
