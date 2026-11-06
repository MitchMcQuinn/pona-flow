import { useCallback, useEffect, useState } from "react";
import {
  deleteRole,
  fetchPrincipals,
  fetchSpaceMembers,
  fetchSpaceRoles,
  inviteMember,
  removeMember,
  updateMember,
  upsertRole,
  type PrincipalRow,
  type RolePermissions,
  type SpaceMember,
  type SpaceRole
} from "../../services/api";
import type { Me, SequenceSummary } from "../../state/types";
import { emptyPermissions, PermissionMatrix } from "./PermissionMatrix";

interface UsersPanelProps {
  spaceId: string | null;
  me: Me | null;
  sequences: SequenceSummary[];
  onClose?: () => void;
  embedded?: boolean;
}

export function UsersPanel({ spaceId, me, sequences, onClose, embedded = false }: UsersPanelProps) {
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [roles, setRoles] = useState<SpaceRole[]>([]);
  const [principals, setPrincipals] = useState<PrincipalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);

  const isSuperadmin = Boolean(me?.isSuperadmin);

  const reload = useCallback(async () => {
    if (!spaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [m, r] = await Promise.all([fetchSpaceMembers(spaceId), fetchSpaceRoles(spaceId)]);
      setMembers(m);
      setRoles(r);
      if (isSuperadmin) {
        try {
          setPrincipals(await fetchPrincipals());
        } catch {
          setPrincipals([]);
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "failed to load users");
    } finally {
      setLoading(false);
    }
  }, [spaceId, isSuperadmin]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<void>) {
    try {
      await action();
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "action failed");
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!spaceId || !inviteEmail.trim()) return;
    await run(async () => {
      await inviteMember(spaceId, inviteEmail.trim(), inviteRoleId || null);
      setInviteEmail("");
      setInviteRoleId("");
    });
  }

  if (!spaceId) {
    const body = (
      <>
        {!embedded ? <h1>users</h1> : null}
        <p className="muted">select a space to manage its users.</p>
      </>
    );
    return embedded ? (
      <>{body}</>
    ) : (
      <div className="panel configPanel">
        <div className="panel__body">
          {body}
        </div>
      </div>
    );
  }

  const ownerCount = members.filter((m) => m.isOwner).length;

  const content = (
    <>
        <div className="rbacHeaderRow">
          {!embedded ? <h1>users</h1> : <h2>users</h2>}
          {onClose ? (
            <button type="button" onClick={onClose}>
              close
            </button>
          ) : null}
        </div>
        {error ? <div className="errorText">{error}</div> : null}
        {loading ? <p className="muted">loading…</p> : null}

        <form className="rbacInviteRow" onSubmit={handleInvite}>
          <input
            type="email"
            placeholder="invite by email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <select value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)}>
            <option value="">default role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="btnPrimary" type="submit" disabled={!inviteEmail.trim()}>
            invite
          </button>
        </form>

        <h2 className="navSectionHeader">members</h2>
        {members.length === 0 ? (
          <p className="muted">no members yet.</p>
        ) : (
          <ul className="rbacMemberList">
            {members.map((member) => (
              <MemberRow
                key={member.id}
                spaceId={spaceId}
                member={member}
                roles={roles}
                sequences={sequences}
                isSoleOwner={member.isOwner && ownerCount === 1}
                expanded={expandedMemberId === member.id}
                onToggleExpand={() =>
                  setExpandedMemberId(expandedMemberId === member.id ? null : member.id)
                }
                onChanged={reload}
                onError={setError}
              />
            ))}
          </ul>
        )}

        <RolesSection
          spaceId={spaceId}
          roles={roles}
          sequences={sequences}
          onChanged={reload}
          onError={setError}
        />

        {isSuperadmin ? <PrincipalsSection principals={principals} /> : null}
      </>
  );

  return embedded ? (
    <>{content}</>
  ) : (
    <div className="panel configPanel">
      <div className="panel__body">
        {content}
      </div>
    </div>
  );
}

function MemberRow({
  spaceId,
  member,
  roles,
  sequences,
  isSoleOwner,
  expanded,
  onToggleExpand,
  onChanged,
  onError
}: {
  spaceId: string;
  member: SpaceMember;
  roles: SpaceRole[];
  sequences: SequenceSummary[];
  isSoleOwner: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [draftOverride, setDraftOverride] = useState<RolePermissions | null>(
    member.permissionsOverride
  );

  useEffect(() => {
    setDraftOverride(member.permissionsOverride);
  }, [member.permissionsOverride]);

  async function safe(action: () => Promise<void>) {
    try {
      await action();
      await onChanged();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : "action failed");
    }
  }

  const overrideActive = draftOverride !== null;

  return (
    <li className="rbacMemberRow">
      <div className="rbacMemberHead">
        <div className="rbacMemberId">
          <span>{member.name || member.email || member.principalId || "(unknown)"}</span>
          {member.name && member.email ? (
            <span className="rbacSubId">{member.email}</span>
          ) : null}
          {member.status === "pending" ? <span className="rbacBadge">pending</span> : null}
          {member.isOwner ? <span className="rbacBadge rbacBadgeOwner">owner</span> : null}
        </div>
        <div className="rbacMemberControls">
          {member.isOwner ? (
            <span className="muted rbacOwnerNote">full access</span>
          ) : (
            <select
              value={member.roleId || ""}
              onChange={(e) =>
                safe(() => updateMember(spaceId, member.id, { roleId: e.target.value || null }))
              }
            >
              <option value="">no role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <label className="rbacCheckRow">
            <input
              type="checkbox"
              checked={member.isOwner}
              disabled={isSoleOwner}
              title={isSoleOwner ? "a space must have at least one owner." : undefined}
              onChange={(e) =>
                safe(() => updateMember(spaceId, member.id, { isOwner: e.target.checked }))
              }
            />
            owner
          </label>
          {!member.isOwner ? (
            <button type="button" onClick={onToggleExpand}>
              {expanded ? "hide" : "permissions"}
            </button>
          ) : null}
          {!isSoleOwner ? (
            <button
              className="btnDanger"
              type="button"
              onClick={() => safe(() => removeMember(spaceId, member.id))}
            >
              remove
            </button>
          ) : null}
        </div>
      </div>
      {expanded && !member.isOwner ? (
          <div className="rbacMemberDetail">
            <label className="rbacCheckRow">
              <input
                type="checkbox"
                checked={overrideActive}
                onChange={(e) =>
                  setDraftOverride(e.target.checked ? emptyPermissions() : null)
                }
              />
              override role permissions for this member
            </label>
            {overrideActive && draftOverride ? (
              <>
                <PermissionMatrix
                  value={draftOverride}
                  sequences={sequences}
                  onChange={setDraftOverride}
                />
                <div className="buttonRow">
                  <button
                    className="btnPrimary"
                    type="button"
                    onClick={() =>
                      safe(() =>
                        updateMember(spaceId, member.id, { permissionsOverride: draftOverride })
                      )
                    }
                  >
                    save override
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      safe(() => updateMember(spaceId, member.id, { permissionsOverride: null }))
                    }
                  >
                    reset to role
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">
                this member uses the role&apos;s permissions. enable the override to customize.
              </p>
            )}
          </div>
      ) : null}
    </li>
  );
}

function RolesSection({
  spaceId,
  roles,
  sequences,
  onChanged,
  onError
}: {
  spaceId: string;
  roles: SpaceRole[];
  sequences: SequenceSummary[];
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RolePermissions>(emptyPermissions());
  const [newRoleName, setNewRoleName] = useState("");

  async function safe(action: () => Promise<void>) {
    try {
      await action();
      await onChanged();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : "action failed");
    }
  }

  function startEdit(role: SpaceRole) {
    setEditingId(role.id);
    setDraft(role.permissions);
  }

  return (
    <div className="rbacRolesSection">
      <h2 className="navSectionHeader">roles</h2>
      <ul className="rbacMemberList">
        {roles
          .filter((role) => role.name.trim().toLowerCase() !== "admin")
          .map((role) => (
          <li key={role.id} className="rbacMemberRow">
            <div className="rbacMemberHead">
              <div className="rbacMemberId">
                <span>{role.name}</span>
                {role.isDefault ? <span className="rbacBadge">default</span> : null}
              </div>
              <div className="rbacMemberControls">
                <button
                  type="button"
                  onClick={() => (editingId === role.id ? setEditingId(null) : startEdit(role))}
                >
                  {editingId === role.id ? "hide" : "edit"}
                </button>
                {!role.isDefault ? (
                  <button
                    className="btnDanger"
                    type="button"
                    onClick={() => safe(() => deleteRole(spaceId, role.id))}
                  >
                    delete
                  </button>
                ) : null}
              </div>
            </div>
            {editingId === role.id ? (
              <div className="rbacMemberDetail">
                <PermissionMatrix value={draft} sequences={sequences} onChange={setDraft} />
                <div className="buttonRow">
                  <button
                    className="btnPrimary"
                    type="button"
                    onClick={() =>
                      safe(async () => {
                        await upsertRole(spaceId, role.name, draft, role.id);
                        setEditingId(null);
                      })
                    }
                  >
                    save role
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <form
        className="rbacInviteRow"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newRoleName.trim()) return;
          void safe(async () => {
            await upsertRole(spaceId, newRoleName.trim(), emptyPermissions());
            setNewRoleName("");
          });
        }}
      >
        <input
          type="text"
          placeholder="new role name"
          value={newRoleName}
          onChange={(e) => setNewRoleName(e.target.value)}
        />
        <button className="btnPrimary" type="submit" disabled={!newRoleName.trim()}>
          add role
        </button>
      </form>
    </div>
  );
}

function PrincipalsSection({ principals }: { principals: PrincipalRow[] }) {
  return (
    <div className="rbacPrincipalsSection">
      <h2 className="navSectionHeader">instance principals</h2>
      <p className="muted rbacSectionHint">
        every account that has signed in to this instance. the “superadmin” badge marks
        instance administrators; others are ordinary principals.
      </p>
      {principals.length === 0 ? (
        <p className="muted">no principals found.</p>
      ) : (
        <ul className="rbacMemberList">
          {principals.map((p) => (
            <li key={p.id} className="rbacMemberRow">
              <div className="rbacMemberHead">
                <div className="rbacMemberId">
                  <span>{p.name || p.email || p.id}</span>
                  {p.name && p.email ? <span className="rbacSubId">{p.email}</span> : null}
                  {p.isInstanceAdmin ? (
                    <span className="rbacBadge rbacBadgeOwner">superadmin</span>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
