import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { GraphPayload } from "../../state/builder/types";
import {
  AFFECTED_STROKE,
  arrowAffectedMarkerUrl,
  arrowMarkerUrl,
  GRAPH_THEME,
  graphFilterId,
  graphAffectedGlowFilterUrl,
  graphGlowFilterUrl,
  installArrowMarkers,
  installEdgeMeshGradients,
  installGraphThemeDefs,
  installNodeLightGradients,
  installNodeShadowGradients,
  meshEdgeStrokeUrl,
  nodeAffectedFieldFillUrl,
  nodeGradientId,
  nodeLightFillUrl,
  nodeShadowFillUrl,
  setNodeLightCenter,
  setNodeLightGradientVariant,
  trimLineToCircles,
  ARROW_LINE_END_OFFSET,
  updateEdgeMeshGradient
} from "../../utils/graphTheme";
import { GraphNodeLightMotion, attachGraphNodeLightLoop } from "../../utils/graphMouseLight";
import { attachGraphBackgroundMotion } from "../../utils/graphBackgroundMotion";
import {
  computeNodeRanks,
  fitGraphToView,
  selfLoopGeometry as sharedSelfLoopGeometry
} from "../../utils/graphLayout";
import "./results.css";

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  group: string;
  collideRadius?: number;
  pointerScale?: number;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  id: string;
  label: string;
  loopIndex?: number;
  /** Position of this edge within its parallel group (0-based), used to fan multi-edges apart. */
  parallelIndex?: number;
  /** Total number of edges sharing this edge's unordered node pair. */
  parallelCount?: number;
}

const NODE_RADIUS = 14;

/** Stable slug for graph `data-testid` hooks (see App/ui/cypress/README.md). */
function graphTestIdSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function graphNodeTestId(group: string, label: string): string {
  return `graph-node-${group.toLowerCase()}-${graphTestIdSlug(label)}`;
}

export function graphRelTestId(label: string): string {
  return `graph-rel-${graphTestIdSlug(label)}`;
}

/** Loop extent of the first self-relationship arc (see utils/graphLayout). */
const SELF_LOOP_REACH = 44;

function selfLoopGeometry(
  x: number,
  y: number,
  index: number
): { path: string; labelX: number; labelY: number } {
  return sharedSelfLoopGeometry(x, y, index, NODE_RADIUS, SELF_LOOP_REACH);
}

/** Perpendicular separation between adjacent parallel edges, in px at the arc apex. */
const PARALLEL_EDGE_GAP = 22;

/**
 * Build a quadratic Bézier arc between two nodes that bows out perpendicular to the
 * chord, so multiple relationships between the same pair fan apart instead of stacking
 * on one straight line. `count === 1` (or `index` centered) collapses to a straight line.
 * Endpoints are trimmed to each node's circle edge (and pulled back at the target so the
 * arrow head sits past the stroke), mirroring `trimLineForRelationship`.
 */
function parallelEdgeGeometry(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius1: number,
  radius2: number,
  index: number,
  count: number
): { path: string; labelX: number; labelY: number; sx: number; sy: number; ex: number; ey: number } {
  const trimmed = trimLineToCircles(x1, y1, x2, y2, radius1, radius2);
  const dx = trimmed.x2 - trimmed.x1;
  const dy = trimmed.y2 - trimmed.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  const sx = trimmed.x1;
  const sy = trimmed.y1;
  const ex = trimmed.x2 - ux * ARROW_LINE_END_OFFSET;
  const ey = trimmed.y2 - uy * ARROW_LINE_END_OFFSET;

  // Spread edges symmetrically around the chord: e.g. count 3 -> offsets -1,0,+1.
  const offset = (index - (count - 1) / 2) * PARALLEL_EDGE_GAP;

  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  // Perpendicular to the chord (unit normal). The control point is offset by 2x so the
  // apex of the quadratic curve (at t=0.5) lands at the intended `offset` distance.
  const nx = -uy;
  const ny = ux;
  const cx = mx + nx * offset * 2;
  const cy = my + ny * offset * 2;

  // Stagger each label to a different point along its curve so parallel labels stack
  // visually (one above the next) instead of piling up at a shared midpoint. A lone edge
  // keeps its label centered. Siblings spread across a tight band biased slightly past
  // the midpoint (toward the target) so the topmost label clears the source node's own
  // label, which sits just below that node along the edge.
  const LABEL_BAND_CENTER = 0.54;
  const LABEL_BAND_HALF = 0.12;
  const labelT =
    count <= 1
      ? 0.5
      : LABEL_BAND_CENTER + LABEL_BAND_HALF * (2 * (index / (count - 1)) - 1);
  const mt = 1 - labelT;
  // Point on the quadratic Bézier at t=labelT: (1-t)^2*S + 2(1-t)t*C + t^2*E.
  const labelX = mt * mt * sx + 2 * mt * labelT * cx + labelT * labelT * ex;
  const labelY = mt * mt * sy + 2 * mt * labelT * cy + labelT * labelT * ey;

  return {
    path: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`,
    labelX,
    labelY,
    sx,
    sy,
    ex,
    ey
  };
}

function resolveNodeLabel(
  properties: Record<string, unknown>,
  labels: string[],
  fallback: string,
  displayLabel?: string
): string {
  if (typeof displayLabel === "string" && displayLabel.trim()) {
    return displayLabel.trim();
  }
  const isInstance = labels.includes("INSTANCE");
  if (!isInstance) {
    const al = properties.attributive_label ?? properties.name ?? properties.id;
    if (typeof al === "string" && al.trim()) return al;
  } else {
    const id = properties.id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return labels[0] ?? fallback.slice(0, 6);
}

/** Visible graph titles cap here so long display labels don't stretch the layout. */
const MAX_NODE_LABEL_CHARS = 20;

function abbreviateNodeLabel(label: string, maxChars = MAX_NODE_LABEL_CHARS): string {
  if (label.length <= maxChars) return label;
  return `${label.slice(0, maxChars - 1)}…`;
}

function resolveRelationshipLabel(properties: Record<string, unknown>, fallback: string): string {
  const al = properties.attributive_label;
  if (typeof al === "string" && al.trim()) return al;
  return fallback;
}

interface GraphViewProps {
  graph: GraphPayload;
  onClickNode?: (nodeId: string) => void;
  onClickRelationship?: (relId: string) => void;
  /** When set, the relationship is drawn with the mesh highlight ring (design-graph inspect). */
  highlightedRelationshipId?: string | null;
  /** Node ids (element_id) to paint red — steps whose backing operation drifted from its SCHEMA. */
  affectedNodeIds?: Set<string> | null;
  /** Relationship ids (element_id) to paint red — out-of-sync INSTANCE relationships. */
  affectedRelationshipIds?: Set<string> | null;
}

const FIT_OPTIONS = { padding: 40, maxScale: 2.5, fill: 0.92 };

export function GraphView({
  graph,
  onClickNode,
  onClickRelationship,
  highlightedRelationshipId = null,
  affectedNodeIds = null,
  affectedRelationshipIds = null
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Hold the click handlers in refs so changing their identity (parent re-renders, e.g. the
  // periodic Clerk token refresh) does not re-run the layout effect and re-shuffle the graph.
  // The simulation is rebuilt only when the graph data itself changes.
  const onClickNodeRef = useRef(onClickNode);
  const onClickRelationshipRef = useRef(onClickRelationship);
  const highlightedRelationshipIdRef = useRef(highlightedRelationshipId);
  const affectedNodeIdsRef = useRef(affectedNodeIds);
  const affectedRelationshipIdsRef = useRef(affectedRelationshipIds);
  const restyleRelationshipsRef = useRef<(() => void) | null>(null);
  const restyleNodesRef = useRef<(() => void) | null>(null);
  onClickNodeRef.current = onClickNode;
  onClickRelationshipRef.current = onClickRelationship;
  highlightedRelationshipIdRef.current = highlightedRelationshipId;
  affectedNodeIdsRef.current = affectedNodeIds;
  affectedRelationshipIdsRef.current = affectedRelationshipIds;

  useEffect(() => {
    const container = containerRef.current;
    const svgEl = svgRef.current;
    if (!container || !svgEl) return;

    let width = container.clientWidth;
    let height = container.clientHeight;
    if (width < 1 || height < 1) {
      width = 600;
      height = 400;
    }

    const nodes: SimNode[] = graph.nodes.map((n) => ({
      id: n.element_id,
      label: resolveNodeLabel(n.properties, n.labels, n.element_id, n.display_label),
      group: n.labels[0] ?? "NODE"
    }));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const links: SimLink[] = graph.relationships
      .filter((r) => r.start && r.end && nodeIds.has(r.start) && nodeIds.has(r.end))
      .map((r) => ({
        id: r.element_id,
        source: r.start as string,
        target: r.end as string,
        label: resolveRelationshipLabel(r.properties, r.type)
      }));

    // Self-relationships (source === target) can't be drawn as a straight line —
    // they'd collapse to a zero-length segment behind the node. Split them out so
    // they render as curved loops, and index each loop on a node so multiple
    // self-relationships fan out instead of overlapping.
    const normalLinks = links.filter((l) => l.source !== l.target);
    const selfLinks = links.filter((l) => l.source === l.target);
    const selfLoopCounts = new Map<string, number>();
    selfLinks.forEach((l) => {
      const nodeKey = l.source as string;
      const idx = selfLoopCounts.get(nodeKey) ?? 0;
      l.loopIndex = idx;
      selfLoopCounts.set(nodeKey, idx + 1);
    });

    // Multiple relationships between the same node pair would stack on one straight line.
    // Group them by the unordered pair (so A->B and B->A also separate) and record each
    // edge's index + group size so ticked() can fan them into distinct arcs.
    const parallelKey = (l: SimLink) => {
      const a = l.source as string;
      const b = l.target as string;
      return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    };
    const parallelGroups = new Map<string, SimLink[]>();
    normalLinks.forEach((l) => {
      const key = parallelKey(l);
      const group = parallelGroups.get(key);
      if (group) group.push(l);
      else parallelGroups.set(key, [l]);
    });
    parallelGroups.forEach((group) => {
      group.forEach((l, idx) => {
        l.parallelIndex = idx;
        l.parallelCount = group.length;
      });
    });

    const svg = d3
      .select(svgEl)
      .attr("viewBox", [0, 0, width, height].join(" "))
      .attr("width", "100%")
      .attr("height", "100%");
    svg.selectAll("*").remove();

    const defs = svg.append("defs");
    const root = svg.append("g");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on("zoom", (event) => root.attr("transform", event.transform.toString()));

    svg.call(zoom);

    const applyFit = (animate: boolean) => {
      const w = container.clientWidth || width;
      const h = container.clientHeight || height;
      if (w < 1 || h < 1) return;
      fitGraphToView(svg, zoom, root, w, h, animate, FIT_OPTIONS);
    };

    installGraphThemeDefs(defs);
    installEdgeMeshGradients(defs, "", links.map((l) => l.id));
    installNodeLightGradients(defs, "", nodes.map((n) => n.id));
    installNodeShadowGradients(defs, "", nodes.map((n) => n.id));
    installArrowMarkers(defs);

    const link = root
      .append("g")
      .attr("fill", "none")
      .attr("stroke", GRAPH_THEME.edge)
      .attr("stroke-opacity", GRAPH_THEME.edgeOpacity)
      .selectAll("path")
      .data(normalLinks)
      .join("path")
      .attr("stroke-width", 1.5)
      .attr("marker-end", arrowMarkerUrl(""));

    const selfLink = root
      .append("g")
      .attr("fill", "none")
      .attr("stroke", GRAPH_THEME.edge)
      .attr("stroke-opacity", GRAPH_THEME.edgeOpacity)
      .selectAll("path")
      .data(selfLinks)
      .join("path")
      .attr("stroke-width", 1.5)
      .attr("marker-end", arrowMarkerUrl("", true));

    // The visible edge stroke is only ~1.5px wide, so it's nearly impossible to click. Draw a
    // transparent, much wider stroke over each edge purely as a hit target; pointer-events="stroke"
    // makes it capture clicks even though it paints nothing. Mirrors the same geometry in ticked().
    const EDGE_HIT_WIDTH = 16;
    const linkHit = root
      .append("g")
      .attr("stroke", "transparent")
      .attr("fill", "none")
      .selectAll("path")
      .data(normalLinks)
      .join("path")
      .attr("data-testid", (d) => graphRelTestId(d.label))
      .attr("stroke-width", EDGE_HIT_WIDTH)
      .attr("pointer-events", "stroke")
      .each(function () {
        if (onClickRelationshipRef.current) d3.select(this).style("cursor", "pointer");
      })
      .on("click", (event, d) => {
        if (!onClickRelationshipRef.current) return;
        event.stopPropagation();
        onClickRelationshipRef.current(d.id);
      });

    const selfLinkHit = root
      .append("g")
      .attr("stroke", "transparent")
      .attr("fill", "none")
      .selectAll("path")
      .data(selfLinks)
      .join("path")
      .attr("data-testid", (d) => graphRelTestId(d.label))
      .attr("stroke-width", EDGE_HIT_WIDTH)
      .attr("pointer-events", "stroke")
      .each(function () {
        if (onClickRelationshipRef.current) d3.select(this).style("cursor", "pointer");
      })
      .on("click", (event, d) => {
        if (!onClickRelationshipRef.current) return;
        event.stopPropagation();
        onClickRelationshipRef.current(d.id);
      });

    const edgeLabelText = root
      .append("g")
      .selectAll("text")
      .data(normalLinks)
      .join("text")
      .text((d) => d.label)
      .attr("font-size", 9)
      .attr("fill", GRAPH_THEME.edgeLabel)
      .attr("text-anchor", "middle")
      .attr("stroke", GRAPH_THEME.labelHalo)
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .attr("stroke-linejoin", "round")
      .each(function () {
        if (onClickRelationshipRef.current) d3.select(this).style("cursor", "pointer");
      })
      .on("click", (event, d) => {
        if (!onClickRelationshipRef.current) return;
        event.stopPropagation();
        onClickRelationshipRef.current(d.id);
      });

    const selfLabelText = root
      .append("g")
      .selectAll("text")
      .data(selfLinks)
      .join("text")
      .text((d) => d.label)
      .attr("font-size", 9)
      .attr("fill", GRAPH_THEME.edgeLabel)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("stroke", GRAPH_THEME.labelHalo)
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .attr("stroke-linejoin", "round")
      .each(function () {
        if (onClickRelationshipRef.current) d3.select(this).style("cursor", "pointer");
      })
      .on("click", (event, d) => {
        if (!onClickRelationshipRef.current) return;
        event.stopPropagation();
        onClickRelationshipRef.current(d.id);
      });

    const node = root
      .append("g")
      .selectAll<SVGGElement, SimNode>("g")
      .data(nodes)
      .join("g")
      .attr("data-testid", (d) => graphNodeTestId(d.group, d.label))
      .call(
        d3
          .drag<SVGGElement, SimNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    node
      .append("circle")
      .attr("class", "graph-node-shadow")
      .attr("r", NODE_RADIUS * 1.12)
      .attr("fill", (d) => nodeShadowFillUrl("", d.id))
      .attr("stroke", "none")
      .attr("pointer-events", "none");

    const nodeCircle = node
      .append("circle")
      .attr("r", NODE_RADIUS)
      .attr("fill", (d) => `url(#${nodeGradientId(d.group)})`)
      .attr("stroke", GRAPH_THEME.nodeStroke)
      .attr("stroke-width", 0)
      .attr("filter", `url(#${graphFilterId("", "graph-node-elevate")})`)
      .each(function () {
        if (onClickNodeRef.current) d3.select(this).style("cursor", "pointer");
      })
      .on("click", (event, d) => {
        if (!onClickNodeRef.current) return;
        event.stopPropagation();
        onClickNodeRef.current(d.id);
      });

    node
      .append("circle")
      .attr("class", "graph-node-light")
      .attr("r", NODE_RADIUS)
      .attr("fill", (d) => nodeLightFillUrl("", d.id))
      .attr("stroke", "none")
      .attr("pointer-events", "none");

    const lightMotion = new GraphNodeLightMotion();
    lightMotion.syncNodeIds(nodes.map((n) => n.id));

    node
      .append("title")
      .text((d) => `${d.group}: ${d.label}`);

    const LABEL_PADDING = 14;

    node
      .append("text")
      .text((d) => abbreviateNodeLabel(d.label))
      .attr("x", 0)
      .attr("y", NODE_RADIUS + 14)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("fill", GRAPH_THEME.nodeLabel)
      .attr("stroke", GRAPH_THEME.labelHalo)
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .attr("stroke-linejoin", "round");

    // Measure rendered label widths so the collision force accounts for the text,
    // not just the circle. This spreads wide-labeled nodes apart horizontally so
    // labels stop overlapping.
    node.each(function (d) {
      const textEl = d3.select<SVGGElement, SimNode>(this).select<SVGTextElement>("text").node();
      const labelWidth = textEl?.getBBox().width ?? 0;
      d.collideRadius = Math.max(NODE_RADIUS + 10, labelWidth / 2 + LABEL_PADDING);
    });

    const applyRelationshipHighlight = () => {
      const highlighted = highlightedRelationshipIdRef.current;
      const affectedRels = affectedRelationshipIdsRef.current;
      const isHighlighted = (id: string) => highlighted === id;
      const isAffected = (id: string) => !!affectedRels && affectedRels.has(id);
      // Affected (out-of-sync INSTANCE) edges win over inspect highlight: solid red stroke and
      // red arrow head. Skip the node glow filter on lines — its bbox is too thin and clips the
      // marker-end arrow (explicit red markers are installed in installArrowMarkers).
      const strokeFor = (id: string) =>
        isAffected(id)
          ? AFFECTED_STROKE
          : isHighlighted(id)
            ? meshEdgeStrokeUrl("", id)
            : GRAPH_THEME.edge;
      const widthFor = (id: string) => (isAffected(id) || isHighlighted(id) ? 3 : 1.5);
      const opacityFor = (id: string) =>
        isAffected(id) || isHighlighted(id) ? 1 : GRAPH_THEME.edgeOpacity;
      const filterFor = (id: string) =>
        isAffected(id)
          ? null
          : isHighlighted(id)
            ? graphGlowFilterUrl("")
            : null;
      const markerFor = (id: string, selfLoop: boolean) =>
        isAffected(id) ? arrowAffectedMarkerUrl("", selfLoop) : arrowMarkerUrl("", selfLoop);
      link
        .attr("stroke", (d) => strokeFor(d.id))
        .attr("stroke-width", (d) => widthFor(d.id))
        .attr("stroke-opacity", (d) => opacityFor(d.id))
        .attr("filter", (d) => filterFor(d.id))
        .attr("marker-end", (d) => markerFor(d.id, false));
      selfLink
        .attr("stroke", (d) => strokeFor(d.id))
        .attr("stroke-width", (d) => widthFor(d.id))
        .attr("stroke-opacity", (d) => opacityFor(d.id))
        .attr("filter", (d) => filterFor(d.id))
        .attr("marker-end", (d) => markerFor(d.id, true));
    };
    restyleRelationshipsRef.current = applyRelationshipHighlight;
    applyRelationshipHighlight();

    // Restyle a node circle without rebuilding the simulation (mirrors the relationship highlight):
    // affected steps get a full red treatment — mesh fill, mouse spotlight, ring, and glow.
    const applyNodeHighlight = () => {
      const affected = affectedNodeIdsRef.current;
      const isAffected = (id: string) => !!affected && affected.has(id);
      nodeCircle
        .attr("fill", (d) =>
          isAffected(d.id) ? nodeAffectedFieldFillUrl("") : `url(#${nodeGradientId(d.group)})`
        )
        .attr("stroke", (d) => (isAffected(d.id) ? AFFECTED_STROKE : GRAPH_THEME.nodeStroke))
        .attr("stroke-width", (d) => (isAffected(d.id) ? 2.5 : 0))
        .attr("filter", (d) =>
          isAffected(d.id)
            ? graphAffectedGlowFilterUrl("")
            : `url(#${graphFilterId("", "graph-node-elevate")})`
        );
      for (const n of nodes) {
        setNodeLightGradientVariant(defs, "", n.id, isAffected(n.id) ? "affected" : "default");
      }
    };
    restyleNodesRef.current = applyNodeHighlight;
    applyNodeHighlight();

    // Bias the layout so relationships generally flow downward: each node is
    // pulled toward a vertical layer derived from its position in the hierarchy.
    // Cycles/loops are tolerated (back-edges are ignored when ranking), and the
    // pull is gentle so the repulsion/collision forces still spread nodes out
    // horizontally instead of crowding them into rigid rows.
    const LAYER_GAP = 110;
    const { ranks, maxRank } = computeNodeRanks(
      nodes.map((n) => n.id),
      links.map((l) => ({ source: l.source as string, target: l.target as string }))
    );
    const layerY = (rank: number) => height / 2 + (rank - maxRank / 2) * LAYER_GAP;

    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(90)
      )
      .force("charge", d3.forceManyBody().strength(-260))
      .force("x", d3.forceX<SimNode>(width / 2).strength(0.05))
      .force(
        "y",
        d3
          .forceY<SimNode>((d) => layerY(ranks.get(d.id) ?? 0))
          .strength(0.45)
      )
      .force(
        "collide",
        d3.forceCollide<SimNode>().radius((d) => d.collideRadius ?? 24)
      );

    // Geometry for a normal (non-self) edge, fanned out by its position in its parallel group.
    const normalEdgeGeom = (d: SimLink) => {
      const sx = (d.source as SimNode).x ?? 0;
      const sy = (d.source as SimNode).y ?? 0;
      const tx = (d.target as SimNode).x ?? 0;
      const ty = (d.target as SimNode).y ?? 0;
      return parallelEdgeGeometry(
        sx,
        sy,
        tx,
        ty,
        NODE_RADIUS,
        NODE_RADIUS,
        d.parallelIndex ?? 0,
        d.parallelCount ?? 1
      );
    };

    const ticked = () => {
      link.attr("d", (d) => normalEdgeGeom(d).path).each(function (d) {
        const geom = normalEdgeGeom(d);
        // The mesh highlight gradient is linear; align it with the arc's chord endpoints.
        updateEdgeMeshGradient(defs, "", d.id, geom.sx, geom.sy, geom.ex, geom.ey);
      });
      linkHit.attr("d", (d) => normalEdgeGeom(d).path);
      edgeLabelText
        .attr("x", (d) => normalEdgeGeom(d).labelX)
        .attr("y", (d) => normalEdgeGeom(d).labelY);
      selfLink.attr("d", (d) => {
        const n = d.source as SimNode;
        return selfLoopGeometry(n.x ?? 0, n.y ?? 0, d.loopIndex ?? 0).path;
      });
      selfLinkHit.attr("d", (d) => {
        const n = d.source as SimNode;
        return selfLoopGeometry(n.x ?? 0, n.y ?? 0, d.loopIndex ?? 0).path;
      });
      selfLinks.forEach((d) => {
        const n = d.source as SimNode;
        const geom = selfLoopGeometry(n.x ?? 0, n.y ?? 0, d.loopIndex ?? 0);
        updateEdgeMeshGradient(defs, "", d.id, n.x ?? 0, n.y ?? 0, geom.labelX, geom.labelY);
      });
      selfLabelText
        .attr("x", (d) => {
          const n = d.source as SimNode;
          return selfLoopGeometry(n.x ?? 0, n.y ?? 0, d.loopIndex ?? 0).labelX;
        })
        .attr("y", (d) => {
          const n = d.source as SimNode;
          return selfLoopGeometry(n.x ?? 0, n.y ?? 0, d.loopIndex ?? 0).labelY;
        });
      updateNodeTransforms();
    };

    const updateNodeTransforms = () => {
      node.attr("transform", (d) => {
        const s = d.pointerScale ?? 1;
        return `translate(${d.x ?? 0},${d.y ?? 0}) scale(${s})`;
      });
    };

    const destroyMouseLight = attachGraphNodeLightLoop(
      svgEl,
      () => d3.zoomTransform(svgEl),
      lightMotion,
      () => nodes.map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 })),
      NODE_RADIUS,
      (nodeId, cx, cy, scale) => {
        setNodeLightCenter(defs, "", nodeId, cx, cy);
        const n = nodes.find((node) => node.id === nodeId);
        if (n) n.pointerScale = scale;
      },
      updateNodeTransforms
    );

    const destroyBackgroundMotion = attachGraphBackgroundMotion(container);

    // Settle the layout synchronously (off-screen) before the first paint so the graph appears
    // already laid out and fitted instead of visibly flying around and panning into place. Drag
    // still re-energizes the simulation via alphaTarget().restart(), so it stays interactive.
    simulation.stop();
    const settleTicks = Math.ceil(
      Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())
    );
    for (let i = 0; i < settleTicks; i += 1) simulation.tick();
    simulation.on("tick", ticked);
    ticked();
    applyFit(false);

    // Coalesce resize bursts (animated panel transitions, drag-resizing a split pane) into a
    // single re-fit per frame so we measure once the new size has settled instead of thrashing
    // getBBox()/zoom transforms on every intermediate ResizeObserver entry.
    let resizeFrame = 0;
    let lastResizeW = width;
    let lastResizeH = height;
    let pendingSettleRefit = false;

    const handleResize = () => {
      resizeFrame = 0;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w < 1 || h < 1) return;
      if (w === lastResizeW && h === lastResizeH) return;
      lastResizeW = w;
      lastResizeH = h;

      svg.attr("viewBox", [0, 0, w, h].join(" "));
      // Keep the centering forces in sync with the new size so a later drag re-settles around
      // the new center rather than the original one.
      simulation.force("x", d3.forceX<SimNode>(w / 2).strength(0.05));
      simulation.force(
        "y",
        d3.forceY<SimNode>((d) => h / 2 + ((ranks.get(d.id) ?? 0) - maxRank / 2) * LAYER_GAP).strength(0.45)
      );

      // Recenter + rescale the existing layout to fit the new viewport. If the simulation is
      // still moving nodes (e.g. mid-drag settle), defer the fit to a one-shot on the next tick
      // so we don't fit to positions that are about to change.
      if (simulation.alpha() <= simulation.alphaMin()) {
        applyFit(false);
      } else {
        pendingSettleRefit = true;
      }
    };

    const onSettleTick = () => {
      if (!pendingSettleRefit) return;
      if (simulation.alpha() <= simulation.alphaMin()) {
        pendingSettleRefit = false;
        applyFit(false);
      }
    };
    simulation.on("tick.fit", onSettleTick);

    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(handleResize);
    });
    resizeObserver.observe(container);

    return () => {
      destroyMouseLight();
      destroyBackgroundMotion();
      resizeObserver.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      simulation.on("tick.fit", null);
      simulation.stop();
      restyleRelationshipsRef.current = null;
      restyleNodesRef.current = null;
    };
    // Rebuild only when the graph data changes; click handlers are read via refs so their
    // identity churning on parent re-renders never re-runs the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    restyleRelationshipsRef.current?.();
  }, [highlightedRelationshipId, affectedRelationshipIds]);

  useEffect(() => {
    restyleNodesRef.current?.();
  }, [affectedNodeIds]);

  return (
    <div ref={containerRef} className="graphViewContainer" data-testid="graph-view-container">
      <svg ref={svgRef} />
    </div>
  );
}
