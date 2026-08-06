import { useCallback, useEffect, useState } from "react";
import {
  createAgentKey,
  fetchAgentKeys,
  fetchSpaceRoles,
  revokeAgentKey,
  type AgentKey,
  type CreatedAgentKey,
  type SpaceRole
} from "../../services/api";
import { ModalBackdrop } from "../modals/ModalBackdrop";

interface AgentsPanelProps {
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

/** Base origin the browser is served from; agents call /api on this host. */
function apiOrigin(): string {
  if (typeof window !== "undefined" && window.location) return window.location.origin;
  return "";
}

export function AgentsPanel({ spaceId }: AgentsPanelProps) {
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [roles, setRoles] = useState<SpaceRole[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newRoleId, setNewRoleId] = useState("");
  const [created, setCreated] = useState<CreatedAgentKey | null>(null);

  const reload = useCallback(async () => {
    if (!spaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [k, r] = await Promise.all([fetchAgentKeys(spaceId), fetchSpaceRoles(spaceId)]);
      setKeys(k);
      setRoles(r);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load agents");
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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!spaceId || !newName.trim()) return;
    await run(async () => {
      const key = await createAgentKey(spaceId, newName.trim(), newRoleId || null);
      setCreated(key);
      setNewName("");
      setNewRoleId("");
    });
  }

  if (!spaceId) {
    return <p className="muted">Select a space to manage its agents.</p>;
  }

  return (
    <>
      <div className="rbacHeaderRow">
        <h3>Agents</h3>
      </div>
      <p className="muted rbacSectionHint">
        Agents are non-human callers (AI tools, external systems) that run this space&apos;s
        sequences using an API key instead of a login. A key&apos;s role decides which
        sequences it may run.
      </p>
      {error ? <div className="errorText">{error}</div> : null}
      {loading ? <p className="muted">Loading…</p> : null}

      <h3 className="navSectionHeader">Connection</h3>
      <p className="muted rbacSectionHint">
        Connect an MCP client (Claude, IDE assistants, agents) to this space using the URL
        below plus an agent key in the <code>X-Pona-Flow-Key</code> header. The space&apos;s
        sequences appear as callable tools.
      </p>
      <label className="muted">MCP server URL</label>
      <CopyField value={`${apiOrigin()}/api/spaces/${spaceId}/mcp`} />
      <p className="muted rbacSectionHint">
        Prefer plain HTTP? Call a single sequence as a webhook:
      </p>
      <label className="muted">Webhook (per sequence)</label>
      <CopyField value={`${apiOrigin()}/api/spaces/${spaceId}/sequences/{sequence_id}/run`} />

      <form className="rbacInviteRow" onSubmit={handleCreate}>
        <input
          type="text"
          placeholder="New agent name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <select value={newRoleId} onChange={(e) => setNewRoleId(e.target.value)}>
          <option value="">Default role</option>
          {roles
            .filter((r) => r.name.trim().toLowerCase() !== "admin")
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
        <button className="btnPrimary" type="submit" disabled={!newName.trim()}>
          Create key
        </button>
      </form>

      <h3 className="navSectionHeader">Keys</h3>
      {keys.length === 0 ? (
        <p className="muted">No agent keys yet.</p>
      ) : (
        <ul className="rbacMemberList">
          {keys.map((key) => (
            <li key={key.id} className="rbacMemberRow">
              <div className="rbacMemberHead">
                <div className="rbacMemberId">
                  <span>{key.name}</span>
                  <span className="rbacSubId">
                    created {formatDate(key.creationDate)} · last used {formatDate(key.lastUsedDate)}
                  </span>
                  {key.revoked ? <span className="rbacBadge">revoked</span> : null}
                </div>
                <div className="rbacMemberControls">
                  {!key.revoked ? (
                    <button
                      className="btnDanger"
                      type="button"
                      onClick={() => run(() => revokeAgentKey(spaceId, key.id))}
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="muted">Revoked</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {created ? (
        <AgentKeyCreatedModal
          spaceId={spaceId}
          created={created}
          onClose={() => setCreated(null)}
        />
      ) : null}
    </>
  );
}

function AgentKeyCreatedModal({
  spaceId,
  created,
  onClose
}: {
  spaceId: string;
  created: CreatedAgentKey;
  onClose: () => void;
}) {
  return (
    <ModalBackdrop role="dialog" aria-modal="true">
      <div className="builderModalPanel" data-testid="modal-agent-key">
        <h3>Agent key created</h3>
        <p className="muted">
          Copy this key now — it is shown only once and cannot be retrieved later. If you
          lose it, revoke the key and create a new one.
        </p>
        <CopyField value={created.token} />
        <p className="muted rbacSectionHint">
          Connect an MCP client to <code>{apiOrigin()}/api/spaces/{spaceId}/mcp</code> with
          header <code>X-Pona-Flow-Key</code>, or call a sequence directly at
          <br />
          <code>POST /api/spaces/{spaceId}/sequences/{"{sequence_id}"}/run</code>.
        </p>
        <div className="builderModalActions">
          <button
            type="button"
            className="btnPrimary"
            data-testid="modal-confirm-btn"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
