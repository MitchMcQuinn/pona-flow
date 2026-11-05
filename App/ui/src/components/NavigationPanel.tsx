import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ConsoleNavItem, EventSummary, SequenceSummary } from "../state/types";
import { UNGROUPED_LABEL } from "../state/navOrder";
import { GroupedNav, PlainNavItem, type DragApi, type ReorderApi } from "./GroupedNav";

interface NavigationPanelProps {
  sequences: SequenceSummary[];
  groups: string[];
  selectedSequenceId: string | null;
  loading: boolean;
  error: string | null;
  onSelectSequence: (sequenceId: string) => void;
  onCreateSequence: () => void;
  /** Open the selected sequence in the builder for editing (hydrated from builder_config). */
  onEditSequence: (sequenceId: string) => void;
  /** Delete the selected sequence (nav-only removal, or STEP cascade when the entry STEP exists). */
  onDeleteSequence: (sequenceId: string) => void;
  /** Persist a new sequence ordering / group assignment after a drag. */
  onReorderSequences: (sequences: SequenceSummary[]) => void;
  /** Persist a new ordered group-title list. */
  onReorderGroups: (groups: string[]) => void;
  onAddGroup: (title: string) => void;
  onDeleteGroup: (title: string) => void;
  events: EventSummary[];
  eventGroups: string[];
  selectedEventId: string | null;
  eventsLoading: boolean;
  eventsError: string | null;
  onSelectEvent: (eventId: string) => void;
  onEditEvent: (eventId: string) => void;
  onCreateEvent: () => void;
  onDeleteEvent: (eventId: string) => void;
  onReorderEvents: (events: EventSummary[]) => void;
  onReorderEventGroups: (groups: string[]) => void;
  onAddEventGroup: (title: string) => void;
  onDeleteEventGroup: (title: string) => void;
  /** The open event is in its settings editor, so its nav edit icon stays hidden. */
  eventEditing?: boolean;
  consoles: ConsoleNavItem[];
  consoleGroups: string[];
  selectedConsoleId: string | null;
  consolesLoading: boolean;
  consolesError: string | null;
  onSelectConsole: (consoleId: string) => void;
  onEditConsole: (consoleId: string) => void;
  onCreateConsole: () => void;
  onDeleteConsole: (consoleId: string) => void;
  onReorderConsoles: (consoles: ConsoleNavItem[]) => void;
  onReorderConsoleGroups: (groups: string[]) => void;
  onAddConsoleGroup: (title: string) => void;
  onDeleteConsoleGroup: (title: string) => void;
  /** The open console is in edit mode, so its nav edit icon stays hidden. */
  consoleEditing?: boolean;
  /** Open the builder and leave the selected event, console, or sequence. */
  onOpenWorkbench: () => void;
  /** The builder is the open view, so the heading is the current page. */
  workbenchActive: boolean;
  /** Catalog sequence ids with a background run (waiting or active — not HITL pending). */
  inFlightSequenceIds?: string[];
}

function ActivityIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" strokeOpacity="0.35" />
      <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" strokeLinecap="round" />
    </svg>
  );
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

function MultiStepIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="3.5" cy="8" r="2" />
      <circle cx="12.5" cy="8" r="2" />
      <path d="M5.5 8h5" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon({ dir }: { dir: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path
        d={dir === "up" ? "M8 12.5V3.5M4 7.5l4-4 4 4" : "M8 3.5v9M4 8.5l4 4 4-4"}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const LONG_PRESS_MS = 450;
const LONG_PRESS_TOOLTIP_MS = 2500;

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
  drag,
  reorder,
  inFlight
}: {
  sequence: SequenceSummary;
  selected: boolean;
  onSelectSequence: (sequenceId: string) => void;
  onEditSequence: (sequenceId: string) => void;
  onDeleteSequence: (sequenceId: string) => void;
  drag: DragApi;
  reorder: ReorderApi;
  inFlight: boolean;
}) {
  const itemRef = useRef<HTMLLIElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);
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
      if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    };
  }, []);

  function cancelLongPress() {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  }

  // Touch has no hover, so a long press reveals the full name / warning instead.
  function onTouchPress(event: React.PointerEvent) {
    if (event.pointerType !== "touch") return;
    cancelLongPress();
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      suppressClick.current = true;
      setHovered(true);
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(() => setHovered(false), LONG_PRESS_TOOLTIP_MS);
    }, LONG_PRESS_MS);
  }

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
      data-sequence-id={sequence.id}
      data-single-step={sequence.singleStep ? "true" : "false"}
      data-orphaned={sequence.orphaned ? "true" : "false"}
      data-suspended={sequence.suspended ? "true" : "false"}
      title={warning ?? undefined}
      draggable={!reorder.touch}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") onItemEnter();
      }}
      onPointerLeave={onItemLeave}
      onPointerDown={onTouchPress}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onClickCapture={(e) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragStart={(e) => drag.onItemDragStart(sequence.id, e)}
      onDragEnd={drag.onItemDragEnd}
      onDragOver={(e) => drag.onItemDragOver(sequence.id, e)}
      onDrop={(e) => drag.onItemDrop(sequence.id, e)}
    >
      {!reorder.touch ? (
        <span
          className="sequenceDragHandle"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          onPointerDown={drag.armItemHandle}
        >
          <DragHandleIcon />
        </span>
      ) : null}
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
        {!sequence.singleStep ? (
          <span className="sequenceMultiStepIcon" title="Multi-step sequence">
            <MultiStepIcon />
          </span>
        ) : null}
        <span className="sequenceBtnLabel" ref={labelRef}>
          {sequence.label}
        </span>
        {inFlight ? (
          <span className="sequenceActivityIcon" title="Sequence is running" data-testid="sequence-activity-icon">
            <ActivityIcon />
          </span>
        ) : null}
      </button>
      {reorder.active ? (
        <span className="inlineActions sequenceReorderActions">
          <button
            className="tinyBtn tinyBtnIcon"
            type="button"
            aria-label={`Move ${sequence.label} up`}
            data-testid="nav-move-up"
            disabled={!reorder.canMove(sequence.id, -1)}
            onClick={() => reorder.moveSequence(sequence.id, -1)}
          >
            <ArrowIcon dir="up" />
          </button>
          <button
            className="tinyBtn tinyBtnIcon"
            type="button"
            aria-label={`Move ${sequence.label} down`}
            data-testid="nav-move-down"
            disabled={!reorder.canMove(sequence.id, 1)}
            onClick={() => reorder.moveSequence(sequence.id, 1)}
          >
            <ArrowIcon dir="down" />
          </button>
          {reorder.groupOptions.length > 1 ? (
            <select
              className="navMoveToGroup"
              aria-label={`Move ${sequence.label} to group`}
              value={sequence.groupTitle?.trim() || UNGROUPED_LABEL}
              onChange={(e) => reorder.moveToGroup(sequence.id, e.target.value)}
            >
              {reorder.groupOptions.map((title) => (
                <option key={title} value={title}>
                  {title}
                </option>
              ))}
            </select>
          ) : null}
        </span>
      ) : (
        <span className="inlineActions sequenceItemActions">
          <button
            className="tinyBtn tinyBtnIcon"
            type="button"
            aria-label={
              sequence.singleStep
                ? `Edit step ${sequence.label}`
                : `Edit sequence ${sequence.label}`
            }
            title={sequence.singleStep ? "Edit step" : "Edit sequence"}
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
      )}
      {showTooltip ? <SequenceNameTooltip label={tooltipLabel} anchorRef={itemRef} /> : null}
    </li>
  );
}

export function NavigationPanel({
  sequences,
  groups,
  selectedSequenceId,
  loading,
  error,
  onSelectSequence,
  onCreateSequence,
  onEditSequence,
  onDeleteSequence,
  onReorderSequences,
  onReorderGroups,
  onAddGroup,
  onDeleteGroup,
  events,
  eventGroups,
  selectedEventId,
  eventsLoading,
  eventsError,
  onSelectEvent,
  onEditEvent,
  onCreateEvent,
  onDeleteEvent,
  onReorderEvents,
  onReorderEventGroups,
  onAddEventGroup,
  onDeleteEventGroup,
  eventEditing = false,
  consoles,
  consoleGroups,
  selectedConsoleId,
  consolesLoading,
  consolesError,
  onSelectConsole,
  onEditConsole,
  onCreateConsole,
  onDeleteConsole,
  onReorderConsoles,
  onReorderConsoleGroups,
  onAddConsoleGroup,
  onDeleteConsoleGroup,
  consoleEditing = false,
  onOpenWorkbench,
  workbenchActive,
  inFlightSequenceIds = []
}: NavigationPanelProps) {
  const navSequences = useMemo(
    () => sequences.filter((sequence) => sequence.kind === "sequence"),
    [sequences]
  );

  return (
    <div className="panel navPanel">
      <header className="columnHead">
        <h1 className="navWorkbenchTitle">
          <button
            type="button"
            className="navWorkbenchLink"
            data-testid="nav-workbench"
            aria-current={workbenchActive ? "page" : undefined}
            onClick={onOpenWorkbench}
          >
            work<wbr />bench
          </button>
        </h1>
      </header>
      <div className="panel__body">
        <GroupedNav
          title="events"
          tour="events"
          addLabel="Add event"
          addTestId="nav-add-event"
          groupTestId="nav-add-event-group"
          items={events}
          groupOrder={eventGroups}
          loading={eventsLoading}
          error={eventsError}
          emptyText="No events yet."
          loadingText="Loading events..."
          selectedId={selectedEventId}
          labelOf={(event) => event.name}
          onAdd={onCreateEvent}
          onAddGroup={onAddEventGroup}
          onDeleteGroup={onDeleteEventGroup}
          onReorderItems={onReorderEvents}
          onReorderGroups={onReorderEventGroups}
          renderItem={(event, ctx) => (
            <PlainNavItem
              id={event.id}
              label={event.name}
              groupTitle={event.groupTitle}
              selected={ctx.selected}
              testId="nav-event-item"
              drag={ctx.drag}
              reorder={ctx.reorder}
              onSelect={() => onSelectEvent(event.id)}
              onEdit={() => onEditEvent(event.id)}
              onDelete={() => onDeleteEvent(event.id)}
              editLabel={`Edit event ${event.name}`}
              deleteLabel={`Delete event ${event.name}`}
              showEdit={!(event.id === selectedEventId && eventEditing)}
            />
          )}
        />

        <GroupedNav
          title="consoles"
          tour="consoles"
          addLabel="Add console"
          addTestId="nav-add-console"
          groupTestId="nav-add-console-group"
          items={consoles}
          groupOrder={consoleGroups}
          loading={consolesLoading}
          error={consolesError}
          emptyText="No consoles yet."
          loadingText="Loading consoles..."
          selectedId={selectedConsoleId}
          labelOf={(console) => console.name}
          onAdd={onCreateConsole}
          onAddGroup={onAddConsoleGroup}
          onDeleteGroup={onDeleteConsoleGroup}
          onReorderItems={onReorderConsoles}
          onReorderGroups={onReorderConsoleGroups}
          renderItem={(console, ctx) => (
            <PlainNavItem
              id={console.id}
              label={console.name}
              groupTitle={console.groupTitle}
              selected={ctx.selected}
              testId="nav-console-item"
              drag={ctx.drag}
              reorder={ctx.reorder}
              onSelect={() => onSelectConsole(console.id)}
              onEdit={() => onEditConsole(console.id)}
              onDelete={() => onDeleteConsole(console.id)}
              editLabel={`Edit console ${console.name}`}
              deleteLabel={`Delete console ${console.name}`}
              showEdit={!(console.id === selectedConsoleId && consoleEditing)}
            />
          )}
        />

        <GroupedNav
          title="sequences"
          tour="sequences"
          addLabel="Add sequence"
          addTestId="nav-add-sequence"
          groupTestId="nav-add-group"
          reorderTestId="nav-reorder-toggle"
          items={navSequences}
          groupOrder={groups}
          loading={loading}
          error={error}
          emptyText="No sequences yet."
          loadingText="Loading sequences..."
          selectedId={selectedSequenceId}
          labelOf={(sequence) => sequence.label}
          onAdd={onCreateSequence}
          onAddGroup={onAddGroup}
          onDeleteGroup={onDeleteGroup}
          onReorderItems={onReorderSequences}
          onReorderGroups={onReorderGroups}
          renderItem={(sequence, ctx) => (
            <SequenceItem
              sequence={sequence}
              selected={ctx.selected}
              onSelectSequence={onSelectSequence}
              onEditSequence={onEditSequence}
              onDeleteSequence={onDeleteSequence}
              drag={ctx.drag}
              reorder={ctx.reorder}
              inFlight={inFlightSequenceIds.includes(sequence.id)}
            />
          )}
        />
      </div>
    </div>
  );
}
