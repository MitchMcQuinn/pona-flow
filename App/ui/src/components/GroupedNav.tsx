import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  UNGROUPED_LABEL,
  buildNavGroups,
  reindexSequences,
  type GroupableNavItem
} from "../state/navOrder";
import { useViewport } from "../hooks/useViewport";

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

/** One long line over two shorter lines — the new-group control. */
function NewGroupIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M1.5 4.5h13" strokeLinecap="round" />
      <path d="M1.5 8.5h6.5" strokeLinecap="round" />
      <path d="M1.5 12.5h6.5" strokeLinecap="round" />
    </svg>
  );
}

export interface DragApi {
  draggingId: string | null;
  draggingGroup: string | null;
  itemDrop: { id: string; position: DropPosition } | null;
  groupDrop: { title: string; position: DropPosition } | null;
  armItemHandle: () => void;
  armGroupHandle: () => void;
  onItemDragStart: (id: string, e: DragEvent) => void;
  onItemDragEnd: () => void;
  onItemDragOver: (id: string, e: DragEvent) => void;
  onItemDrop: (id: string, e: DragEvent) => void;
  onContainerDragOver: (e: DragEvent) => void;
  onContainerDrop: (title: string, e: DragEvent) => void;
  onGroupDragStart: (title: string, e: DragEvent) => void;
  onGroupDragEnd: () => void;
  onGroupHeaderDragOver: (title: string, expanded: boolean, e: DragEvent) => void;
  onGroupHeaderDrop: (title: string, expanded: boolean, e: DragEvent) => void;
  headerItemDrop: string | null;
}

export interface ReorderApi {
  touch: boolean;
  active: boolean;
  groupOptions: string[];
  canMove: (id: string, dir: -1 | 1) => boolean;
  moveSequence: (id: string, dir: -1 | 1) => void;
  moveToGroup: (id: string, title: string) => void;
  canMoveGroup: (title: string, dir: -1 | 1) => boolean;
  moveGroup: (title: string, dir: -1 | 1) => void;
}

interface GroupedNavProps<T extends GroupableNavItem> {
  title: string;
  tour: string;
  addLabel: string;
  addTestId: string;
  /** Sequences keep the original test id so the existing nav command still finds it. */
  groupTestId?: string;
  reorderTestId?: string;
  items: T[];
  groupOrder: string[];
  loading: boolean;
  error: string | null;
  emptyText: string;
  loadingText: string;
  selectedId: string | null;
  labelOf: (item: T) => string;
  onAdd: () => void;
  onAddGroup: (title: string) => void;
  onDeleteGroup: (title: string) => void;
  onReorderItems: (items: T[]) => void;
  onReorderGroups: (groups: string[]) => void;
  renderItem: (
    item: T,
    ctx: { drag: DragApi; reorder: ReorderApi; selected: boolean }
  ) => ReactNode;
}

function AddGroupForm({
  existingGroups,
  onAddGroup,
  onClose
}: {
  existingGroups: string[];
  onAddGroup: (title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = title.trim();
  const duplicate = existingGroups.some((group) => group.toLowerCase() === trimmed.toLowerCase());
  const canSave = trimmed.length > 0 && !duplicate;

  function save() {
    if (!canSave) return;
    onAddGroup(trimmed);
    onClose();
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
          if (e.key === "Escape") onClose();
        }}
      />
      <div className="navAddGroupActions">
        <button type="button" className="tinyBtn" onClick={onClose}>
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

export function PlainNavItem({
  id,
  label,
  groupTitle,
  selected,
  testId,
  drag,
  reorder,
  onSelect,
  onEdit,
  onDelete,
  editLabel,
  deleteLabel,
  showEdit
}: {
  id: string;
  label: string;
  groupTitle: string | null;
  selected: boolean;
  testId: string;
  drag: DragApi;
  reorder: ReorderApi;
  onSelect: () => void;
  onEdit?: () => void;
  onDelete: () => void;
  editLabel: string;
  deleteLabel: string;
  showEdit: boolean;
}) {
  const indicator = drag.itemDrop && drag.itemDrop.id === id ? drag.itemDrop.position : null;
  const classNames = ["sequenceItem"];
  if (selected) classNames.push("active");
  if (id === drag.draggingId) classNames.push("dragging");
  if (indicator === "before") classNames.push("dropBefore");
  if (indicator === "after") classNames.push("dropAfter");

  return (
    <li
      className={classNames.join(" ")}
      data-testid={testId}
      draggable={!reorder.touch}
      onDragStart={(e) => drag.onItemDragStart(id, e)}
      onDragEnd={drag.onItemDragEnd}
      onDragOver={(e) => drag.onItemDragOver(id, e)}
      onDrop={(e) => drag.onItemDrop(id, e)}
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
      <button className="sequenceBtn" type="button" onClick={onSelect}>
        <span className="sequenceBtnLabel">{label}</span>
      </button>
      {reorder.active ? (
        <span className="inlineActions sequenceReorderActions">
          <button
            className="tinyBtn tinyBtnIcon"
            type="button"
            aria-label={`Move ${label} up`}
            disabled={!reorder.canMove(id, -1)}
            onClick={() => reorder.moveSequence(id, -1)}
          >
            <ArrowIcon dir="up" />
          </button>
          <button
            className="tinyBtn tinyBtnIcon"
            type="button"
            aria-label={`Move ${label} down`}
            disabled={!reorder.canMove(id, 1)}
            onClick={() => reorder.moveSequence(id, 1)}
          >
            <ArrowIcon dir="down" />
          </button>
          {reorder.groupOptions.length > 1 ? (
            <select
              className="navMoveToGroup"
              aria-label={`Move ${label} to group`}
              value={groupTitle?.trim() || UNGROUPED_LABEL}
              onChange={(e) => reorder.moveToGroup(id, e.target.value)}
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
          {showEdit && onEdit ? (
            <button
              className="tinyBtn tinyBtnIcon"
              type="button"
              aria-label={editLabel}
              title={editLabel}
              onClick={onEdit}
            >
              <EditIcon />
            </button>
          ) : null}
          <button
            className="tinyBtn tinyBtnIcon danger"
            type="button"
            aria-label={deleteLabel}
            title={deleteLabel}
            onClick={onDelete}
          >
            <DeleteIcon />
          </button>
        </span>
      )}
    </li>
  );
}

export function GroupedNav<T extends GroupableNavItem>({
  title,
  tour,
  addLabel,
  addTestId,
  groupTestId,
  reorderTestId,
  items,
  groupOrder,
  loading,
  error,
  emptyText,
  loadingText,
  selectedId,
  labelOf,
  onAdd,
  onAddGroup,
  onDeleteGroup,
  onReorderItems,
  onReorderGroups,
  renderItem
}: GroupedNavProps<T>) {
  const built = useMemo(
    () => buildNavGroups(items, groupOrder, labelOf),
    [items, groupOrder, labelOf]
  );
  const named = useMemo(() => built.filter((group) => !group.ungrouped), [built]);
  const loose = useMemo(
    () => built.find((group) => group.ungrouped)?.items ?? [],
    [built]
  );
  const namedTitles = useMemo(() => named.map((group) => group.title), [named]);
  const displayed = useMemo(() => built.flatMap((group) => group.items), [built]);

  const [expandedGroupTitle, setExpandedGroupTitle] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [itemDrop, setItemDrop] = useState<{ id: string; position: DropPosition } | null>(null);
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const [groupDrop, setGroupDrop] = useState<{ title: string; position: DropPosition } | null>(null);
  const [headerItemDrop, setHeaderItemDrop] = useState<string | null>(null);
  const { coarsePointer } = useViewport();
  const [reordering, setReordering] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  const itemArmed = useRef(false);
  const groupArmed = useRef(false);
  const knownGroupTitles = useRef<string[]>([]);

  useEffect(() => {
    if (!selectedId) return;
    const selected = items.find((item) => item.id === selectedId);
    const groupTitle = selected?.groupTitle?.trim() || "";
    if (groupTitle) setExpandedGroupTitle(groupTitle);
  }, [selectedId, items]);

  useEffect(() => {
    if (expandedGroupTitle !== null || namedTitles.length === 0 || selectedId) return;
    setExpandedGroupTitle(namedTitles[0]);
  }, [namedTitles, selectedId, expandedGroupTitle]);

  useEffect(() => {
    if (expandedGroupTitle !== null && namedTitles.includes(expandedGroupTitle)) {
      knownGroupTitles.current = namedTitles;
      return;
    }
    const removed = expandedGroupTitle !== null && knownGroupTitles.current.includes(expandedGroupTitle);
    knownGroupTitles.current = namedTitles;
    if (removed) setExpandedGroupTitle(namedTitles[0] ?? null);
  }, [namedTitles, expandedGroupTitle]);

  useEffect(() => {
    function disarm() {
      itemArmed.current = false;
      groupArmed.current = false;
    }
    window.addEventListener("pointerup", disarm);
    return () => window.removeEventListener("pointerup", disarm);
  }, []);

  function resetItemDrag() {
    itemArmed.current = false;
    setDraggingId(null);
    setItemDrop(null);
    setHeaderItemDrop(null);
  }

  function resetGroupDrag() {
    groupArmed.current = false;
    setDraggingGroup(null);
    setGroupDrop(null);
  }

  function commitOrder(next: T[]) {
    onReorderItems(reindexSequences(next));
  }

  function dropOnItem(targetId: string, position: DropPosition) {
    if (!draggingId || draggingId === targetId) return;
    const dragging = displayed.find((item) => item.id === draggingId);
    if (!dragging) return;
    const rest = displayed.filter((item) => item.id !== draggingId);
    const targetIdx = rest.findIndex((item) => item.id === targetId);
    if (targetIdx === -1) return;
    const newGroup = rest[targetIdx].groupTitle ?? null;
    const insertIdx = position === "after" ? targetIdx + 1 : targetIdx;
    const moved = { ...dragging, groupTitle: newGroup };
    commitOrder([...rest.slice(0, insertIdx), moved, ...rest.slice(insertIdx)]);
  }

  function findGroupInsertIndex(rest: T[], groupTitle: string, atTop: boolean): number {
    const newGroup = groupTitle === UNGROUPED_LABEL ? null : groupTitle;
    const firstInGroup = rest.findIndex((item) => (item.groupTitle ?? null) === newGroup);
    if (atTop) {
      if (firstInGroup !== -1) return firstInGroup;
      const groupIdx = built.findIndex((group) => group.title === groupTitle);
      if (groupIdx === -1) return rest.length;
      for (let i = groupIdx + 1; i < built.length; i++) {
        const nextGroup = built[i].title === UNGROUPED_LABEL ? null : built[i].title;
        const nextIdx = rest.findIndex((item) => (item.groupTitle ?? null) === nextGroup);
        if (nextIdx !== -1) return nextIdx;
      }
      return rest.length;
    }
    let insertIdx = rest.length;
    rest.forEach((item, index) => {
      if ((item.groupTitle ?? null) === newGroup) insertIdx = index + 1;
    });
    return insertIdx;
  }

  function dropOnGroupContainer(groupTitle: string, atTop = false) {
    if (!draggingId) return;
    const dragging = displayed.find((item) => item.id === draggingId);
    if (!dragging) return;
    const newGroup = groupTitle === UNGROUPED_LABEL ? null : groupTitle;
    const rest = displayed.filter((item) => item.id !== draggingId);
    const insertIdx = findGroupInsertIndex(rest, groupTitle, atTop);
    const moved = { ...dragging, groupTitle: newGroup };
    commitOrder([...rest.slice(0, insertIdx), moved, ...rest.slice(insertIdx)]);
  }

  function reorderGroupTo(targetTitle: string, position: DropPosition) {
    if (!draggingGroup || draggingGroup === targetTitle) return;
    const base = groupOrder.map((group) => group.trim()).filter((group) => group && group !== draggingGroup);
    const targetIdx = base.indexOf(targetTitle);
    if (targetIdx === -1) return;
    const insertIdx = position === "after" ? targetIdx + 1 : targetIdx;
    onReorderGroups([...base.slice(0, insertIdx), draggingGroup, ...base.slice(insertIdx)]);
  }

  function verticalPosition(e: DragEvent): DropPosition {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2 ? "after" : "before";
  }

  function dropOnCollapsedGroup(groupTitle: string) {
    dropOnGroupContainer(groupTitle, true);
    setExpandedGroupTitle(groupTitle);
    resetItemDrag();
  }

  const drag: DragApi = {
    draggingId,
    draggingGroup,
    itemDrop,
    groupDrop,
    headerItemDrop,
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
    onContainerDrop: (groupTitle, e) => {
      if (!draggingId) return;
      e.preventDefault();
      // The ungrouped tail is always open, so a drop there appends instead of jumping to the top.
      const collapsed = groupTitle !== UNGROUPED_LABEL && expandedGroupTitle !== groupTitle;
      dropOnGroupContainer(groupTitle, collapsed);
      if (collapsed) setExpandedGroupTitle(groupTitle);
      resetItemDrag();
    },
    onGroupDragStart: (groupTitle, e) => {
      if (!groupArmed.current) {
        e.preventDefault();
        return;
      }
      setDraggingGroup(groupTitle);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", groupTitle);
    },
    onGroupDragEnd: resetGroupDrag,
    onGroupHeaderDragOver: (groupTitle, expanded, e) => {
      if (draggingGroup && draggingGroup !== groupTitle) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setGroupDrop({ title: groupTitle, position: verticalPosition(e) });
        return;
      }
      if (draggingId && !expanded) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setHeaderItemDrop(groupTitle);
      }
    },
    onGroupHeaderDrop: (groupTitle, expanded, e) => {
      if (draggingGroup) {
        e.preventDefault();
        e.stopPropagation();
        reorderGroupTo(groupTitle, verticalPosition(e));
        resetGroupDrag();
        return;
      }
      if (draggingId && !expanded) {
        e.preventDefault();
        e.stopPropagation();
        dropOnCollapsedGroup(groupTitle);
      }
    }
  };

  function groupOf(id: string) {
    return built.find((group) => group.items.some((item) => item.id === id));
  }

  const reorder: ReorderApi = {
    touch: coarsePointer,
    active: coarsePointer && reordering,
    groupOptions: [...namedTitles, UNGROUPED_LABEL],
    canMove: (id, dir) => {
      const group = groupOf(id);
      if (!group) return false;
      const next = group.items.findIndex((item) => item.id === id) + dir;
      return next >= 0 && next < group.items.length;
    },
    moveSequence: (id, dir) => {
      const group = groupOf(id);
      if (!group) return;
      const idx = group.items.findIndex((item) => item.id === id);
      const other = group.items[idx + dir];
      if (!other) return;
      const next = displayed.slice();
      const a = next.findIndex((item) => item.id === id);
      const b = next.findIndex((item) => item.id === other.id);
      [next[a], next[b]] = [next[b], next[a]];
      commitOrder(next);
    },
    moveToGroup: (id, groupTitle) => {
      const moving = displayed.find((item) => item.id === id);
      if (!moving) return;
      const rest = displayed.filter((item) => item.id !== id);
      const insertIdx = findGroupInsertIndex(rest, groupTitle, false);
      const moved = {
        ...moving,
        groupTitle: groupTitle === UNGROUPED_LABEL ? null : groupTitle
      };
      commitOrder([...rest.slice(0, insertIdx), moved, ...rest.slice(insertIdx)]);
      if (groupTitle !== UNGROUPED_LABEL) setExpandedGroupTitle(groupTitle);
    },
    canMoveGroup: (groupTitle, dir) => {
      const next = namedTitles.indexOf(groupTitle) + dir;
      return next >= 0 && next < namedTitles.length;
    },
    moveGroup: (groupTitle, dir) => {
      const idx = namedTitles.indexOf(groupTitle);
      const target = idx + dir;
      if (idx === -1 || target < 0 || target >= namedTitles.length) return;
      const next = namedTitles.slice();
      [next[idx], next[target]] = [next[target], next[idx]];
      onReorderGroups(next);
    }
  };

  function renderList(groupTitle: string, listItems: T[], dropSlot: boolean) {
    return (
      <ul
        className={dropSlot ? "sequenceList sequenceListDropSlot" : "sequenceList"}
        onDragOver={(e) => drag.onContainerDragOver(e)}
        onDrop={(e) => drag.onContainerDrop(groupTitle, e)}
      >
        {listItems.map((item) =>
          renderItem(item, { drag, reorder, selected: item.id === selectedId })
        )}
      </ul>
    );
  }

  const showLoose = named.length > 0 && (loose.length > 0 || draggingId !== null);
  const showEmpty = !loading && !error && items.length === 0 && named.length === 0;

  return (
    <section className="navSection">
      <div className="navSectionHeader" data-tour={tour}>
        <h2 className="navSectionTitle">{title}</h2>
        <span className="navSectionActions">
          {coarsePointer && items.length + namedTitles.length > 1 ? (
            <button
              type="button"
              className={`navReorderToggle${reordering ? " active" : ""}`}
              aria-pressed={reordering}
              data-testid={reorderTestId}
              onClick={() => setReordering((on) => !on)}
            >
              {reordering ? "Done" : "Reorder"}
            </button>
          ) : null}
          <button
            type="button"
            className="navAddGroupIcon"
            data-testid={groupTestId}
            aria-label="New group"
            title="New group"
            onClick={() => setAddingGroup(true)}
          >
            <NewGroupIcon />
          </button>
          <button
            type="button"
            className="navAddBtn"
            aria-label={addLabel}
            data-testid={addTestId}
            onClick={onAdd}
          >
            +
          </button>
        </span>
      </div>
      {addingGroup ? (
          <AddGroupForm
          existingGroups={groupOrder}
          onAddGroup={(groupTitle) => {
            onAddGroup(groupTitle);
            setExpandedGroupTitle(groupTitle);
          }}
          onClose={() => setAddingGroup(false)}
        />
      ) : null}

      {loading ? <p className="muted">{loadingText}</p> : null}
      {error ? <p className="errorText">{error}</p> : null}
      {showEmpty ? <p className="muted">{emptyText}</p> : null}

      {!loading && !error && (named.length > 0 || loose.length > 0) ? (
        named.length === 0 ? (
          renderList(UNGROUPED_LABEL, loose, false)
        ) : (
          <div className="navGroupList">
            {named.map((group) => {
              const expanded = expandedGroupTitle === group.title;
              const indicator =
                drag.groupDrop && drag.groupDrop.title === group.title ? drag.groupDrop.position : null;
              const headerClasses = ["navGroupHeader"];
              if (group.title === drag.draggingGroup) headerClasses.push("dragging");
              if (indicator === "before") headerClasses.push("dropBefore");
              if (indicator === "after") headerClasses.push("dropAfter");
              if (drag.headerItemDrop === group.title) headerClasses.push("sequenceDropTarget");
              return (
                <div
                  key={group.title}
                  className="navGroup"
                  onDragOver={(e) => drag.onContainerDragOver(e)}
                  onDrop={(e) => drag.onContainerDrop(group.title, e)}
                >
                  <div
                    className={headerClasses.join(" ")}
                    draggable={!reorder.touch}
                    onDragStart={(e) => drag.onGroupDragStart(group.title, e)}
                    onDragEnd={drag.onGroupDragEnd}
                    onDragOver={(e) => drag.onGroupHeaderDragOver(group.title, expanded, e)}
                    onDrop={(e) => drag.onGroupHeaderDrop(group.title, expanded, e)}
                  >
                    {!reorder.touch ? (
                      <span
                        className="navGroupDragHandle"
                        aria-label="Drag to reorder group"
                        title="Drag to reorder group"
                        onPointerDown={drag.armGroupHandle}
                      >
                        <DragHandleIcon />
                      </span>
                    ) : null}
                    <h3 className="navGroupTitle">
                      <button
                        type="button"
                        className="navGroupToggle"
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedGroupTitle((current) => (current === group.title ? null : group.title))
                        }
                      >
                        <span className="navGroupToggleLabel">
                          <span className="navGroupTitleText">{group.title}</span>
                          <ChevronIcon />
                        </span>
                      </button>
                    </h3>
                    {reorder.active ? (
                      <span className="inlineActions navGroupReorderActions">
                        <button
                          type="button"
                          className="tinyBtn tinyBtnIcon"
                          aria-label={`Move group ${group.title} up`}
                          disabled={!reorder.canMoveGroup(group.title, -1)}
                          onClick={() => reorder.moveGroup(group.title, -1)}
                        >
                          <ArrowIcon dir="up" />
                        </button>
                        <button
                          type="button"
                          className="tinyBtn tinyBtnIcon"
                          aria-label={`Move group ${group.title} down`}
                          disabled={!reorder.canMoveGroup(group.title, 1)}
                          onClick={() => reorder.moveGroup(group.title, 1)}
                        >
                          <ArrowIcon dir="down" />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="tinyBtn tinyBtnIcon danger navGroupDeleteBtn"
                        aria-label={`Delete group ${group.title}`}
                        title="Delete group"
                        onClick={() => onDeleteGroup(group.title)}
                      >
                        <DeleteIcon />
                      </button>
                    )}
                  </div>
                  {expanded ? renderList(group.title, group.items, false) : null}
                </div>
              );
            })}
            {showLoose ? renderList(UNGROUPED_LABEL, loose, loose.length === 0) : null}
          </div>
        )
      ) : null}
    </section>
  );
}
