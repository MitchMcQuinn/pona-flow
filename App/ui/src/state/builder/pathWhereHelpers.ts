import { newWhereFilter } from "./defaults";
import type { NodePattern, RelationshipPattern, WhereGroup, WhereItem } from "./types";
import { isWhereFilter, isWhereGroup } from "./types";

function updateWhereItemAt(
  group: WhereGroup,
  path: number[],
  fn: (item: WhereItem) => WhereItem | null
): WhereGroup {
  if (path.length === 0) return group;
  const [head, ...rest] = path;
  const target = group.items[head];
  if (target === undefined) return group;
  let nextItem: WhereItem | null;
  if (rest.length === 0) {
    nextItem = fn(target);
  } else if (isWhereGroup(target)) {
    nextItem = updateWhereItemAt(target, rest, fn);
  } else {
    return group;
  }
  const items =
    nextItem === null
      ? group.items.filter((_, i) => i !== head)
      : group.items.map((item, i) => (i === head ? (nextItem as WhereItem) : item));
  return { ...group, items };
}

export function defaultWhereGroup(): WhereGroup {
  return { operator: "AND", items: [] };
}

/** True when the group contains at least one filter with a property key. */
export function whereGroupHasFilters(group: WhereGroup | undefined): boolean {
  if (!group?.items?.length) return false;
  for (const item of group.items) {
    if (isWhereFilter(item)) {
      if (item.property_key.trim()) return true;
    } else if (isWhereGroup(item) && whereGroupHasFilters(item)) {
      return true;
    }
  }
  return false;
}

/** Whether the per-path WHERE card should show (read flow toggle). */
export function pathFiltersVisible(entity: {
  where_enabled?: boolean;
  where?: WhereGroup;
}): boolean {
  if (entity.where_enabled === true) return true;
  if (entity.where_enabled === false) return false;
  return whereGroupHasFilters(entity.where);
}

export function ensureEntityWhere(entity: { where?: WhereGroup }): WhereGroup {
  return entity.where ?? defaultWhereGroup();
}

export function patchEntityWhere(
  where: WhereGroup | undefined
): Partial<NodePattern> | Partial<RelationshipPattern> {
  return { where };
}

export function setEntityWhereOperator(
  where: WhereGroup,
  path: number[],
  operator: "AND" | "OR"
): WhereGroup {
  if (path.length === 0) return { ...where, operator };
  return updateWhereItemAt(where, path, (item) =>
    isWhereGroup(item) ? { ...item, operator } : item
  );
}

export function addEntityWhereFilter(where: WhereGroup, path: number[]): WhereGroup {
  const filter = newWhereFilter();
  if (path.length === 0) {
    return { ...where, items: [...where.items, filter] };
  }
  return updateWhereItemAt(where, path, (item) =>
    isWhereGroup(item) ? { ...item, items: [...item.items, filter] } : item
  );
}

export function addEntityWhereGroup(where: WhereGroup, path: number[]): WhereGroup {
  const group: WhereGroup = { operator: "AND", items: [] };
  if (path.length === 0) {
    return { ...where, items: [...where.items, group] };
  }
  return updateWhereItemAt(where, path, (item) =>
    isWhereGroup(item) ? { ...item, items: [...item.items, group] } : item
  );
}

export function updateEntityWhereFilter(
  where: WhereGroup,
  path: number[],
  patch: Partial<import("./types").WhereFilter>
): WhereGroup {
  return updateWhereItemAt(where, path, (item) =>
    isWhereGroup(item) ? item : { ...item, ...patch }
  );
}

export function removeEntityWhereItem(where: WhereGroup, path: number[]): WhereGroup | undefined {
  if (path.length === 0) return undefined;
  const next = updateWhereItemAt(where, path, () => null);
  return next.items.length ? next : undefined;
}

/** Replace the WhereGroup at *path* (path=[] replaces root). */
export function patchRootWhereGroup(
  root: WhereGroup,
  path: number[],
  groupAtPath: WhereGroup
): WhereGroup {
  if (path.length === 0) return groupAtPath;
  const [head, ...rest] = path;
  return updateWhereItemAt(root, [head], (item) =>
    isWhereGroup(item) ? patchRootWhereGroup(item, rest, groupAtPath) : item
  );
}
