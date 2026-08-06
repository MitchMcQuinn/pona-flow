// Projection + serialization between the linear MATCH model (match[].patterns[].path[])
// and a graph view (nodes + edges). The QueryObject stays the source of truth: the
// graph is a derived projection, and every structural edit re-serializes the affected
// clause back into patterns/paths. Aliases become implicit — a node is *defined* at its
// first occurrence and referenced (bare `(var)`) everywhere else, which is exactly how
// self-relationships, branches, and cycles are expressed in Cypher.

import { newNodePattern, newPattern, newRelationshipPattern } from "./defaults";
import type {
  GraphNodeLabel,
  GraphPattern,
  MatchClause,
  NodePattern,
  PathElement,
  QueryObject,
  RelationshipPattern
} from "./types";

export interface MatchGraphAddress {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
}

export interface MatchGraphNode {
  /** Cypher variable — the entity's stable identity across patterns. */
  variable: string;
  attributiveLabel: string;
  /** The defining NodePattern (full config). */
  node: NodePattern;
  /** Address of the defining occurrence in the current query. */
  address: MatchGraphAddress;
}

export interface MatchGraphEdge {
  variable: string;
  attributiveLabel: string;
  /** Source node variable, in path order. */
  from: string;
  /** Target node variable, in path order. */
  to: string;
  /** Drawing direction; `incoming` flips the arrow (target -> source). */
  direction: "incoming" | "outgoing";
  /** The defining RelationshipPattern (full config). */
  relationship: RelationshipPattern;
  address: MatchGraphAddress;
}

export interface MatchGraph {
  clauseIndex: number;
  label: GraphNodeLabel;
  nodes: MatchGraphNode[];
  edges: MatchGraphEdge[];
}

function replaceAt<T>(arr: T[], index: number, value: T): T[] {
  return arr.map((item, i) => (i === index ? value : item));
}

function isReference(entity: { alias_mode?: string } | undefined): boolean {
  return entity?.alias_mode === "reference";
}

/**
 * Build a graph projection of a single MATCH clause. Node/relationship occurrences are
 * grouped by `variable`; the defining occurrence (non-reference, preferred) supplies the
 * config, while reference occurrences only contribute adjacency.
 */
export function projectMatchToGraph(query: QueryObject, clauseIndex: number): MatchGraph {
  const clause = query.match[clauseIndex];
  const nodeByVar = new Map<string, MatchGraphNode>();
  const edgeByVar = new Map<string, MatchGraphEdge>();
  const nodeOrder: string[] = [];
  const edgeOrder: string[] = [];

  const patterns = clause?.patterns ?? [];

  // Pass over every occurrence twice: first record defines, then fill in any
  // reference-only variables so isolated/forward references still appear.
  for (const wantDefine of [true, false]) {
    patterns.forEach((pattern, patternIndex) => {
      pattern.path.forEach((el, pathIndex) => {
        if (el.kind === "node") {
          const v = (el.node.variable ?? "").trim();
          if (!v) return;
          const ref = isReference(el.node);
          if (wantDefine === ref) return; // defines on first pass, references on second
          if (nodeByVar.has(v)) return;
          nodeByVar.set(v, {
            variable: v,
            attributiveLabel: el.node.attributive_label ?? "",
            node: el.node,
            address: { clauseIndex, patternIndex, pathIndex }
          });
          nodeOrder.push(v);
        } else {
          const rel = el.relationship;
          const v = (rel.variable ?? "").trim();
          if (!v) return;
          const ref = isReference(rel);
          if (wantDefine === ref) return;
          if (edgeByVar.has(v)) return;
          const prev = pattern.path[pathIndex - 1];
          const next = pattern.path[pathIndex + 1];
          const from = prev?.kind === "node" ? (prev.node.variable ?? "").trim() : "";
          const to = next?.kind === "node" ? (next.node.variable ?? "").trim() : "";
          if (!from || !to) return;
          edgeByVar.set(v, {
            variable: v,
            attributiveLabel: rel.attributive_label ?? "",
            from,
            to,
            direction: rel.direction === "incoming" ? "incoming" : "outgoing",
            relationship: rel,
            address: { clauseIndex, patternIndex, pathIndex }
          });
          edgeOrder.push(v);
        }
      });
    });
  }

  return {
    clauseIndex,
    label: clause?.label ?? "STEP",
    nodes: nodeOrder.map((v) => nodeByVar.get(v) as MatchGraphNode),
    edges: edgeOrder.map((v) => edgeByVar.get(v) as MatchGraphEdge)
  };
}

function defineNode(node: NodePattern): NodePattern {
  return { ...node, alias_mode: "define", alias_ref: undefined };
}

function referenceNode(graphNode: MatchGraphNode): NodePattern {
  return {
    variable: graphNode.variable,
    alias_mode: "reference",
    alias_ref: graphNode.variable,
    alias_locked: true,
    attributive_label: graphNode.attributiveLabel,
    properties: []
  };
}

function defineRelationship(rel: RelationshipPattern): RelationshipPattern {
  return { ...rel, alias_mode: "define", alias_ref: undefined };
}

/**
 * Re-derive a clause's patterns from a graph by decomposing the edge set into trails
 * (linear paths). Each entity is *defined* the first time it appears and *referenced*
 * thereafter. Nodes with no incident edges become single-node patterns.
 */
export function serializeMatchGraph(graph: MatchGraph, clause: MatchClause): MatchClause {
  const nodeByVar = new Map(graph.nodes.map((n) => [n.variable, n]));
  const edgeByVar = new Map(graph.edges.map((e) => [e.variable, e]));
  const remaining = new Set(graph.edges.map((e) => e.variable));

  // Outgoing adjacency in edge order (path order = from -> to).
  const outAdj = new Map<string, string[]>();
  graph.nodes.forEach((n) => outAdj.set(n.variable, []));
  graph.edges.forEach((e) => {
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from)?.push(e.variable);
  });

  const definedNodes = new Set<string>();
  const seenInPaths = new Set<string>();
  const patterns: GraphPattern[] = [];

  const nodeElement = (variable: string): PathElement => {
    const gn = nodeByVar.get(variable);
    seenInPaths.add(variable);
    if (gn && !definedNodes.has(variable)) {
      definedNodes.add(variable);
      return { kind: "node", node: defineNode(gn.node) };
    }
    // Reference: bare variable reusing the defined entity.
    return {
      kind: "node",
      node: gn ? referenceNode(gn) : { variable, alias_mode: "reference", alias_ref: variable, properties: [] }
    };
  };

  const firstRemainingOut = (variable: string): string | undefined =>
    (outAdj.get(variable) ?? []).find((ev) => remaining.has(ev));

  for (const startNode of graph.nodes) {
    while (firstRemainingOut(startNode.variable)) {
      const path: PathElement[] = [nodeElement(startNode.variable)];
      let currentVar = startNode.variable;
      let nextEdgeVar = firstRemainingOut(currentVar);
      while (nextEdgeVar) {
        remaining.delete(nextEdgeVar);
        const edge = edgeByVar.get(nextEdgeVar) as MatchGraphEdge;
        path.push({ kind: "relationship", relationship: defineRelationship(edge.relationship) });
        path.push(nodeElement(edge.to));
        currentVar = edge.to;
        nextEdgeVar = firstRemainingOut(currentVar);
      }
      patterns.push({ path });
    }
  }

  // Nodes with no incident edges (or only-incoming nodes already captured) → standalone.
  for (const n of graph.nodes) {
    if (!seenInPaths.has(n.variable)) {
      patterns.push({ path: [nodeElement(n.variable)] });
    }
  }

  // A clause must always carry at least one pattern with one node.
  if (patterns.length === 0) {
    patterns.push(newPattern());
  }

  return { ...clause, patterns };
}

function withSerializedClause(
  query: QueryObject,
  clauseIndex: number,
  mutate: (graph: MatchGraph) => void
): QueryObject {
  const clause = query.match[clauseIndex];
  if (!clause) return query;
  const graph = projectMatchToGraph(query, clauseIndex);
  mutate(graph);
  const nextClause = serializeMatchGraph(graph, clause);
  return { ...query, match: replaceAt(query.match, clauseIndex, nextClause) };
}

export type EdgeTarget =
  | { kind: "existing"; variable: string }
  | { kind: "new" };

/**
 * Add a relationship from `fromVariable` to an existing node (alias reference / self-loop /
 * cycle) or to a freshly created node. The hop-vs-branch distinction is resolved entirely
 * by serialization, so callers just describe the connection.
 */
export function addGraphEdge(clauseIndex: number, fromVariable: string, target: EdgeTarget) {
  return (query: QueryObject): QueryObject =>
    withSerializedClause(query, clauseIndex, (graph) => {
      let toVar: string;
      if (target.kind === "existing") {
        toVar = target.variable;
      } else {
        const node = newNodePattern();
        toVar = node.variable;
        graph.nodes.push({
          variable: toVar,
          attributiveLabel: "",
          node,
          address: { clauseIndex, patternIndex: 0, pathIndex: 0 }
        });
      }
      const rel = newRelationshipPattern();
      graph.edges.push({
        variable: rel.variable,
        attributiveLabel: "",
        from: fromVariable,
        to: toVar,
        direction: "outgoing",
        relationship: rel,
        address: { clauseIndex, patternIndex: 0, pathIndex: 0 }
      });
    });
}

/** Remove a node and every incident relationship, re-deriving the remaining patterns. */
export function removeGraphNode(clauseIndex: number, variable: string) {
  return (query: QueryObject): QueryObject =>
    withSerializedClause(query, clauseIndex, (graph) => {
      graph.nodes = graph.nodes.filter((n) => n.variable !== variable);
      graph.edges = graph.edges.filter((e) => e.from !== variable && e.to !== variable);
    });
}

/** Remove a relationship; both endpoint nodes are kept (an orphan becomes a standalone node). */
export function removeGraphEdge(clauseIndex: number, variable: string) {
  return (query: QueryObject): QueryObject =>
    withSerializedClause(query, clauseIndex, (graph) => {
      graph.edges = graph.edges.filter((e) => e.variable !== variable);
    });
}

/** Locate the defining address of a selected element by variable (post-projection). */
export function findElementAddress(
  query: QueryObject,
  clauseIndex: number,
  kind: "node" | "relationship",
  variable: string
): MatchGraphAddress | null {
  const graph = projectMatchToGraph(query, clauseIndex);
  if (kind === "node") {
    return graph.nodes.find((n) => n.variable === variable)?.address ?? null;
  }
  return graph.edges.find((e) => e.variable === variable)?.address ?? null;
}
