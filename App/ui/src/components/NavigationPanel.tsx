import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { EventSummary, SequenceSummary } from "../state/types";
import {
  UNGROUPED_LABEL,
  buildNavGroups,
  isSingleStepSequence,
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
  /** When true, named groups with no sequences are omitted from the nav. */
  hideEmptySequenceGroups?: boolean;
  selectedSequenceId: string | null;
  loading: boolean;
  error: string | null;
  onSelectSequence: (sequenceId: string) => void;
  onCreateSequence: () => void;
  /** Open the selected sequence in the builder for editing (hydrated from builder_config). */
  onEditSequence: (sequenceId: string) => void;
  /** Delete the selected sequence (nav-only removal, or STEP cascade when the entry STEP exists). */
  onDeleteSequence: (sequenceId: string) => void;
  onCreateSpace: () => void;
  /** Whether the principal may create spaces (superadmin or granted capability). */
  canCreateSpace: boolean;
  spaceConfigActive: boolean;
  onOpenSpaceConfig: () => void;
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
type NavSection = "multi" | "single";

function accordionKey(section: NavSection, title: string): string {
  return `${section}::${title}`;
}

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
  onContainerDragOver: (section: NavSection, e: React.DragEvent) => void;
  onContainerDrop: (title: string, section: NavSection, e: React.DragEvent) => void;
  onGroupDragStart: (title: string, e: React.DragEvent) => void;
  onGroupDragEnd: () => void;
  onGroupHeaderDragOver: (title: string, section: NavSection, expanded: boolean, e: React.DragEvent) => void;
  onGroupHeaderDrop: (title: string, section: NavSection, expanded: boolean, e: React.DragEvent) => void;
  headerSequenceDrop: string | null;
}

interface AccordionApi {
  expandedTitle: string | null;
  toggle: (title: string) => void;
  expand: (title: string) => void;
}

const SEQUENCE_TOOLTIP_DELAY_MS = 200;
const SEQUENCE_TOOLTIP_GAP = 8;
const SEQUENCE_TOOLTIP_MAX_WIDTH = 280;

function SequenceNameTooltip({
  label,
  anchorRef
}: {
  label: string;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const tipRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    top: 0,
    left: 0,
    maxWidth: SEQUENCE_TOOLTIP_MAX_WIDTH,
    zIndex: 1100
  });

  useLayoutEffect(() => {
    function position() {
      const anchor = anchorRef.current;
      const tip = tipRef.current;
      if (!anchor || !tip) return;
      const rect = anchor.getBoundingClientRect();
      const tipH = tip.offsetHeight;
      const tipW = tip.offsetWidth;
      let left = rect.right + SEQUENCE_TOOLTIP_GAP;
      if (left + tipW > window.innerWidth - SEQUENCE_TOOLTIP_GAP) {
        left = Math.max(SEQUENCE_TOOLTIP_GAP, rect.left - tipW - SEQUENCE_TOOLTIP_GAP);
      }
      let top = rect.top + (rect.height - tipH) / 2;
      if (top < SEQUENCE_TOOLTIP_GAP) top = SEQUENCE_TOOLTIP_GAP;
      if (top + tipH > window.innerHeight - SEQUENCE_TOOLTIP_GAP) {
        top = window.innerHeight - tipH - SEQUENCE_TOOLTIP_GAP;
      }
      setStyle({
        position: "fixed",
        top,
        left,
        maxWidth: SEQUENCE_TOOLTIP_MAX_WIDTH,
        zIndex: 1100
      });
      setReady(true);
    }

    position();
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [anchorRef, label]);

  return createPortal(
    <div
      ref={tipRef}
      className={`sequenceLabelTooltip${ready ? " isVisible" : ""}`}
      role="tooltip"
      data-testid="nav-sequence-tooltip"
      style={style}
    >
      {label}
    </div>,
    document.body
  );
}

function SequenceItem({
  sequence,
  selected,
  onSelectSequence,
  onEditSequence,
  onDeleteSequence,
  drag
}: {
  sequence: SequenceSummary;
  selected: boolean;
  onSelectSequence: (sequenceId: string) => void;
  onEditSequence: (sequenceId: string) => void;
  onDeleteSequence: (sequenceId: string) => void;
  drag: DragApi;
}) {
  const itemRef = useRef<HTMLLIElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = labelRef.current;
    if (!el) return;
    const update = () => {
      setTruncated(el.scrollWidth - el.clientWidth > 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sequence.label]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    };
  }, []);

  function onItemEnter() {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(true), SEQUENCE_TOOLTIP_DELAY_MS);
  }

  function onItemLeave() {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHovered(false);
  }

  const indicator = drag.itemDrop && drag.itemDrop.id === sequence.id ? drag.itemDrop.position : null;
  const classNames = ["sequenceItem"];
  if (selected) classNames.push("active");
  if (sequence.suspended) classNames.push("suspended");
  if (sequence.orphaned) classNames.push("orphaned");
  if (sequence.id === drag.draggingId) classNames.push("dragging");
  if (indicator === "before") classNames.push("dropBefore");
  if (indicator === "after") classNames.push("dropAfter");

  const warning = sequence.orphaned
    ? "Orphaned: the entry STEP is missing from the graph. Remove this sequence from the navigation or recreate its step."
    : sequence.suspended
      ? "Suspended: a schema change invalidated an INSTANCE step. Re-save the step to restore it."
      : null;
  const showTooltip =
    hovered && sequence.id !== drag.draggingId && (Boolean(warning) || truncated);
  const tooltipLabel = warning || sequence.label;

  return (
    <li
      ref={itemRef}
      className={classNames.join(" ")}
      data-testid="nav-sequence-item"
      data-single-step={sequence.singleStep ? "true" : "false"}
      data-orphaned={sequence.orphaned ? "true" : "false"}
      data-suspended={sequence.suspended ? "true" : "false"}
      title={warning ?? undefined}
      draggable
      onMouseEnter={onItemEnter}
      onMouseLeave={onItemLeave}
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
          sequence.orphaned
            ? "Orphaned: the entry STEP is missing from the graph. Remove this sequence from the navigation or recreate its step."
            : sequence.suspended
              ? "Suspended: a schema change invalidated an INSTANCE step. Re-save the step to restore it."
              : undefined
        }
        onClick={() => onSelectSequence(sequence.id)}
      >
        <span className="sequenceBtnLabel" ref={labelRef}>
          {sequence.label}
        </span>
      </button>
      <span className="inlineActions sequenceItemActions">
        <button
          className="tinyBtn tinyBtnIcon"
          type="button"
          aria-label={
            sequence.singleStep
              ? `Edit operation ${sequence.label}`
              : `Edit sequence ${sequence.label}`
          }
          title={sequence.singleStep ? "Edit operation" : "Edit sequence"}
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
      {showTooltip ? <SequenceNameTooltip label={tooltipLabel} anchorRef={itemRef} /> : null}
    </li>
  );
}

function SequenceList({
  groupTitle,
  section,
  sequences,
  selectedSequenceId,
  onSelectSequence,
  onEditSequence,
  onDeleteSequence,
  drag
}: {
  groupTitle: string;
  section: NavSection;
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
      onDragOver={(e) => drag.onContainerDragOver(section, e)}
      onDrop={(e) => drag.onContainerDrop(groupTitle, section, e)}
    >
      {sequences.map((sequence) => (
        <SequenceItem
          key={sequence.id}
          sequence={sequence}
          selected={sequence.id === selectedSequenceId}
          onSelectSequence={onSelectSequence}
          onEditSequence={onEditSequence}
          onDeleteSequence={onDeleteSequence}
          drag={drag}
        />
      ))}
    </ul>
  );
}

function GroupBlock({
  group,
  section,
  selectedSequenceId,
  onSelectSequence,
  onEditSequence,
  onDeleteSequence,
  onDeleteGroup,
  drag,
  accordion
}: {
  group: NavGroup;
  section: NavSection;
  selectedSequenceId: string | null;
  onSelectSequence: (sequenceId: string) => void;
  onEditSequence: (sequenceId: string) => void;
  onDeleteSequence: (sequenceId: string) => void;
  onDeleteGroup: (title: string) => void;
  drag: DragApi;
  accordion: AccordionApi;
}) {
  const groupKey = accordionKey(section, group.title);
  const expanded = accordion.expandedTitle === groupKey;
  const sequenceList = expanded ? (
    <SequenceList
      groupTitle={group.title}
      section={section}
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
    if (drag.headerSequenceDrop === groupKey) headerClasses.push("sequenceDropTarget");

    return (
      <div
        className="navGroup navGroupUngrouped"
        onDragOver={(e) => drag.onContainerDragOver(section, e)}
        onDrop={(e) => drag.onContainerDrop(group.title, section, e)}
      >
        <div
          className={headerClasses.join(" ")}
          onDragOver={(e) => drag.onGroupHeaderDragOver(group.title, section, expanded, e)}
          onDrop={(e) => drag.onGroupHeaderDrop(group.title, section, expanded, e)}
        >
          <button
            type="button"
            className="navGroupToggle"
            aria-expanded={expanded}
            onClick={() => accordion.toggle(groupKey)}
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
  if (drag.headerSequenceDrop === groupKey) headerClasses.push("sequenceDropTarget");

  return (
    <div
      className="navGroup"
      onDragOver={(e) => drag.onContainerDragOver(section, e)}
      onDrop={(e) => drag.onContainerDrop(group.title, section, e)}
    >
      <div
        className={headerClasses.join(" ")}
        draggable
        onDragStart={(e) => drag.onGroupDragStart(group.title, e)}
        onDragEnd={drag.onGroupDragEnd}
        onDragOver={(e) => drag.onGroupHeaderDragOver(group.title, section, expanded, e)}
        onDrop={(e) => drag.onGroupHeaderDrop(group.title, section, expanded, e)}
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
          onClick={() => accordion.toggle(groupKey)}
        >
          <span className="navGroupToggleLabel">
            <span className="navGroupTitle">{group.title}</span>
            <ChevronIcon />
          </span>
        </button>
        {section === "multi" ? (
          <button
            type="button"
            className="tinyBtn tinyBtnIcon danger navGroupDeleteBtn"
            aria-label={`Delete group ${group.title}`}
            title="Delete group"
            onClick={() => onDeleteGroup(group.title)}
          >
            <DeleteIcon />
          </button>
        ) : null}
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
  hideEmptySequenceGroups = false,
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
  const multiStepSequences = useMemo(
    () => navSequences.filter((sequence) => !isSingleStepSequence(sequence)),
    [navSequences]
  );
  const singleStepSequences = useMemo(
    () => navSequences.filter((sequence) => isSingleStepSequence(sequence)),
    [navSequences]
  );
  const builtMultiStepGroups = useMemo(
    () => buildNavGroups(multiStepSequences, groups),
    [multiStepSequences, groups]
  );
  const singleStepGroups = useMemo(
    () => buildNavGroups(singleStepSequences, groups).filter((group) => group.sequences.length > 0),
    [singleStepSequences, groups]
  );

  const [expandedGroupTitle, setExpandedGroupTitle] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [itemDrop, setItemDrop] = useState<{ id: string; position: DropPosition } | null>(null);
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const [groupDrop, setGroupDrop] = useState<{ title: string; position: DropPosition } | null>(null);
  const [headerSequenceDrop, setHeaderSequenceDrop] = useState<string | null>(null);
  const [pinnedEmptyGroups, setPinnedEmptyGroups] = useState<string[]>([]);
  // Restrict drag initiation to the six-dot handles.
  const itemArmed = useRef(false);
  const groupArmed = useRef(false);

  useEffect(() => {
    setPinnedEmptyGroups([]);
  }, [selectedSpaceId]);

  const multiStepGroups = useMemo(() => {
    if (!hideEmptySequenceGroups || draggingId) return builtMultiStepGroups;
    const pinned = new Set(pinnedEmptyGroups);
    return builtMultiStepGroups.filter(
      (group) => group.ungrouped || group.sequences.length > 0 || pinned.has(group.title)
    );
  }, [builtMultiStepGroups, hideEmptySequenceGroups, draggingId, pinnedEmptyGroups]);

  const allAccordionKeys = useMemo(
    () => [
      ...multiStepGroups.map((group) => accordionKey("multi", group.title)),
      ...singleStepGroups.map((group) => accordionKey("single", group.title))
    ],
    [multiStepGroups, singleStepGroups]
  );

  useEffect(() => {
    if (!selectedSequenceId) return;
    const seq = navSequences.find((s) => s.id === selectedSequenceId);
    if (!seq) return;
    const section: NavSection = isSingleStepSequence(seq) ? "single" : "multi";
    setExpandedGroupTitle(accordionKey(section, seq.groupTitle?.trim() || UNGROUPED_LABEL));
  }, [selectedSequenceId, navSequences]);

  useEffect(() => {
    if (expandedGroupTitle !== null || allAccordionKeys.length === 0 || selectedSequenceId) return;
    setExpandedGroupTitle(allAccordionKeys[0]);
  }, [allAccordionKeys, selectedSequenceId, expandedGroupTitle]);

  useEffect(() => {
    if (expandedGroupTitle === null) return;
    if (allAccordionKeys.includes(expandedGroupTitle)) return;
    setExpandedGroupTitle(allAccordionKeys[0] ?? null);
  }, [allAccordionKeys, expandedGroupTitle]);

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

  function commitSection(section: NavSection, nextInSection: SequenceSummary[]) {
    const multi = section === "multi" ? nextInSection : multiStepSequences;
    const single = section === "single" ? nextInSection : singleStepSequences;
    onReorderSequences(reindexSequences([...multi, ...single]));
  }

  function sectionOf(id: string): NavSection | null {
    const seq = navSequences.find((s) => s.id === id);
    if (!seq) return null;
    return isSingleStepSequence(seq) ? "single" : "multi";
  }

  function sectionSequences(section: NavSection): SequenceSummary[] {
    return section === "single" ? singleStepSequences : multiStepSequences;
  }

  function sectionGroups(section: NavSection): NavGroup[] {
    return section === "single" ? singleStepGroups : multiStepGroups;
  }

  function dropOnItem(targetId: string, position: DropPosition) {
    if (!draggingId || draggingId === targetId) return;
    const section = sectionOf(draggingId);
    if (!section || section !== sectionOf(targetId)) return;
    const ordered = sectionSequences(section);
    const dragging = ordered.find((s) => s.id === draggingId);
    if (!dragging) return;
    const rest = ordered.filter((s) => s.id !== draggingId);
    const targetIdx = rest.findIndex((s) => s.id === targetId);
    if (targetIdx === -1) return;
    const newGroup = rest[targetIdx].groupTitle ?? null;
    const insertIdx = position === "after" ? targetIdx + 1 : targetIdx;
    const moved: SequenceSummary = { ...dragging, groupTitle: newGroup };
    commitSection(section, [...rest.slice(0, insertIdx), moved, ...rest.slice(insertIdx)]);
  }

  function findGroupInsertIndex(
    rest: SequenceSummary[],
    groupTitle: string,
    section: NavSection,
    atTop: boolean
  ): number {
    const newGroup = groupTitle === UNGROUPED_LABEL ? null : groupTitle;
    const firstInGroup = rest.findIndex((s) => (s.groupTitle ?? null) === newGroup);
    if (atTop) {
      if (firstInGroup !== -1) return firstInGroup;
      const groupsForSection = sectionGroups(section);
      const groupIdx = groupsForSection.findIndex((g) => g.title === groupTitle);
      if (groupIdx === -1) return rest.length;
      for (let i = groupIdx + 1; i < groupsForSection.length; i++) {
        const ng = groupsForSection[i].title === UNGROUPED_LABEL ? null : groupsForSection[i].title;
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

  function dropOnGroupContainer(groupTitle: string, section: NavSection, atTop = false) {
    if (!draggingId) return;
    if (sectionOf(draggingId) !== section) return;
    const ordered = sectionSequences(section);
    const dragging = ordered.find((s) => s.id === draggingId);
    if (!dragging) return;
    const newGroup = groupTitle === UNGROUPED_LABEL ? null : groupTitle;
    const rest = ordered.filter((s) => s.id !== draggingId);
    const insertIdx = findGroupInsertIndex(rest, groupTitle, section, atTop);
    const moved: SequenceSummary = { ...dragging, groupTitle: newGroup };
    commitSection(section, [...rest.slice(0, insertIdx), moved, ...rest.slice(insertIdx)]);
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

  function dropSequenceOnCollapsedGroup(groupTitle: string, section: NavSection) {
    dropOnGroupContainer(groupTitle, section, true);
    setExpandedGroupTitle(accordionKey(section, groupTitle));
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
      if (sectionOf(draggingId) !== sectionOf(id)) return;
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
    onContainerDragOver: (section, e) => {
      if (!draggingId) return;
      if (sectionOf(draggingId) !== section) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onContainerDrop: (title, section, e) => {
      if (!draggingId) return;
      if (sectionOf(draggingId) !== section) return;
      e.preventDefault();
      const collapsed = expandedGroupTitle !== accordionKey(section, title);
      dropOnGroupContainer(title, section, collapsed);
      if (collapsed) setExpandedGroupTitle(accordionKey(section, title));
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
    onGroupHeaderDragOver: (title, section, expanded, e) => {
      if (draggingGroup && draggingGroup !== title) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setGroupDrop({ title, position: verticalPosition(e) });
        return;
      }
      if (draggingId && !expanded && sectionOf(draggingId) === section) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setHeaderSequenceDrop(accordionKey(section, title));
      }
    },
    onGroupHeaderDrop: (title, section, expanded, e) => {
      if (draggingGroup) {
        e.preventDefault();
        e.stopPropagation();
        reorderGroupTo(title, verticalPosition(e));
        resetGroupDrag();
        return;
      }
      if (draggingId && !expanded && sectionOf(draggingId) === section) {
        e.preventDefault();
        e.stopPropagation();
        dropSequenceOnCollapsedGroup(title, section);
      }
    }
  };

  const onlyUngroupedMulti = multiStepGroups.length === 1 && multiStepGroups[0].ungrouped;
  const onlyUngroupedSingle = singleStepGroups.length === 1 && singleStepGroups[0].ungrouped;

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
            {multiStepGroups.length === 0 ? (
              <p className="muted">No sequences yet.</p>
            ) : onlyUngroupedMulti ? (
              <SequenceList
                groupTitle={UNGROUPED_LABEL}
                section="multi"
                sequences={multiStepGroups[0].sequences}
                selectedSequenceId={selectedSequenceId}
                onSelectSequence={onSelectSequence}
                onEditSequence={onEditSequence}
                onDeleteSequence={onDeleteSequence}
                drag={drag}
              />
            ) : (
              <div className="navGroupList">
                {multiStepGroups.map((group) => (
                  <GroupBlock
                    key={`multi:${group.title}`}
                    group={group}
                    section="multi"
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

            {singleStepGroups.length > 0 ? (
              <>
                <div className="navSectionHeader">
                  <h3 className="navSectionTitle" data-testid="nav-single-step-heading">
                    Operations
                  </h3>
                </div>
                <div data-testid="nav-single-step-section">
                  {onlyUngroupedSingle ? (
                    <SequenceList
                      groupTitle={UNGROUPED_LABEL}
                      section="single"
                      sequences={singleStepGroups[0].sequences}
                      selectedSequenceId={selectedSequenceId}
                      onSelectSequence={onSelectSequence}
                      onEditSequence={onEditSequence}
                      onDeleteSequence={onDeleteSequence}
                      drag={drag}
                    />
                  ) : (
                    <div className="navGroupList">
                      {singleStepGroups.map((group) => (
                        <GroupBlock
                          key={`single:${group.title}`}
                          group={group}
                          section="single"
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
                </div>
              </>
            ) : null}

            <AddGroupControl
              existingGroups={groups}
              onAddGroup={(title) => {
                if (hideEmptySequenceGroups) {
                  setPinnedEmptyGroups((prev) =>
                    prev.includes(title) ? prev : [...prev, title]
                  );
                }
                onAddGroup(title);
              }}
            />
          </>
        ) : null}

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
