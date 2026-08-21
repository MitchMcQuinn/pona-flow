import { useEffect, useMemo, useRef, useState } from "react";
import type { EventSummary, SequenceSummary } from "../state/types";
import {
  UNGROUPED_LABEL,
  buildNavGroups,
  flattenNavGroups,
  reindexSequences,
  type NavGroup
} from "../state/navOrder";
import {
  browserTimeZone,
  supportedTimeZones,
  timeZoneLabel
} from "../services/timezone";

interface NavigationPanelProps {
  spaces: Array<{ id: string; label: string }>;
  selectedSpaceId: string | null;
  onSelectSpace: (spaceId: string) => void;
  sequences: SequenceSummary[];
  groups: string[];
  selectedSequenceId: string | null;
  loading: boolean;
  error: string | null;
  onSelectSequence: (sequenceId: string) => void;
  onCreateSequence: () => void;
  /** Open the selected sequence in the builder for editing (hydrated from builder_config). */
  onEditSequence: (sequenceId: string) => void;
  /** Delete the selected sequence (routes through the STEP delete cascade + confirm modal). */
  onDeleteSequence: (sequenceId: string) => void;
  onCreateSpace: () => void;
  /** Whether the principal may create spaces (superadmin or granted capability). */
  canCreateSpace: boolean;
  spaceConfigActive: boolean;
  onOpenSpaceConfig: () => void;
  /** Whether the Local LLMs management panel is open. */
  localLlmsActive: boolean;
  onOpenLocalLlms: () => void;
  /** Persist a new sequence ordering / group assignment after a drag. */
  onReorderSequences: (sequences: SequenceSummary[]) => void;
  /** Persist a new ordered group-title list. */
  onReorderGroups: (groups: string[]) => void;
  onAddGroup: (title: string) => void;
  onDeleteGroup: (title: string) => void;
  events: EventSummary[];
  selectedEventId: string | null;
  eventsLoading: boolean;
  eventsError: string | null;
  onSelectEvent: (eventId: string) => void;
  onCreateEvent: () => void;
  onDeleteEvent: (eventId: string) => void;
  /** Display name for the signed-in user (falls back to email inside the footer). */
  userName: string | null;
  userEmail: string | null;
  /** The user's saved IANA timezone, or null when none is set yet. */
  userTimezone: string | null;
  onSaveTimezone: (timezone: string) => void;
  onLogout: () => void;
}

type DropPosition = "before" | "after";

function DeleteIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3 4.5h10M6 4.5V3.5h4v1M5.5 4.5v8h5v-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path
        d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z" />
    </svg>
  );
}

// Six-dot (2 column × 3 row) grip that signifies the item can be dragged.
function DragHandleIcon() {
  return (
    <svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="3" r="1.3" />
      <circle cx="7" cy="3" r="1.3" />
      <circle cx="3" cy="8" r="1.3" />
      <circle cx="7" cy="8" r="1.3" />
      <circle cx="3" cy="13" r="1.3" />
      <circle cx="7" cy="13" r="1.3" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className="navGroupChevron"
    >
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Drag handlers shared by every sequence item / group container / group header.
interface DragApi {
  draggingId: string | null;
  draggingGroup: string | null;
  itemDrop: { id: string; position: DropPosition } | null;
  groupDrop: { title: string; position: DropPosition } | null;
  armItemHandle: () => void;
  armGroupHandle: () => void;
  onItemDragStart: (id: string, e: React.DragEvent) => void;
  onItemDragEnd: () => void;
  onItemDragOver: (id: string, e: React.DragEvent) => void;
  onItemDrop: (id: string, e: React.DragEvent) => void;
  onContainerDragOver: (e: React.DragEvent) => void;
  onContainerDrop: (title: string, e: React.DragEvent) => void;
  onGroupDragStart: (title: string, e: React.DragEvent) => void;
  onGroupDragEnd: () => void;
  onGroupHeaderDragOver: (title: string, expanded: boolean, e: React.DragEvent) => void;
  onGroupHeaderDrop: (title: string, expanded: boolean, e: React.DragEvent) => void;
  headerSequenceDrop: string | null;
}

interface AccordionApi {
  expandedTitle: string | null;
  toggle: (title: string) => void;
  expand: (title: string) => void;
}

function SequenceList({
  groupTitle,
  sequences,
  selectedSequenceId,
  onSelectSequence,
  onEditSequence,
  onDeleteSequence,
  drag
}: {
  groupTitle: string;
  sequences: SequenceSummary[];
  selectedSequenceId: string | null;
  onSelectSequence: (sequenceId: string) => void;
  onEditSequence: (sequenceId: string) => void;
  onDeleteSequence: (sequenceId: string) => void;
  drag: DragApi;
}) {
  return (
    <ul
      className="sequenceList"
      onDragOver={drag.onContainerDragOver}
      onDrop={(e) => drag.onContainerDrop(groupTitle, e)}
    >
      {sequences.map((sequence) => {
        const indicator =
          drag.itemDrop && drag.itemDrop.id === sequence.id ? drag.itemDrop.position : null;
        const classNames = ["sequenceItem"];
        if (sequence.id === selectedSequenceId) classNames.push("active");
        if (sequence.suspended) classNames.push("suspended");
        if (sequence.id === drag.draggingId) classNames.push("dragging");
        if (indicator === "before") classNames.push("dropBefore");
        if (indicator === "after") classNames.push("dropAfter");
        return (
          <li
            key={sequence.id}
            className={classNames.join(" ")}
            data-testid="nav-sequence-item"
            draggable
            onDragStart={(e) => drag.onItemDragStart(sequence.id, e)}
            onDragEnd={drag.onItemDragEnd}
            onDragOver={(e) => drag.onItemDragOver(sequence.id, e)}
            onDrop={(e) => drag.onItemDrop(sequence.id, e)}
          >
            <span
              className="sequenceDragHandle"
              aria-label="Drag to reorder"
              title="Drag to reorder"
              onMouseDown={drag.armItemHandle}
            >
              <DragHandleIcon />
            </span>
            <button
              className="sequenceBtn"
              type="button"
              title={
                sequence.suspended
                  ? "Suspended: a schema change invalidated an INSTANCE step. Re-save the step to restore it."
                  : undefined
              }
              onClick={() => onSelectSequence(sequence.id)}
            >
              <span className="sequenceBtnLabel">{sequence.label}</span>
            </button>
            <span className="inlineActions sequenceItemActions">
              <button
                className="tinyBtn tinyBtnIcon"
                type="button"
                aria-label={`Edit sequence ${sequence.label}`}
                title="Edit sequence"
                onClick={() => onEditSequence(sequence.id)}
              >
                <EditIcon />
              </button>
              <button
                className="tinyBtn tinyBtnIcon danger"
                type="button"
                aria-label={`Delete sequence ${sequence.label}`}
                title="Delete sequence"
                onClick={() => onDeleteSequence(sequence.id)}
              >
                <DeleteIcon />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function GroupBlock({
  group,
  selectedSequenceId,
  onSelectSequence,
  onEditSequence,
  onDeleteSequence,
  onDeleteGroup,
  drag,
  accordion
}: {
  group: NavGroup;
  selectedSequenceId: string | null;
  onSelectSequence: (sequenceId: string) => void;
  onEditSequence: (sequenceId: string) => void;
  onDeleteSequence: (sequenceId: string) => void;
  onDeleteGroup: (title: string) => void;
  drag: DragApi;
  accordion: AccordionApi;
}) {
  const expanded = accordion.expandedTitle === group.title;
  const sequenceList = expanded ? (
    <SequenceList
      groupTitle={group.title}
      sequences={group.sequences}
      selectedSequenceId={selectedSequenceId}
      onSelectSequence={onSelectSequence}
      onEditSequence={onEditSequence}
      onDeleteSequence={onDeleteSequence}
      drag={drag}
    />
  ) : null;

  if (group.ungrouped) {
    const headerClasses = ["navGroupHeader", "navGroupHeaderUngrouped"];
    if (drag.headerSequenceDrop === group.title) headerClasses.push("sequenceDropTarget");

    return (
      <div
        className="navGroup navGroupUngrouped"
        onDragOver={drag.onContainerDragOver}
        onDrop={(e) => drag.onContainerDrop(group.title, e)}
      >
        <div
          className={headerClasses.join(" ")}
          onDragOver={(e) => drag.onGroupHeaderDragOver(group.title, expanded, e)}
          onDrop={(e) => drag.onGroupHeaderDrop(group.title, expanded, e)}
        >
          <button
            type="button"
            className="navGroupToggle"
            aria-expanded={expanded}
            onClick={() => accordion.toggle(group.title)}
          >
            <span className="navGroupToggleLabel">
              <span className="navGroupTitle">{group.title}</span>
              <ChevronIcon />
            </span>
          </button>
        </div>
        {sequenceList}
      </div>
    );
  }

  const indicator =
    drag.groupDrop && drag.groupDrop.title === group.title ? drag.groupDrop.position : null;
  const headerClasses = ["navGroupHeader"];
  if (group.title === drag.draggingGroup) headerClasses.push("dragging");
  if (indicator === "before") headerClasses.push("dropBefore");
  if (indicator === "after") headerClasses.push("dropAfter");
  if (drag.headerSequenceDrop === group.title) headerClasses.push("sequenceDropTarget");

  return (
    <div
      className="navGroup"
      onDragOver={drag.onContainerDragOver}
      onDrop={(e) => drag.onContainerDrop(group.title, e)}
    >
      <div
        className={headerClasses.join(" ")}
        draggable
        onDragStart={(e) => drag.onGroupDragStart(group.title, e)}
        onDragEnd={drag.onGroupDragEnd}
        onDragOver={(e) => drag.onGroupHeaderDragOver(group.title, expanded, e)}
        onDrop={(e) => drag.onGroupHeaderDrop(group.title, expanded, e)}
      >
        <span
          className="navGroupDragHandle"
          aria-label="Drag to reorder group"
          title="Drag to reorder group"
          onMouseDown={drag.armGroupHandle}
        >
          <DragHandleIcon />
        </span>
        <button
          type="button"
          className="navGroupToggle"
          aria-expanded={expanded}
          onClick={() => accordion.toggle(group.title)}
        >
          <span className="navGroupToggleLabel">
            <span className="navGroupTitle">{group.title}</span>
            <ChevronIcon />
          </span>
        </button>
        <button
          type="button"
          className="tinyBtn tinyBtnIcon danger navGroupDeleteBtn"
          aria-label={`Delete group ${group.title}`}
          title="Delete group"
          onClick={() => onDeleteGroup(group.title)}
        >
          <DeleteIcon />
        </button>
      </div>
      {sequenceList}
    </div>
  );
}

function AddGroupControl({
  existingGroups,
  onAddGroup
}: {
  existingGroups: string[];
  onAddGroup: (title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const trimmed = title.trim();
  const duplicate = existingGroups.some((g) => g.toLowerCase() === trimmed.toLowerCase());
  const canSave = trimmed.length > 0 && !duplicate;

  function close() {
    setOpen(false);
    setTitle("");
  }

  function save() {
    if (!canSave) return;
    onAddGroup(trimmed);
    close();
  }

  if (!open) {
    return (
      <button
        type="button"
        className="navAddGroupBtn"
        data-testid="nav-add-group"
        onClick={() => setOpen(true)}
      >
        + New group
      </button>
    );
  }

  return (
    <div className="navAddGroupForm">
      <input
        ref={inputRef}
        value={title}
        placeholder="Group title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") close();
        }}
      />
      <div className="navAddGroupActions">
        <button type="button" className="tinyBtn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="tinyBtn" disabled={!canSave} onClick={save}>
          Add
        </button>
      </div>
      {duplicate ? <span className="errorText">Group already exists.</span> : null}
    </div>
  );
}

function UserSettingsFooter({
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
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayName = userName?.trim() || userEmail?.trim() || "Account";
  const zones = useMemo(() => supportedTimeZones(), []);
  const selectedZone = userTimezone || browserTimeZone();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="navUserSettings" ref={containerRef}>
      {open ? (
        <div className="navUserMenu" role="dialog" aria-label="User settings">
          <div className="navUserMenuHeader">
            <span className="navUserMenuName">{displayName}</span>
            {userEmail && userEmail !== displayName ? (
              <span className="navUserMenuEmail">{userEmail}</span>
            ) : null}
          </div>
          <div className="field navUserMenuField">
            <label htmlFor="user-timezone">Timezone</label>
            <select
              id="user-timezone"
              value={selectedZone}
              onChange={(e) => onSaveTimezone(e.target.value)}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {timeZoneLabel(zone)}
                </option>
              ))}
            </select>
            <span className="navUserMenuHint">Used to show event times in your local time.</span>
          </div>
          <button type="button" className="navUserLogoutBtn" onClick={onLogout}>
            Log out
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className={`navUserButton${open ? " active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="navUserName">{displayName}</span>
        <span className="navUserGear" aria-hidden="true">
          <GearIcon />
        </span>
      </button>
    </div>
  );
}

export function NavigationPanel({
  spaces,
  selectedSpaceId,
  onSelectSpace,
  sequences,
  groups,
  selectedSequenceId,
  loading,
  error,
  onSelectSequence,
  onCreateSequence,
  onEditSequence,
  onDeleteSequence,
  onCreateSpace,
  canCreateSpace,
  spaceConfigActive,
  onOpenSpaceConfig,
  localLlmsActive,
  onOpenLocalLlms,
  onReorderSequences,
  onReorderGroups,
  onAddGroup,
  onDeleteGroup,
  events,
  selectedEventId,
  eventsLoading,
  eventsError,
  onSelectEvent,
  onCreateEvent,
  onDeleteEvent,
  userName,
  userEmail,
  userTimezone,
  onSaveTimezone,
  onLogout
}: NavigationPanelProps) {
  const navSequences = useMemo(
    () => sequences.filter((sequence) => sequence.kind === "sequence"),
    [sequences]
  );
  const navGroups = useMemo(
    () => buildNavGroups(navSequences, groups),
    [navSequences, groups]
  );
  // Display order is the basis for computing a new flat ordering on drop.
  const orderedNav = useMemo(() => flattenNavGroups(navGroups), [navGroups]);

  const [expandedGroupTitle, setExpandedGroupTitle] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [itemDrop, setItemDrop] = useState<{ id: string; position: DropPosition } | null>(null);
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const [groupDrop, setGroupDrop] = useState<{ title: string; position: DropPosition } | null>(null);
  const [headerSequenceDrop, setHeaderSequenceDrop] = useState<string | null>(null);
  // Restrict drag initiation to the six-dot handles.
  const itemArmed = useRef(false);
  const groupArmed = useRef(false);

  useEffect(() => {
    if (!selectedSequenceId) return;
    const seq = navSequences.find((s) => s.id === selectedSequenceId);
    if (!seq) return;
    setExpandedGroupTitle(seq.groupTitle?.trim() || UNGROUPED_LABEL);
  }, [selectedSequenceId, navSequences]);

  useEffect(() => {
    if (expandedGroupTitle !== null || navGroups.length === 0 || selectedSequenceId) return;
    setExpandedGroupTitle(navGroups[0].title);
  }, [navGroups, selectedSequenceId, expandedGroupTitle]);

  useEffect(() => {
    if (expandedGroupTitle === null) return;
    if (navGroups.some((g) => g.title === expandedGroupTitle)) return;
    setExpandedGroupTitle(navGroups[0]?.title ?? null);
  }, [navGroups, expandedGroupTitle]);

  // A handle press that never becomes a drag (a plain click) is disarmed on mouseup.
  useEffect(() => {
    function disarm() {
      itemArmed.current = false;
      groupArmed.current = false;
    }
    window.addEventListener("mouseup", disarm);
    return () => window.removeEventListener("mouseup", disarm);
  }, []);

  function resetItemDrag() {
    itemArmed.current = false;
    setDraggingId(null);
    setItemDrop(null);
    setHeaderSequenceDrop(null);
  }

  function resetGroupDrag() {
    groupArmed.current = false;
    setDraggingGroup(null);
    setGroupDrop(null);
  }

  function commitSequences(next: SequenceSummary[]) {
    onReorderSequences(reindexSequences(next));
  }

  function dropOnItem(targetId: string, position: DropPosition) {
    if (!draggingId || draggingId === targetId) return;
    const dragging = orderedNav.find((s) => s.id === draggingId);
    if (!dragging) return;
    const rest = orderedNav.filter((s) => s.id !== draggingId);
    const targetIdx = rest.findIndex((s) => s.id === targetId);
    if (targetIdx === -1) return;
    const newGroup = rest[targetIdx].groupTitle ?? null;
    const insertIdx = position === "after" ? targetIdx + 1 : targetIdx;
    const moved: SequenceSummary = { ...dragging, groupTitle: newGroup };
    commitSequences([...rest.slice(0, insertIdx), moved, ...rest.slice(insertIdx)]);
  }

  function findGroupInsertIndex(
    rest: SequenceSummary[],
    groupTitle: string,
    atTop: boolean
  ): number {
    const newGroup = groupTitle === UNGROUPED_LABEL ? null : groupTitle;
    const firstInGroup = rest.findIndex((s) => (s.groupTitle ?? null) === newGroup);
    if (atTop) {
      if (firstInGroup !== -1) return firstInGroup;
      const groupIdx = navGroups.findIndex((g) => g.title === groupTitle);
      if (groupIdx === -1) return rest.length;
      for (let i = groupIdx + 1; i < navGroups.length; i++) {
        const ng = navGroups[i].title === UNGROUPED_LABEL ? null : navGroups[i].title;
        const nextIdx = rest.findIndex((s) => (s.groupTitle ?? null) === ng);
        if (nextIdx !== -1) return nextIdx;
      }
      return rest.length;
    }
    let insertIdx = rest.length;
    rest.forEach((s, i) => {
      if ((s.groupTitle ?? null) === newGroup) insertIdx = i + 1;
    });
    return insertIdx;
  }

  function dropOnGroupContainer(groupTitle: string, atTop = false) {
    if (!draggingId) return;
    const dragging = orderedNav.find((s) => s.id === draggingId);
    if (!dragging) return;
    const newGroup = groupTitle === UNGROUPED_LABEL ? null : groupTitle;
    const rest = orderedNav.filter((s) => s.id !== draggingId);
    const insertIdx = findGroupInsertIndex(rest, groupTitle, atTop);
    const moved: SequenceSummary = { ...dragging, groupTitle: newGroup };
    commitSequences([...rest.slice(0, insertIdx), moved, ...rest.slice(insertIdx)]);
  }

  function reorderGroupTo(targetTitle: string, position: DropPosition) {
    if (!draggingGroup || draggingGroup === targetTitle) return;
    const base = groups.map((g) => g.trim()).filter((g) => g && g !== draggingGroup);
    const targetIdx = base.indexOf(targetTitle);
    if (targetIdx === -1) return;
    const insertIdx = position === "after" ? targetIdx + 1 : targetIdx;
    const next = [...base.slice(0, insertIdx), draggingGroup, ...base.slice(insertIdx)];
    onReorderGroups(next);
  }

  function verticalPosition(e: React.DragEvent): DropPosition {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2 ? "after" : "before";
  }

  function dropSequenceOnCollapsedGroup(groupTitle: string) {
    dropOnGroupContainer(groupTitle, true);
    setExpandedGroupTitle(groupTitle);
    resetItemDrag();
  }

  const accordion: AccordionApi = {
    expandedTitle: expandedGroupTitle,
    toggle: (title) => {
      setExpandedGroupTitle((current) => (current === title ? null : title));
    },
    expand: (title) => setExpandedGroupTitle(title)
  };

  const drag: DragApi = {
    draggingId,
    draggingGroup,
    itemDrop,
    groupDrop,
    headerSequenceDrop,
    armItemHandle: () => {
      itemArmed.current = true;
    },
    armGroupHandle: () => {
      groupArmed.current = true;
    },
    onItemDragStart: (id, e) => {
      if (!itemArmed.current) {
        e.preventDefault();
        return;
      }
      setDraggingId(id);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    },
    onItemDragEnd: resetItemDrag,
    onItemDragOver: (id, e) => {
      if (!draggingId || draggingId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setItemDrop({ id, position: verticalPosition(e) });
    },
    onItemDrop: (id, e) => {
      e.preventDefault();
      e.stopPropagation();
      dropOnItem(id, verticalPosition(e));
      resetItemDrag();
    },
    onContainerDragOver: (e) => {
      if (!draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onContainerDrop: (title, e) => {
      if (!draggingId) return;
      e.preventDefault();
      const collapsed = expandedGroupTitle !== title;
      dropOnGroupContainer(title, collapsed);
      if (collapsed) setExpandedGroupTitle(title);
      resetItemDrag();
    },
    onGroupDragStart: (title, e) => {
      if (!groupArmed.current) {
        e.preventDefault();
        return;
      }
      setDraggingGroup(title);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", title);
    },
    onGroupDragEnd: resetGroupDrag,
    onGroupHeaderDragOver: (title, expanded, e) => {
      if (draggingGroup && draggingGroup !== title) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setGroupDrop({ title, position: verticalPosition(e) });
        return;
      }
      if (draggingId && !expanded) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setHeaderSequenceDrop(title);
      }
    },
    onGroupHeaderDrop: (title, expanded, e) => {
      if (draggingGroup) {
        e.preventDefault();
        e.stopPropagation();
        reorderGroupTo(title, verticalPosition(e));
        resetGroupDrag();
        return;
      }
      if (draggingId && !expanded) {
        e.preventDefault();
        e.stopPropagation();
        dropSequenceOnCollapsedGroup(title);
      }
    }
  };

  const onlyUngrouped = navGroups.length === 1 && navGroups[0].ungrouped;

  return (
    <div className="panel navPanel">
      <div className="panel__body">
        <h2>Navigation</h2>
        <div className="navSectionHeader">
          <h3 className="navSectionTitle" id="space-selector-label">
            Space
          </h3>
          {canCreateSpace ? (
            <button
              type="button"
              className="navAddBtn"
              aria-label="Create space"
              data-testid="nav-create-space"
              onClick={onCreateSpace}
            >
              +
            </button>
          ) : null}
        </div>
        <div className="navSpaceRow">
          <select
            id="space-selector"
            aria-labelledby="space-selector-label"
            value={selectedSpaceId || ""}
            onChange={(event) => onSelectSpace(event.target.value)}
          >
            <option value="" disabled>
              Select a space
            </option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.label}
              </option>
            ))}
          </select>
          <span className="inlineActions navSpaceActions">
            <button
              type="button"
              className={`tinyBtn tinyBtnIcon navSpaceConfigBtn${spaceConfigActive ? " active" : ""}`}
              aria-label="Open space settings"
              title="Space settings"
              data-testid="nav-space-settings"
              disabled={!selectedSpaceId}
              onClick={onOpenSpaceConfig}
            >
              <GearIcon />
            </button>
          </span>
        </div>

        <div className="navSectionHeader">
          <h3 className="navSectionTitle">Sequences</h3>
          <button
            type="button"
            className="navAddBtn"
            aria-label="Add sequence"
            data-testid="nav-add-sequence"
            onClick={onCreateSequence}
          >
            +
          </button>
        </div>

        {loading ? <p className="muted">Loading sequences...</p> : null}
        {error ? <p className="errorText">{error}</p> : null}

        {!loading && !error ? (
          <>
            {navGroups.length === 0 ? (
              <p className="muted">No sequences yet.</p>
            ) : onlyUngrouped ? (
              <SequenceList
                groupTitle={UNGROUPED_LABEL}
                sequences={navGroups[0].sequences}
                selectedSequenceId={selectedSequenceId}
                onSelectSequence={onSelectSequence}
                onEditSequence={onEditSequence}
                onDeleteSequence={onDeleteSequence}
                drag={drag}
              />
            ) : (
              <div className="navGroupList">
                {navGroups.map((group) => (
                  <GroupBlock
                    key={group.title}
                    group={group}
                    selectedSequenceId={selectedSequenceId}
                    onSelectSequence={onSelectSequence}
                    onEditSequence={onEditSequence}
                    onDeleteSequence={onDeleteSequence}
                    onDeleteGroup={onDeleteGroup}
                    drag={drag}
                    accordion={accordion}
                  />
                ))}
              </div>
            )}

            <AddGroupControl existingGroups={groups} onAddGroup={onAddGroup} />
          </>
        ) : null}

        <div className="navSectionHeader">
          <h3 className="navSectionTitle">Local LLMs</h3>
        </div>
        <ul className="sequenceList">
          <li className={`sequenceItem${localLlmsActive ? " active" : ""}`}>
            <button
              type="button"
              className="sequenceBtn"
              disabled={!selectedSpaceId}
              onClick={onOpenLocalLlms}
              data-testid="nav-local-llms"
            >
              <span className="sequenceBtnLabel">Manage configs</span>
            </button>
          </li>
        </ul>

        <div className="navSectionHeader">
          <h3 className="navSectionTitle">Events</h3>
          <button
            type="button"
            className="navAddBtn"
            aria-label="Add event"
            data-testid="nav-add-event"
            onClick={onCreateEvent}
          >
            +
          </button>
        </div>

        {eventsLoading ? <p className="muted">Loading events...</p> : null}
        {eventsError ? <p className="errorText">{eventsError}</p> : null}

        {!eventsLoading && !eventsError ? (
          events.length === 0 ? (
            <p className="muted">No events yet.</p>
          ) : (
            <ul className="sequenceList">
              {events.map((trigger) => {
                const classNames = ["sequenceItem"];
                if (trigger.id === selectedEventId) classNames.push("active");
                return (
                  <li key={trigger.id} className={classNames.join(" ")} data-testid="nav-event-item">
                    <button
                      className="sequenceBtn"
                      type="button"
                      onClick={() => onSelectEvent(trigger.id)}
                    >
                      <span className="sequenceBtnLabel">{trigger.name}</span>
                    </button>
                    <span className="inlineActions">
                      <button
                        className="tinyBtn tinyBtnIcon danger"
                        type="button"
                        aria-label={`Delete event ${trigger.name}`}
                        title="Delete event"
                        onClick={() => onDeleteEvent(trigger.id)}
                      >
                        <DeleteIcon />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}

      </div>
      <UserSettingsFooter
        userName={userName}
        userEmail={userEmail}
        userTimezone={userTimezone}
        onSaveTimezone={onSaveTimezone}
        onLogout={onLogout}
      />
    </div>
  );
}
