/**
 * Layout helpers shared by the two D3 graph canvases:
 * results/GraphView (query result graphs) and builder/match/MatchGraph (the
 * MATCH design canvas). Each canvas keeps its own simulation wiring and visual
 * constants; only the pure geometry/ranking math lives here.
 */

import * as d3 from "d3";

/**
 * Assign each node a hierarchical "rank" (0 = top layer) so that edges tend to
 * point downward. Cycles are handled by ignoring back-edges (edges that point to
 * a node currently on the DFS stack), leaving a DAG to layer via longest-path.
 * Returns a map of node id -> rank, plus the maximum rank seen.
 */
export function computeNodeRanks(
  nodeIds: string[],
  links: { source: string; target: string }[]
): { ranks: Map<string, number>; maxRank: number } {
  const adjacency = new Map<string, string[]>();
  nodeIds.forEach((id) => adjacency.set(id, []));
  for (const link of links) {
    if (link.source === link.target) continue; // ignore self-loops for layering
    adjacency.get(link.source)?.push(link.target);
  }

  // Iterative DFS to flag back-edges (the edges that close a cycle).
  const UNVISITED = 0;
  const ON_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  nodeIds.forEach((id) => state.set(id, UNVISITED));
  const backEdges = new Set<string>();

  for (const startId of nodeIds) {
    if (state.get(startId) !== UNVISITED) continue;
    const stack: { id: string; childIdx: number }[] = [{ id: startId, childIdx: 0 }];
    state.set(startId, ON_STACK);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = adjacency.get(frame.id) ?? [];
      if (frame.childIdx >= children.length) {
        state.set(frame.id, DONE);
        stack.pop();
        continue;
      }
      const child = children[frame.childIdx];
      frame.childIdx += 1;
      const childState = state.get(child);
      if (childState === ON_STACK) {
        backEdges.add(`${frame.id}\u0000${child}`);
      } else if (childState === UNVISITED) {
        state.set(child, ON_STACK);
        stack.push({ id: child, childIdx: 0 });
      }
    }
  }

  // Build the acyclic edge set and in-degrees, then longest-path layer via Kahn.
  const dagAdjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  nodeIds.forEach((id) => {
    dagAdjacency.set(id, []);
    inDegree.set(id, 0);
  });
  for (const link of links) {
    if (link.source === link.target) continue;
    if (backEdges.has(`${link.source}\u0000${link.target}`)) continue;
    dagAdjacency.get(link.source)?.push(link.target);
    inDegree.set(link.target, (inDegree.get(link.target) ?? 0) + 1);
  }

  const ranks = new Map<string, number>();
  const queue: string[] = [];
  nodeIds.forEach((id) => {
    ranks.set(id, 0);
    if ((inDegree.get(id) ?? 0) === 0) queue.push(id);
  });

  let maxRank = 0;
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const currentRank = ranks.get(current) ?? 0;
    for (const next of dagAdjacency.get(current) ?? []) {
      const candidate = currentRank + 1;
      if (candidate > (ranks.get(next) ?? 0)) {
        ranks.set(next, candidate);
        if (candidate > maxRank) maxRank = candidate;
      }
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  return { ranks, maxRank };
}

export interface FitToViewOptions {
  /** Margin added around the graph's bounding box before scaling. */
  padding: number;
  /** Upper bound on the zoom-in scale so tiny graphs don't blow up. */
  maxScale: number;
  /** Fraction of the available viewport the graph may fill (e.g. 0.92). */
  fill: number;
}

/**
 * Pan/zoom the canvas so the root group's bounding box is centered and fully
 * visible. No-op while the graph has no measurable extent.
 */
export function fitGraphToView(
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  zoom: d3.ZoomBehavior<SVGSVGElement, unknown>,
  root: d3.Selection<SVGGElement, unknown, null, undefined>,
  width: number,
  height: number,
  animate: boolean,
  options: FitToViewOptions
) {
  const bounds = root.node()?.getBBox();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;

  const graphWidth = bounds.width + options.padding * 2;
  const graphHeight = bounds.height + options.padding * 2;
  const scale = Math.min(
    options.maxScale,
    options.fill * Math.min(width / graphWidth, height / graphHeight)
  );
  const tx = width / 2 - scale * (bounds.x + bounds.width / 2);
  const ty = height / 2 - scale * (bounds.y + bounds.height / 2);
  const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);

  if (animate) {
    svg.transition().duration(280).call(zoom.transform, transform);
  } else {
    svg.call(zoom.transform, transform);
  }
}

/**
 * Build a teardrop-shaped cubic Bézier loop that leaves and re-enters a node,
 * so self-relationships read as a visible arc instead of a zero-length line
 * hidden behind the node. `index` fans multiple loops out around the node and
 * grows them so they don't stack on top of one another. `radius` is the node
 * circle radius; `baseReach` is the loop extent for the first loop.
 */
export function selfLoopGeometry(
  x: number,
  y: number,
  index: number,
  radius: number,
  baseReach: number
): { path: string; labelX: number; labelY: number } {
  const baseAngle = -Math.PI / 2 + index * (Math.PI / 2.4);
  const spread = 0.6;
  const loopReach = baseReach + index * 16;

  const a1 = baseAngle - spread / 2;
  const a2 = baseAngle + spread / 2;

  const startX = x + radius * Math.cos(a1);
  const startY = y + radius * Math.sin(a1);
  const endX = x + radius * Math.cos(a2);
  const endY = y + radius * Math.sin(a2);

  const c1x = x + loopReach * Math.cos(a1);
  const c1y = y + loopReach * Math.sin(a1);
  const c2x = x + loopReach * Math.cos(a2);
  const c2y = y + loopReach * Math.sin(a2);

  const labelX = x + (loopReach + 12) * Math.cos(baseAngle);
  const labelY = y + (loopReach + 12) * Math.sin(baseAngle);

  return {
    path: `M${startX},${startY} C${c1x},${c1y} ${c2x},${c2y} ${endX},${endY}`,
    labelX,
    labelY
  };
}
