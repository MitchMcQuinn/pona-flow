import type { Selection } from "d3";

/** SVG palette aligned with the dark neumorphic UI (mesh accents on interactive state). */
export const GRAPH_THEME = {
  edge: "#5c6070",
  edgeOpacity: 0.55,
  edgeSelected: "#818cf8",
  edgeLabel: "#8a8d96",
  labelHalo: "#121214",
  nodeLabel: "#ecedf2",
  /** Default nodes: no visible ring — depth comes from the black shadow filter only. */
  nodeStroke: "none"
} as const;

const MESH_STOPS = ["#6366f1", "#8b5cf6", "#d946ef", "#06b6d4"];

/** Matches `.builderSegmentToggle button.active` base tones. */
const FIELD_RAISE = "#28282e";
const FIELD_PANEL2 = "#151518";

/**
 * Four overlapping radials — mesh palette at different anchors (mirrors `--mesh-soft` layout
 * plus a violet blob so all `--mesh` hues blend, not a single diagonal sweep).
 */
const FIELD_MESH_BLOBS = [
  { suffix: "indigo", cx: 0, cy: 0, r: 0.92, color: MESH_STOPS[0], opacity: 0.62, fade: 58 },
  { suffix: "violet", cx: 0.68, cy: 0.42, r: 0.78, color: MESH_STOPS[1], opacity: 0.55, fade: 52 },
  { suffix: "magenta", cx: 1, cy: 0, r: 0.82, color: MESH_STOPS[2], opacity: 0.1, fade: 55 },
  { suffix: "cyan", cx: 1, cy: 1.15, r: 1.12, color: MESH_STOPS[3], opacity: 0.62, fade: 68 }
] as const;

export const NODE_FIELD_FILL_ID = "graph-node-field";
export const NODE_AFFECTED_FIELD_FILL_ID = "graph-node-field-affected";
export const PORT_FILL_ID = "graph-port-fill";

/** Red mesh palette for schema-drift STEP nodes (matches suspension chrome). */
const AFFECTED_FIELD_MESH_BLOBS = [
  { suffix: "crimson", cx: 0, cy: 0, r: 0.92, color: "#b91c1c", opacity: 0.58, fade: 58 },
  { suffix: "red", cx: 0.68, cy: 0.42, r: 0.78, color: "#ef4444", opacity: 0.52, fade: 52 },
  { suffix: "rose", cx: 1, cy: 0, r: 0.82, color: "#fb7185", opacity: 0.14, fade: 55 },
  { suffix: "light", cx: 1, cy: 1.15, r: 1.12, color: "#fca5a5", opacity: 0.5, fade: 68 }
] as const;

const AFFECTED_LIGHT_COLOR = "#ef4444";

export function nodeGradientId(_group?: string): string {
  return NODE_FIELD_FILL_ID;
}

export function portFillUrl(idPrefix: string): string {
  return `url(#${idPrefix}${PORT_FILL_ID})`;
}

function appendMeshGradientStops(
  grad: Selection<SVGLinearGradientElement, unknown, null, undefined>,
  offsetPercents?: number[]
) {
  const offsets =
    offsetPercents ?? MESH_STOPS.map((_, i) => (i / (MESH_STOPS.length - 1)) * 100);
  MESH_STOPS.forEach((color, i) => {
    grad
      .append("stop")
      .attr("offset", `${offsets[i]}%`)
      .attr("stop-color", color);
  });
}

function installMeshRadialBlob(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  id: string,
  cx: number,
  cy: number,
  r: number,
  color: string,
  opacity: number,
  fadePct: number
) {
  const grad = defs
    .append("radialGradient")
    .attr("id", id)
    .attr("gradientUnits", "objectBoundingBox")
    .attr("cx", cx)
    .attr("cy", cy)
    .attr("r", r);
  grad
    .append("stop")
    .attr("offset", "0%")
    .attr("stop-color", color)
    .attr("stop-opacity", opacity);
  grad
    .append("stop")
    .attr("offset", `${fadePct}%`)
    .attr("stop-color", color)
    .attr("stop-opacity", 0);
}

/** Raised panel base + layered mesh radials — organic multi-blob blend, not a linear sweep. */
function installNodeFieldFills(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  p: (name: string) => string
) {
  const baseId = p("graph-node-field-base");
  const base = defs
    .append("linearGradient")
    .attr("id", baseId)
    .attr("gradientUnits", "objectBoundingBox")
    .attr("x1", "0%")
    .attr("y1", "0%")
    .attr("x2", "100%")
    .attr("y2", "100%");
  base.append("stop").attr("offset", "0%").attr("stop-color", FIELD_RAISE);
  base.append("stop").attr("offset", "100%").attr("stop-color", FIELD_PANEL2);

  for (const blob of FIELD_MESH_BLOBS) {
    installMeshRadialBlob(
      defs,
      p(`graph-node-field-blob-${blob.suffix}`),
      blob.cx,
      blob.cy,
      blob.r,
      blob.color,
      blob.opacity,
      blob.fade
    );
  }

  const pattern = defs
    .append("pattern")
    .attr("id", p(NODE_FIELD_FILL_ID))
    .attr("patternContentUnits", "objectBoundingBox")
    .attr("width", 1)
    .attr("height", 1);

  pattern
    .append("rect")
    .attr("width", 1)
    .attr("height", 1)
    .attr("fill", `url(#${baseId})`);

  for (const blob of FIELD_MESH_BLOBS) {
    pattern
      .append("rect")
      .attr("width", 1)
      .attr("height", 1)
      .attr("fill", `url(#${p(`graph-node-field-blob-${blob.suffix}`)})`);
  }
}

/** Raised panel + red mesh radials for schema-drift STEP nodes. */
function installAffectedNodeFieldFills(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  p: (name: string) => string
) {
  const baseId = p("graph-node-field-affected-base");
  const base = defs
    .append("linearGradient")
    .attr("id", baseId)
    .attr("gradientUnits", "objectBoundingBox")
    .attr("x1", "0%")
    .attr("y1", "0%")
    .attr("x2", "100%")
    .attr("y2", "100%");
  base.append("stop").attr("offset", "0%").attr("stop-color", "#2a1518");
  base.append("stop").attr("offset", "100%").attr("stop-color", "#1a0c0e");

  for (const blob of AFFECTED_FIELD_MESH_BLOBS) {
    installMeshRadialBlob(
      defs,
      p(`graph-node-field-affected-blob-${blob.suffix}`),
      blob.cx,
      blob.cy,
      blob.r,
      blob.color,
      blob.opacity,
      blob.fade
    );
  }

  const pattern = defs
    .append("pattern")
    .attr("id", p(NODE_AFFECTED_FIELD_FILL_ID))
    .attr("patternContentUnits", "objectBoundingBox")
    .attr("width", 1)
    .attr("height", 1);

  pattern
    .append("rect")
    .attr("width", 1)
    .attr("height", 1)
    .attr("fill", `url(#${baseId})`);

  for (const blob of AFFECTED_FIELD_MESH_BLOBS) {
    pattern
      .append("rect")
      .attr("width", 1)
      .attr("height", 1)
      .attr("fill", `url(#${p(`graph-node-field-affected-blob-${blob.suffix}`)})`);
  }
}

/** Small mesh radial for the builder relationship drag handle. */
function installPortFill(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  p: (name: string) => string
) {
  const grad = defs
    .append("radialGradient")
    .attr("id", p(PORT_FILL_ID))
    .attr("gradientUnits", "objectBoundingBox")
    .attr("cx", "32%")
    .attr("cy", "28%")
    .attr("r", "78%")
    .attr("fx", "32%")
    .attr("fy", "28%");
  grad.append("stop").attr("offset", "0%").attr("stop-color", "#e0e7ff");
  grad.append("stop").attr("offset", "42%").attr("stop-color", MESH_STOPS[1]);
  grad.append("stop").attr("offset", "100%").attr("stop-color", MESH_STOPS[0]).attr("stop-opacity", 0.92);
}

/** Neo4j element ids may contain `:` — invalid in CSS `#id` selectors. */
export function safeDomId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function meshEdgeDomId(idPrefix: string, edgeId: string): string {
  return `${idPrefix}mesh-edge-${safeDomId(edgeId)}`;
}

export function nodeLightDomId(idPrefix: string, nodeId: string): string {
  return `${idPrefix}graph-node-light-${safeDomId(nodeId)}`;
}

export function nodeLightFillUrl(idPrefix: string, nodeId: string): string {
  return `url(#${nodeLightDomId(idPrefix, nodeId)})`;
}

/** Swap a per-node mouse-follow spotlight between default violet and suspension red. */
export function setNodeLightGradientVariant(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  idPrefix: string,
  nodeId: string,
  variant: "default" | "affected"
) {
  const color = variant === "affected" ? AFFECTED_LIGHT_COLOR : MESH_STOPS[1];
  defs.select(`[id="${nodeLightDomId(idPrefix, nodeId)}"]`).selectAll("stop").attr("stop-color", color);
}

export function nodeAffectedFieldFillUrl(idPrefix: string): string {
  return `url(#${idPrefix}${NODE_AFFECTED_FIELD_FILL_ID})`;
}

export function nodeShadowDomId(idPrefix: string, nodeId: string): string {
  return `${idPrefix}graph-node-shadow-${safeDomId(nodeId)}`;
}

export function nodeShadowFillUrl(idPrefix: string, nodeId: string): string {
  return `url(#${nodeShadowDomId(idPrefix, nodeId)})`;
}

/** Per-node violet spotlight — blob center shifts toward the cursor (objectBoundingBox). */
export function installNodeLightGradients(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  idPrefix: string,
  nodeIds: string[]
) {
  for (const nodeId of nodeIds) {
    const grad = defs
      .append("radialGradient")
      .attr("id", nodeLightDomId(idPrefix, nodeId))
      .attr("gradientUnits", "objectBoundingBox")
      .attr("cx", 0.5)
      .attr("cy", 0.5)
      .attr("r", 0.78);
    grad
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", MESH_STOPS[1])
      .attr("stop-opacity", 0.72);
    grad
      .append("stop")
      .attr("offset", "45%")
      .attr("stop-color", MESH_STOPS[1])
      .attr("stop-opacity", 0.22);
    grad
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", MESH_STOPS[1])
      .attr("stop-opacity", 0);
  }
}

/** Inverse-moving black radial — dark core shifts opposite the violet spotlight. */
export function installNodeShadowGradients(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  idPrefix: string,
  nodeIds: string[]
) {
  for (const nodeId of nodeIds) {
    const grad = defs
      .append("radialGradient")
      .attr("id", nodeShadowDomId(idPrefix, nodeId))
      .attr("gradientUnits", "objectBoundingBox")
      .attr("cx", 0.5)
      .attr("cy", 0.5)
      .attr("r", 0.92);
    grad
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", "#000000")
      .attr("stop-opacity", 0.52);
    grad
      .append("stop")
      .attr("offset", "48%")
      .attr("stop-color", "#000000")
      .attr("stop-opacity", 0.16);
    grad
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", "#000000")
      .attr("stop-opacity", 0);
  }
}

export function computeNodeLightCenter(
  nodeX: number,
  nodeY: number,
  lightX: number,
  lightY: number,
  nodeRadius: number
): { cx: number; cy: number } {
  const dx = lightX - nodeX;
  const dy = lightY - nodeY;
  const maxPull = 0.42;
  const scale = maxPull / nodeRadius;
  return {
    cx: Math.max(0.06, Math.min(0.94, 0.5 + dx * scale)),
    cy: Math.max(0.06, Math.min(0.94, 0.5 + dy * scale))
  };
}

export function inverseNodeLightCenter(cx: number, cy: number): { cx: number; cy: number } {
  return { cx: 1 - cx, cy: 1 - cy };
}

export function setNodeLightCenter(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  idPrefix: string,
  nodeId: string,
  cx: number,
  cy: number
) {
  defs
    .select(`[id="${nodeLightDomId(idPrefix, nodeId)}"]`)
    .attr("cx", cx)
    .attr("cy", cy)
    .attr("r", 0.82);
  const shadow = inverseNodeLightCenter(cx, cy);
  defs
    .select(`[id="${nodeShadowDomId(idPrefix, nodeId)}"]`)
    .attr("cx", shadow.cx)
    .attr("cy", shadow.cy)
    .attr("r", 0.92);
}

/**
 * Shared SVG defs: neumorphic node fills, mesh selection stroke, elevation + glow filters.
 */
export function installGraphThemeDefs(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  idPrefix = ""
) {
  const p = (name: string) => `${idPrefix}${name}`;

  // Black drop-shadow only — no light rim (reads as depth, not a grey border).
  const elevate = defs
    .append("filter")
    .attr("id", p("graph-node-elevate"))
    .attr("x", "-70%")
    .attr("y", "-70%")
    .attr("width", "240%")
    .attr("height", "240%");
  elevate
    .append("feDropShadow")
    .attr("dx", 2)
    .attr("dy", 4)
    .attr("stdDeviation", 3)
    .attr("flood-color", "#000000")
    .attr("flood-opacity", 0.85);
  elevate
    .append("feDropShadow")
    .attr("dx", 1)
    .attr("dy", 2)
    .attr("stdDeviation", 1.5)
    .attr("flood-color", "#000000")
    .attr("flood-opacity", 0.45);

  const glow = defs
    .append("filter")
    .attr("id", p("graph-node-glow"))
    .attr("x", "-80%")
    .attr("y", "-80%")
    .attr("width", "260%")
    .attr("height", "260%");
  glow
    .append("feDropShadow")
    .attr("dx", 0)
    .attr("dy", 0)
    .attr("stdDeviation", 4)
    .attr("flood-color", "#8b5cf6")
    .attr("flood-opacity", 0.45);
  glow
    .append("feDropShadow")
    .attr("dx", 0)
    .attr("dy", 0)
    .attr("stdDeviation", 8)
    .attr("flood-color", "#06b6d4")
    .attr("flood-opacity", 0.2);

  // Red halo for schema-drift STEP nodes (matches nav .sequenceItem.suspended).
  const affectedGlow = defs
    .append("filter")
    .attr("id", p("graph-node-affected-glow"))
    .attr("x", "-80%")
    .attr("y", "-80%")
    .attr("width", "260%")
    .attr("height", "260%");
  affectedGlow
    .append("feDropShadow")
    .attr("dx", 0)
    .attr("dy", 0)
    .attr("stdDeviation", 4)
    .attr("flood-color", "#ef4444")
    .attr("flood-opacity", 0.5);
  affectedGlow
    .append("feDropShadow")
    .attr("dx", 0)
    .attr("dy", 0)
    .attr("stdDeviation", 10)
    .attr("flood-color", "#f87171")
    .attr("flood-opacity", 0.28);

  installNodeFieldFills(defs, p);
  installAffectedNodeFieldFills(defs, p);
  installPortFill(defs, p);

  const mesh = defs
    .append("linearGradient")
    .attr("id", p("graph-mesh-stroke"))
    .attr("gradientUnits", "objectBoundingBox")
    .attr("x1", "0%")
    .attr("y1", "0%")
    .attr("x2", "100%")
    .attr("y2", "100%");
  appendMeshGradientStops(mesh);
}

/** Per-edge mesh gradients (userSpaceOnUse) so strokes read along each line/path. */
export function installEdgeMeshGradients(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  idPrefix: string,
  edgeIds: string[]
) {
  for (const edgeId of edgeIds) {
    const grad = defs
      .append("linearGradient")
      .attr("id", meshEdgeDomId(idPrefix, edgeId))
      .attr("gradientUnits", "userSpaceOnUse");
    appendMeshGradientStops(grad);
  }
}

export function updateEdgeMeshGradient(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  idPrefix: string,
  edgeId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  defs
    .select(`[id="${meshEdgeDomId(idPrefix, edgeId)}"]`)
    .attr("x1", x1)
    .attr("y1", y1)
    .attr("x2", x2)
    .attr("y2", y2);
}

export function meshEdgeStrokeUrl(idPrefix: string, edgeId: string): string {
  return `url(#${meshEdgeDomId(idPrefix, edgeId)})`;
}

export function meshStrokeUrl(idPrefix: string): string {
  return `url(#${idPrefix}graph-mesh-stroke)`;
}

export function graphFilterId(idPrefix: string, name: "graph-node-elevate" | "graph-node-glow"): string {
  return `${idPrefix}${name}`;
}

export function graphGlowFilterUrl(idPrefix: string): string {
  return `url(#${graphFilterId(idPrefix, "graph-node-glow")})`;
}

export function graphAffectedGlowFilterUrl(idPrefix: string): string {
  return `url(#${idPrefix}graph-node-affected-glow)`;
}

/** Chevron tip sits at x=10 in the marker viewBox; refX anchors the body center. */
export const ARROW_HEAD_TIP = 10;
export const ARROW_HEAD_REF = 5;
/** Pull the stroke end back from the node edge so the line sits under the head, not the tip. */
export const ARROW_LINE_END_OFFSET = 6;

/** Trim a center-to-center segment so it stops at each node's circle edge. */
export function trimLineToCircles(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius1: number,
  radius2: number
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < radius1 + radius2 + 1) {
    return { x1, y1, x2, y2 };
  }
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: x1 + ux * radius1,
    y1: y1 + uy * radius1,
    x2: x2 - ux * radius2,
    y2: y2 - uy * radius2
  };
}

/** Trim to node edges, then shorten the target end so the arrow tip sits past the line. */
export function trimLineForRelationship(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius1: number,
  radius2: number
): { x1: number; y1: number; x2: number; y2: number } {
  const trimmed = trimLineToCircles(x1, y1, x2, y2, radius1, radius2);
  const dx = trimmed.x2 - trimmed.x1;
  const dy = trimmed.y2 - trimmed.y1;
  const len = Math.hypot(dx, dy);
  if (len < ARROW_LINE_END_OFFSET + 1) {
    return trimmed;
  }
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: trimmed.x1,
    y1: trimmed.y1,
    x2: trimmed.x2 - ux * ARROW_LINE_END_OFFSET,
    y2: trimmed.y2 - uy * ARROW_LINE_END_OFFSET
  };
}

/** Red stroke for out-of-sync / schema-drift highlighting (nodes and edges). */
export const AFFECTED_STROKE = "#ef4444";

/** Arrow markers — ref at head center; tip extends past the line end. */
export function installArrowMarkers(
  defs: Selection<SVGDefsElement, unknown, null, undefined>,
  idPrefix = ""
) {
  const p = (name: string) => `${idPrefix}${name}`;
  const add = (id: string, fill: string) => {
    defs
      .append("marker")
      .attr("id", p(id))
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", ARROW_HEAD_REF)
      .attr("refY", 0)
      .attr("markerWidth", 7)
      .attr("markerHeight", 7)
      .attr("markerUnits", "userSpaceOnUse")
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", fill);
  };
  add("arrow", "context-stroke");
  add("arrow-self", "context-stroke");
  // Explicit red fill — context-stroke on markers breaks when a glow filter is applied to the
  // parent line (the line's bbox is too thin and clips the marker head).
  add("arrow-affected", AFFECTED_STROKE);
  add("arrow-self-affected", AFFECTED_STROKE);
}

export function arrowMarkerUrl(idPrefix: string, selfLoop = false): string {
  return `url(#${idPrefix}${selfLoop ? "arrow-self" : "arrow"})`;
}

export function arrowAffectedMarkerUrl(idPrefix: string, selfLoop = false): string {
  return `url(#${idPrefix}${selfLoop ? "arrow-self-affected" : "arrow-affected"})`;
}
