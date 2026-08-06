// Pure immutable helpers for editing the QueryObject tree. Components pass these
// (curried) into the UPDATE_QUERY action so the reducer stays a one-liner.

import { clearedMatchAliasFields } from "./matchAlias";
import {
  newMatchClause,
  newParameter,
  newPattern,
  newNodePattern,
  newPropertyBinding,
  newRelationshipPattern,
  newReturnItem,
  newSchemaProperty,
  newSchematicProperties
} from "./defaults";
import type {
  GraphNodeLabel,
  GraphPattern,
  MatchClause,
  NodePattern,
  Operation,
  OrderByItem,
  Parameter,
  PathElement,
  PropertyBinding,
  QueryObject,
  RelationshipPattern,
  ReturnItem,
  SchematicProperties,
  SetItem,
  WhereGroup,
  WhereItem
} from "./types";

function replaceAt<T>(arr: T[], index: number, value: T): T[] {
  return arr.map((item, i) => (i === index ? value : item));
}

function removeAt<T>(arr: T[], index: number): T[] {
  return arr.filter((_, i) => i !== index);
}

// ---- MATCH clauses ----

export function addMatchClause(label: GraphNodeLabel = "STEP") {
  return (q: QueryObject): QueryObject => ({ ...q, match: [...q.match, newMatchClause(label)] });
}

export function removeMatchClause(clauseIndex: number) {
  return (q: QueryObject): QueryObject => ({ ...q, match: removeAt(q.match, clauseIndex) });
}

export function updateMatchClause(clauseIndex: number, patch: Partial<MatchClause>) {
  return (q: QueryObject): QueryObject => ({
    ...q,
    match: replaceAt(q.match, clauseIndex, { ...q.match[clauseIndex], ...patch })
  });
}

// ---- Patterns ----

export function addPattern(clauseIndex: number) {
  return (q: QueryObject): QueryObject => {
    const clause = q.match[clauseIndex];
    const next: MatchClause = { ...clause, patterns: [...clause.patterns, newPattern()] };
    return { ...q, match: replaceAt(q.match, clauseIndex, next) };
  };
}

export function removePattern(clauseIndex: number, patternIndex: number) {
  return (q: QueryObject): QueryObject => {
    const clause = q.match[clauseIndex];
    const next: MatchClause = { ...clause, patterns: removeAt(clause.patterns, patternIndex) };
    return { ...q, match: replaceAt(q.match, clauseIndex, next) };
  };
}

function mapPattern(
  q: QueryObject,
  clauseIndex: number,
  patternIndex: number,
  fn: (pattern: GraphPattern) => GraphPattern
): QueryObject {
  const clause = q.match[clauseIndex];
  const pattern = clause.patterns[patternIndex];
  const nextPattern = fn(pattern);
  const nextClause: MatchClause = {
    ...clause,
    patterns: replaceAt(clause.patterns, patternIndex, nextPattern)
  };
  return { ...q, match: replaceAt(q.match, clauseIndex, nextClause) };
}

// ---- Path elements ----

export function addPathRelAndNode(clauseIndex: number, patternIndex: number) {
  return (q: QueryObject): QueryObject =>
    mapPattern(q, clauseIndex, patternIndex, (pattern) => ({
      ...pattern,
      path: [
        ...pattern.path,
        { kind: "relationship", relationship: newRelationshipPattern() },
        { kind: "node", node: newNodePattern() }
      ]
    }));
}

export function removePathTail(clauseIndex: number, patternIndex: number) {
  return (q: QueryObject): QueryObject =>
    mapPattern(q, clauseIndex, patternIndex, (pattern) => {
      // Remove the trailing node + its preceding relationship (keep first node).
      if (pattern.path.length <= 1) return pattern;
      return { ...pattern, path: pattern.path.slice(0, pattern.path.length - 2) };
    });
}

export function updateNode(
  clauseIndex: number,
  patternIndex: number,
  pathIndex: number,
  patch: Partial<NodePattern>
) {
  return (q: QueryObject): QueryObject =>
    mapPattern(q, clauseIndex, patternIndex, (pattern) => {
      const element = pattern.path[pathIndex];
      if (element.kind !== "node") return pattern;
      const nextElement: PathElement = { kind: "node", node: { ...element.node, ...patch } };
      return { ...pattern, path: replaceAt(pattern.path, pathIndex, nextElement) };
    });
}

export function updateRelationship(
  clauseIndex: number,
  patternIndex: number,
  pathIndex: number,
  patch: Partial<RelationshipPattern>
) {
  return (q: QueryObject): QueryObject =>
    mapPattern(q, clauseIndex, patternIndex, (pattern) => {
      const element = pattern.path[pathIndex];
      if (element.kind !== "relationship") return pattern;
      const nextElement: PathElement = {
        kind: "relationship",
        relationship: { ...element.relationship, ...patch }
      };
      return { ...pattern, path: replaceAt(pattern.path, pathIndex, nextElement) };
    });
}

/**
 * How a match hop composes: "required" (plain MATCH pattern), "optional"
 * (OPTIONAL MATCH tail — anchors without the hop still return), or "absent"
 * (NOT EXISTS anti-join — only anchors WITHOUT the hop return).
 */
export type HopMode = "required" | "optional" | "absent";

export function relationshipHopMode(rel: RelationshipPattern): HopMode {
  if (rel.absent === true) return "absent";
  if (rel.optional === true) return "optional";
  return "required";
}

/**
 * Set a match hop's mode. Setting "optional" forces every downstream relationship in
 * the pattern optional too (the composer renders everything after the first optional
 * hop as OPTIONAL MATCH segments, so the flags stay truthful to the composed Cypher).
 * Setting "absent" clears all downstream flags: everything after the absent hop lives
 * inside the single NOT EXISTS pattern and carries no mode of its own. Setting
 * "required" clears only this hop.
 */
export function setRelationshipHopMode(
  clauseIndex: number,
  patternIndex: number,
  pathIndex: number,
  mode: HopMode
) {
  return (q: QueryObject): QueryObject =>
    mapPattern(q, clauseIndex, patternIndex, (pattern) => ({
      ...pattern,
      path: pattern.path.map((el, i): PathElement => {
        if (el.kind !== "relationship") return el;
        if (i === pathIndex) {
          return {
            kind: "relationship",
            relationship: {
              ...el.relationship,
              optional: mode === "optional" || undefined,
              absent: mode === "absent" || undefined
            }
          };
        }
        if (i > pathIndex && mode === "optional") {
          return {
            kind: "relationship",
            relationship: { ...el.relationship, optional: true, absent: undefined }
          };
        }
        if (i > pathIndex && mode === "absent") {
          return {
            kind: "relationship",
            relationship: { ...el.relationship, optional: undefined, absent: undefined }
          };
        }
        return el;
      })
    }));
}

// ---- Variable-length traversal (depth) ----

/** Cap on the depth control's hop bounds — protects Neo4j from runaway traversals. */
export const MAX_TRAVERSAL_DEPTH = 10;

/** True when the hop composes as a variable-length pattern (*min..max). */
export function relationshipHasVariableLength(rel: RelationshipPattern): boolean {
  return Boolean(rel.length && (rel.length.min !== undefined || rel.length.max !== undefined));
}

/** Clamp a depth input to an integer within [0, MAX_TRAVERSAL_DEPTH]; undefined when blank. */
export function clampTraversalDepth(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) return undefined;
  return Math.min(Math.max(parsed, 0), MAX_TRAVERSAL_DEPTH);
}

/**
 * Set or clear a match hop's variable-length range. A variable-length alias binds a
 * *list* of relationships, so alias-dependent per-hop WHERE filters are cleared along
 * with the range (alias.prop predicates would be invalid Cypher).
 */
export function setRelationshipLength(
  clauseIndex: number,
  patternIndex: number,
  pathIndex: number,
  length: RelationshipPattern["length"] | undefined
) {
  return updateRelationship(
    clauseIndex,
    patternIndex,
    pathIndex,
    length ? { length, where: undefined, where_enabled: false } : { length: undefined }
  );
}

/**
 * Mode forced onto this hop by an earlier relationship in the pattern ("optional"
 * when it follows an optional hop, "absent" when it lives inside an absent tail),
 * or null when the hop is free to choose its own mode.
 */
export function hopForcedMode(
  pattern: GraphPattern | undefined,
  pathIndex: number
): HopMode | null {
  if (!pattern) return null;
  for (let i = 0; i < pathIndex; i += 1) {
    const el = pattern.path[i];
    if (el.kind !== "relationship") continue;
    if (el.relationship.absent === true) return "absent";
    if (el.relationship.optional === true) return "optional";
  }
  return null;
}

/**
 * Clear attributive_label and match properties on all path entries after *afterPathIndex*.
 *
 * In graph mode the canvas owns each entity's identity (its Cypher variable + define/reference
 * alias fields), so `preserveIdentity` keeps those intact and only wipes the schema-bound config
 * (attributive_label/properties/where). Without it, downstream nodes would be left without a
 * variable — which fails composition with "a node is missing its Cypher variable."
 */
export function clearPathAttributiveLabelsAfter(
  clauseIndex: number,
  patternIndex: number,
  afterPathIndex: number,
  options: { preserveIdentity?: boolean } = {}
) {
  const identityReset = options.preserveIdentity ? {} : clearedMatchAliasFields();
  return (q: QueryObject): QueryObject =>
    mapPattern(q, clauseIndex, patternIndex, (pattern) => ({
      ...pattern,
      path: pattern.path.map((el, i) => {
        if (i <= afterPathIndex) return el;
        if (el.kind === "node") {
          return {
            kind: "node",
            node: {
              ...el.node,
              attributive_label: "",
              properties: [],
              where: undefined,
              ...identityReset
            }
          };
        }
        return {
          kind: "relationship",
          relationship: {
            ...el.relationship,
            attributive_label: "",
            properties: [],
            where: undefined,
            ...identityReset
          }
        };
      })
    }));
}

// ---- Property bindings on a node or relationship ----

function updateElementProperties(
  q: QueryObject,
  clauseIndex: number,
  patternIndex: number,
  pathIndex: number,
  fn: (props: PropertyBinding[]) => PropertyBinding[]
): QueryObject {
  return mapPattern(q, clauseIndex, patternIndex, (pattern) => {
    const element = pattern.path[pathIndex];
    if (element.kind === "node") {
      const nextElement: PathElement = {
        kind: "node",
        node: { ...element.node, properties: fn(element.node.properties) }
      };
      return { ...pattern, path: replaceAt(pattern.path, pathIndex, nextElement) };
    }
    const nextElement: PathElement = {
      kind: "relationship",
      relationship: { ...element.relationship, properties: fn(element.relationship.properties) }
    };
    return { ...pattern, path: replaceAt(pattern.path, pathIndex, nextElement) };
  });
}

export function addProperty(clauseIndex: number, patternIndex: number, pathIndex: number) {
  return (q: QueryObject): QueryObject =>
    updateElementProperties(q, clauseIndex, patternIndex, pathIndex, (props) => [
      ...props,
      newPropertyBinding()
    ]);
}

export function removeProperty(
  clauseIndex: number,
  patternIndex: number,
  pathIndex: number,
  propIndex: number
) {
  return (q: QueryObject): QueryObject =>
    updateElementProperties(q, clauseIndex, patternIndex, pathIndex, (props) =>
      removeAt(props, propIndex)
    );
}

export function updateProperty(
  clauseIndex: number,
  patternIndex: number,
  pathIndex: number,
  propIndex: number,
  patch: Partial<PropertyBinding>
) {
  return (q: QueryObject): QueryObject =>
    updateElementProperties(q, clauseIndex, patternIndex, pathIndex, (props) =>
      replaceAt(props, propIndex, { ...props[propIndex], ...patch })
    );
}

export function addSchemaProperty(clauseIndex: number, patternIndex: number, pathIndex: number) {
  return (q: QueryObject): QueryObject =>
    updateElementProperties(q, clauseIndex, patternIndex, pathIndex, (props) => [
      ...props,
      newSchemaProperty()
    ]);
}

// Patch a schema property's schematic_properties while enforcing the SCHEMA rules:
// is_key / is_label are single-select across the entity's properties, and turning
// either on forces is_required true.
export function updateSchematic(
  clauseIndex: number,
  patternIndex: number,
  pathIndex: number,
  propIndex: number,
  patch: Partial<SchematicProperties>
) {
  return (q: QueryObject): QueryObject =>
    updateElementProperties(q, clauseIndex, patternIndex, pathIndex, (props) =>
      props.map((prop, i) => {
        if (i === propIndex) {
          const base = prop.schematic_properties ?? newSchematicProperties();
          const next: SchematicProperties = { ...base, ...patch };
          if (next.is_key || next.is_label) next.is_required = true;
          return { ...prop, schematic_properties: next };
        }
        if (!prop.schematic_properties) return prop;
        if (patch.is_key !== true && patch.is_label !== true) return prop;
        return {
          ...prop,
          schematic_properties: {
            ...prop.schematic_properties,
            ...(patch.is_key === true ? { is_key: false } : {}),
            ...(patch.is_label === true ? { is_label: false } : {})
          }
        };
      })
    );
}

// ---- Parameters ----

export function addParameter() {
  return (q: QueryObject): QueryObject => ({ ...q, parameters: [...q.parameters, newParameter()] });
}

export function upsertParameter(param: Parameter) {
  return (q: QueryObject): QueryObject => {
    const existingIndex = q.parameters.findIndex((p) => p.name === param.name);
    if (existingIndex >= 0) {
      return { ...q, parameters: replaceAt(q.parameters, existingIndex, param) };
    }
    return { ...q, parameters: [...q.parameters, param] };
  };
}

export function removeParameter(name: string) {
  return (q: QueryObject): QueryObject => ({
    ...q,
    parameters: q.parameters.filter((p) => p.name !== name)
  });
}

export function updateParameterAt(index: number, patch: Partial<Parameter>) {
  return (q: QueryObject): QueryObject => ({
    ...q,
    parameters: replaceAt(q.parameters, index, { ...q.parameters[index], ...patch })
  });
}

// ---- RETURN ----

export function addReturnItem() {
  return (q: QueryObject): QueryObject => ({
    ...q,
    return: { distinct: q.return?.distinct ?? false, items: [...(q.return?.items ?? []), newReturnItem()] }
  });
}

export function updateReturnItem(index: number, patch: Partial<ReturnItem>) {
  return (q: QueryObject): QueryObject => {
    const items = q.return?.items ?? [];
    return {
      ...q,
      return: {
        distinct: q.return?.distinct ?? false,
        items: replaceAt(items, index, { ...items[index], ...patch })
      }
    };
  };
}

export function removeReturnItem(index: number) {
  return (q: QueryObject): QueryObject => ({
    ...q,
    return: { distinct: q.return?.distinct ?? false, items: removeAt(q.return?.items ?? [], index) }
  });
}

export function setReturnDistinct(distinct: boolean) {
  return (q: QueryObject): QueryObject => ({
    ...q,
    return: { distinct, items: q.return?.items ?? [] }
  });
}

// ---- ORDER BY / pagination ----

export function addOrderBy() {
  return (q: QueryObject): QueryObject => ({
    ...q,
    order_by: [...(q.order_by ?? []), { expression: "", direction: "ASC" }]
  });
}

export function updateOrderBy(index: number, patch: Partial<OrderByItem>) {
  return (q: QueryObject): QueryObject => {
    const items = q.order_by ?? [];
    return { ...q, order_by: replaceAt(items, index, { ...items[index], ...patch }) };
  };
}

export function removeOrderBy(index: number) {
  return (q: QueryObject): QueryObject => ({ ...q, order_by: removeAt(q.order_by ?? [], index) });
}

export function setSkip(value: QueryObject["skip"]) {
  return (q: QueryObject): QueryObject => ({ ...q, skip: value });
}

export function setLimit(value: QueryObject["limit"]) {
  return (q: QueryObject): QueryObject => ({ ...q, limit: value });
}

export function setReadTraversal(mode: QueryObject["read_traversal"]) {
  return (q: QueryObject): QueryObject => ({ ...q, read_traversal: mode });
}

/** Total node-kind path elements across every match clause/pattern. */
export function countMatchNodes(query: QueryObject): number {
  let count = 0;
  for (const clause of query.match ?? []) {
    for (const pattern of clause.patterns ?? []) {
      for (const element of pattern.path ?? []) {
        if (element.kind === "node") count += 1;
      }
    }
  }
  return count;
}

// ---- SET (update) ----

export function addSetItem() {
  return (q: QueryObject): QueryObject => ({ ...q, set: [...(q.set ?? []), { expression: "" }] });
}

export function updateSetItem(index: number, patch: Partial<SetItem>) {
  return (q: QueryObject): QueryObject => {
    const items = q.set ?? [];
    return { ...q, set: replaceAt(items, index, { ...items[index], ...patch }) };
  };
}

export function removeSetItem(index: number) {
  return (q: QueryObject): QueryObject => ({ ...q, set: removeAt(q.set ?? [], index) });
}

// ---- DELETE ----

export function setDeleteDetach(detach: boolean) {
  return (q: QueryObject): QueryObject => ({
    ...q,
    delete: { detach, targets: q.delete?.targets ?? [] }
  });
}

export function addDeleteTarget() {
  return (q: QueryObject): QueryObject => ({
    ...q,
    delete: { detach: q.delete?.detach ?? false, targets: [...(q.delete?.targets ?? []), ""] }
  });
}

export function setDeleteTargets(targets: string[]) {
  return (q: QueryObject): QueryObject => ({
    ...q,
    delete: { detach: q.delete?.detach ?? false, targets }
  });
}

export function updateDeleteTarget(index: number, value: string) {
  return (q: QueryObject): QueryObject => {
    const targets = q.delete?.targets ?? [];
    return {
      ...q,
      delete: { detach: q.delete?.detach ?? false, targets: replaceAt(targets, index, value) }
    };
  };
}

export function removeDeleteTarget(index: number) {
  return (q: QueryObject): QueryObject => ({
    ...q,
    delete: { detach: q.delete?.detach ?? false, targets: removeAt(q.delete?.targets ?? [], index) }
  });
}

// ---- WHERE (recursive) ----

// Address a nested where item by an array path of indices into `items`.
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
  } else if ("items" in target) {
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

export function ensureWhere() {
  return (q: QueryObject): QueryObject =>
    q.where ? q : { ...q, where: { operator: "AND", items: [] } };
}

export function setWhereOperator(path: number[], operator: "AND" | "OR") {
  return (q: QueryObject): QueryObject => {
    if (!q.where) return q;
    if (path.length === 0) return { ...q, where: { ...q.where, operator } };
    return {
      ...q,
      where: updateWhereItemAt(q.where, path, (item) =>
        "items" in item ? { ...item, operator } : item
      )
    };
  };
}

export function addWhereExpression(path: number[]) {
  return (q: QueryObject): QueryObject => {
    const where = q.where ?? { operator: "AND", items: [] };
    if (path.length === 0) {
      return { ...q, where: { ...where, items: [...where.items, { expression: "" }] } };
    }
    return {
      ...q,
      where: updateWhereItemAt(where, path, (item) =>
        "items" in item ? { ...item, items: [...item.items, { expression: "" }] } : item
      )
    };
  };
}

export function addWhereGroup(path: number[]) {
  return (q: QueryObject): QueryObject => {
    const where = q.where ?? { operator: "AND", items: [] };
    const group: WhereGroup = { operator: "AND", items: [] };
    if (path.length === 0) {
      return { ...q, where: { ...where, items: [...where.items, group] } };
    }
    return {
      ...q,
      where: updateWhereItemAt(where, path, (item) =>
        "items" in item ? { ...item, items: [...item.items, group] } : item
      )
    };
  };
}

export function updateWhereExpression(path: number[], expression: string) {
  return (q: QueryObject): QueryObject => {
    if (!q.where) return q;
    return {
      ...q,
      where: updateWhereItemAt(q.where, path, (item) =>
        "items" in item ? item : { expression }
      )
    };
  };
}

export function removeWhereItem(path: number[]) {
  return (q: QueryObject): QueryObject => {
    if (!q.where || path.length === 0) return q;
    return { ...q, where: updateWhereItemAt(q.where, path, () => null) };
  };
}

export function setOperationMeta(patch: Partial<Pick<QueryObject, "allow_duplicates" | "hide_duplicates">>) {
  return (q: QueryObject): QueryObject => ({ ...q, ...patch });
}

export type { Operation };
