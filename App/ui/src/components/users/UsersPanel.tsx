import { useCallback, useEffect, useState } from "react";
import {
  deleteRole,
  fetchPrincipals,
  fetchSpaceMembers,
  fetchSpaceRoles,
  inviteMember,
  removeMember,
  updateMember,
  updatePrincipal,
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
      setError(e instanceof Error ? e.message : "Failed to load users");
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
      setError(e instanceof Error ? e.message : "Action failed");
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
        {!embedded ? <h2>Users</h2> : null}
        <p className="muted">Select a space to manage its users.</p>
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
          {!embedded ? <h2>Users</h2> : <h3>Users</h3>}
          {onClose ? (
            <button type="button" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
        {error ? <div className="errorText">{error}</div> : null}
        {loading ? <p className="muted">Loading…</p> : null}

        <form className="rbacInviteRow" onSubmit={handleInvite}>
          <input
            type="email"
            placeholder="Invite by email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <select value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)}>
            <option value="">Default role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="btnPrimary" type="submit" disabled={!inviteEmail.trim()}>
            Invite
          </button>
        </form>

        <h3 className="navSectionHeader">Members</h3>
        {members.length === 0 ? (
          <p className="muted">No members yet.</p>
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

        {isSuperadmin ? (
          <PrincipalsSection
            principals={principals}
            onToggle={(id, can) => run(() => updatePrincipal(id, can))}
          />
        ) : null}
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
      onError(e instanceof Error ? e.message : "Action failed");
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
            <span className="muted rbacOwnerNote">Full access</span>
          ) : (
            <select
              value={member.roleId || ""}
              onChange={(e) =>
                safe(() => updateMember(spaceId, member.id, { roleId: e.target.value || null }))
              }
            >
              <option value="">No role</option>
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
              title={isSoleOwner ? "A space must have at least one owner." : undefined}
              onChange={(e) =>
                safe(() => updateMember(spaceId, member.id, { isOwner: e.target.checked }))
              }
            />
            Owner
          </label>
          {!member.isOwner ? (
            <button type="button" onClick={onToggleExpand}>
              {expanded ? "Hide" : "Permissions"}
            </button>
          ) : null}
          {!isSoleOwner ? (
            <button
              className="btnDanger"
              type="button"
              onClick={() => safe(() => removeMember(spaceId, member.id))}
            >
              Remove
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
              Override role permissions for this member
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
                    Save override
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      safe(() => updateMember(spaceId, member.id, { permissionsOverride: null }))
                    }
                  >
                    Reset to role
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">
                This member uses the role&apos;s permissions. Enable the override to customize.
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
      onError(e instanceof Error ? e.message : "Action failed");
    }
  }

  function startEdit(role: SpaceRole) {
    setEditingId(role.id);
    setDraft(role.permissions);
  }

  return (
    <div className="rbacRolesSection">
      <h3 className="navSectionHeader">Roles</h3>
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
                  {editingId === role.id ? "Hide" : "Edit"}
                </button>
                {!role.isDefault ? (
                  <button
                    className="btnDanger"
                    type="button"
                    onClick={() => safe(() => deleteRole(spaceId, role.id))}
                  >
                    Delete
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
                    Save role
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
          placeholder="New role name"
          value={newRoleName}
          onChange={(e) => setNewRoleName(e.target.value)}
        />
        <button className="btnPrimary" type="submit" disabled={!newRoleName.trim()}>
          Add role
        </button>
      </form>
    </div>
  );
}

function PrincipalsSection({
  principals,
  onToggle
}: {
  principals: PrincipalRow[];
  onToggle: (principalId: string, canCreate: boolean) => void;
}) {
  return (
    <div className="rbacPrincipalsSection">
      <h3 className="navSectionHeader">Instance principals</h3>
      <p className="muted rbacSectionHint">
        Every account that has signed in to this instance. The “superadmin” badge marks
        instance administrators; others are ordinary principals.
      </p>
      {principals.length === 0 ? (
        <p className="muted">No principals found.</p>
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
                <label className="rbacCheckRow">
                  <input
                    type="checkbox"
                    checked={p.canCreateSpaces}
                    disabled={p.isInstanceAdmin}
                    onChange={(e) => onToggle(p.id, e.target.checked)}
                  />
                  Can create spaces
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
