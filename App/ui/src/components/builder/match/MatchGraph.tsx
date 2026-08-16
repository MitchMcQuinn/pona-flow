import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import {
  isRegisteredInSpaceCatalog,
  spaceCatalogLabelKeys
} from "../../../state/builder/attributiveLabelOptions";
import {
  allowMatchGraphSelfRelationship,
  hopGatedByGraphOutgoing,
  schemaDrivenHopClause,
  supportsIncomingHop
} from "@pona-flow/authoring";
import { isAttributiveLabelParameter } from "@pona-flow/authoring";
import { isVectorSearchEnabled } from "@pona-flow/composer";
import {
  addGraphEdge,
  projectMatchToGraph
} from "../../../state/builder/matchGraph";
import type {
  GraphNodeLabel,
  Operation,
  SelectedMatchElement
} from "../../../state/builder/types";
import {
  arrowMarkerUrl,
  GRAPH_THEME,
  graphFilterId,
  graphGlowFilterUrl,
  installArrowMarkers,
  installEdgeMeshGradients,
  installGraphThemeDefs,
  installNodeLightGradients,
  installNodeShadowGradients,
  meshEdgeStrokeUrl,
  nodeGradientId,
  nodeLightFillUrl,
  nodeShadowFillUrl,
  portFillUrl,
  setNodeLightCenter,
  trimLineForRelationship,
  updateEdgeMeshGradient
} from "../../../utils/graphTheme";
import { GraphNodeLightMotion, attachGraphNodeLightLoop } from "../../../utils/graphMouseLight";
import { attachGraphBackgroundMotion } from "../../../utils/graphBackgroundMotion";
import {
  computeNodeRanks,
  fitGraphToView,
  selfLoopGeometry
} from "../../../utils/graphLayout";

const NODE_RADIUS = 16;
const HIT_RADIUS = 26;
const LAYER_GAP = 110;
const FIT_OPTIONS = { padding: 48, maxScale: 1.6, fill: 0.95 };
/** Loop extent of the first self-relationship arc (see utils/graphLayout). */
const SELF_LOOP_REACH = 46;
const UNLABELED_NODE_DISPLAY = "NODE";

function nodeDisplayLabel(attributiveLabel: string): string {
  return attributiveLabel.trim() || UNLABELED_NODE_DISPLAY;
}

interface MatchGraphProps {
  clauseIndex: number;
  label: GraphNodeLabel;
  operation: Operation;
  /** When false, the canvas is read-only (single-entity config / traversal modes). */
  editable: boolean;
}

interface SimNode extends d3.SimulationNodeDatum {
  variable: string;
  attributiveLabel: string;
  collideRadius?: number;
  pointerScale?: number;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  variable: string;
}

/** Teardrop self-loop path (shared with results/GraphView for visual consistency). */
function selfLoopPath(x: number, y: number, index: number): { path: string; lx: number; ly: number } {
  const geom = selfLoopGeometry(x, y, index, NODE_RADIUS, SELF_LOOP_REACH);
  return { path: geom.path, lx: geom.labelX, ly: geom.labelY };
}

export function MatchGraph({ clauseIndex, label, operation, editable }: MatchGraphProps) {
  const { state, patchQuery, dispatch } = useBuilder();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const graph = useMemo(
    () => projectMatchToGraph(state.query, clauseIndex),
    [state.query, clauseIndex]
  );

  const gatedMode = hopGatedByGraphOutgoing(label, operation);
  const useSchemaApi = schemaDrivenHopClause(label, operation);
  const selected = state.selectedMatchElement;

  // Latest selection, read inside D3 callbacks/restyle without rebuilding the canvas.
  const selectedRef = useRef<SelectedMatchElement | null>(selected);
  selectedRef.current = selected;
  const allowSelfRelRef = useRef(allowMatchGraphSelfRelationship(label, operation));
  allowSelfRelRef.current = allowMatchGraphSelfRelationship(label, operation);

  // Per-attributive-label outgoing-edge counts (catalog filtered) gate connect handles.
  const [outgoing, setOutgoing] = useState<Record<string, number>>({});
  const labelsKey = graph.nodes
    .map((n) => n.attributiveLabel)
    .filter(Boolean)
    .sort()
    .join("|");

  useEffect(() => {
    if (!gatedMode || !state.spaceId) {
      setOutgoing({});
      return;
    }
    const labels = Array.from(
      new Set(graph.nodes.map((n) => n.attributiveLabel.trim()).filter(Boolean))
    );
    if (labels.length === 0) {
      setOutgoing({});
      return;
    }
    let cancelled = false;
    const spaceId = state.spaceId;
    const catalogKeys = spaceCatalogLabelKeys(state.spaceLabels);
    Promise.all(
      labels.map(async (al): Promise<[string, number]> => {
        try {
          // Match ops also count incoming edges so nodes reachable only via a
          // reverse hop (e.g. VALUE, pointed at by PILLAR) get a connect handle.
          const rows = useSchemaApi
            ? await connector.fetchSchemaOutgoing({
                spaceId,
                attributiveLabel: al,
                includeIncoming: supportsIncomingHop(operation, label)
              })
            : await connector.fetchGraphStepOutgoing({ spaceId, attributiveLabel: al });
          const count = rows.filter(
            (row) =>
              isRegisteredInSpaceCatalog(String(row.rel_attributive_label ?? ""), catalogKeys) &&
              isRegisteredInSpaceCatalog(String(row.target_attributive_label ?? ""), catalogKeys)
          ).length;
          return [al, count];
        } catch {
          return [al, 0];
        }
      })
    ).then((entries) => {
      if (!cancelled) setOutgoing(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [gatedMode, useSchemaApi, state.spaceId, state.spaceLabels, labelsKey, operation, label]);

  function canConnectFrom(attributiveLabel: string): boolean {
    if (!editable) return false;
    // Vector search matches a single anchor node; a hop would break the index CALL.
    if (isVectorSearchEnabled(state.query)) return false;
    if (!gatedMode) return true;
    const al = attributiveLabel.trim();
    if (!al) return false;
    if (isAttributiveLabelParameter(al)) return true;
    return (outgoing[al] ?? 0) > 0;
  }

  // Auto-select a freshly drawn relationship so its config card opens immediately.
  const pendingSelectRef = useRef<{ before: Set<string> } | null>(null);
  useEffect(() => {
    const pending = pendingSelectRef.current;
    if (!pending) return;
    pendingSelectRef.current = null;
    const fresh = graph.edges.find((e) => !pending.before.has(e.variable));
    if (fresh) {
      dispatch({ type: "SELECT_MATCH_ELEMENT", element: { kind: "relationship", variable: fresh.variable } });
    }
  }, [graph, dispatch]);

  function connect(fromVariable: string, target: { kind: "existing"; variable: string } | { kind: "new" }) {
    pendingSelectRef.current = { before: new Set(graph.edges.map((e) => e.variable)) };
    patchQuery(addGraphEdge(clauseIndex, fromVariable, target));
  }

  // Keep something selected at all times: validate the current selection and fall back to
  // the first node (or edge) whenever it's missing or stale — on load, after a removal, or
  // when a variable is re-keyed. Skipped while a freshly drawn edge is awaiting selection.
  useEffect(() => {
    if (!editable || pendingSelectRef.current) return;
    const valid =
      selected != null &&
      (selected.kind === "node"
        ? graph.nodes.some((n) => n.variable === selected.variable)
        : graph.edges.some((e) => e.variable === selected.variable));
    if (valid) return;
    if (graph.nodes.length > 0) {
      dispatch({
        type: "SELECT_MATCH_ELEMENT",
        element: { kind: "node", variable: graph.nodes[0].variable }
      });
    } else if (graph.edges.length > 0) {
      dispatch({
        type: "SELECT_MATCH_ELEMENT",
        element: { kind: "relationship", variable: graph.edges[0].variable }
      });
    }
  }, [graph, selected, editable, dispatch]);

  // Topology key: the canvas only rebuilds on structural / label changes, never on plain
  // selection changes (selection restyles in place — see the styling effect below).
  const topoKey = useMemo(
    () =>
      JSON.stringify({
        nodes: graph.nodes.map((n) => [n.variable, n.attributiveLabel]),
        edges: graph.edges.map((e) => [
          e.variable,
          e.from,
          e.to,
          e.direction,
          e.attributiveLabel,
          e.relationship.optional === true
        ])
      }),
    [graph]
  );
  const outgoingKey = useMemo(() => JSON.stringify(outgoing), [outgoing]);

  // Restyle handle + zoom controls reach across effects via refs.
  const restyleRef = useRef<(() => void) | null>(null);
  const zoomCtlRef = useRef<{
    svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
    zoom: d3.ZoomBehavior<SVGSVGElement, unknown>;
  } | null>(null);

  const zoomBy = useCallback((factor: number) => {
    const ctl = zoomCtlRef.current;
    if (!ctl) return;
    ctl.svg.transition().duration(160).call(ctl.zoom.scaleBy, factor);
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const svgEl = svgRef.current;
    if (!container || !svgEl) return;
    const canvas = container;

    let cancelled = false;
    let autoFitActive = false;
    let positionsPersisted = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    let width = canvas.clientWidth;
    let height = canvas.clientHeight;
    if (width < 1) width = 600;
    if (height < 1) height = 360;

    const stored = state.matchPositions;
    // A layout pass (force sim + auto-fit) is needed whenever a node lacks a saved
    // position — i.e. on first load or right after a new node is drawn. Otherwise we
    // render statically at saved coordinates and preserve the user's pan/zoom.
    const needsLayout = graph.nodes.some((n) => !stored[n.variable]);

    const simNodes: SimNode[] = graph.nodes.map((n, i) => {
      const p = stored[n.variable];
      return {
        variable: n.variable,
        attributiveLabel: n.attributiveLabel,
        x: p?.x ?? width / 2 + (i - graph.nodes.length / 2) * 40,
        y: p?.y ?? height / 2,
        // Saved nodes stay pinned so existing placement never drifts when a new node lays out.
        fx: p ? p.x : null,
        fy: p ? p.y : null
      };
    });
    const nodeByVar = new Map(simNodes.map((n) => [n.variable, n]));

    const normalEdges = graph.edges.filter((e) => e.from !== e.to);
    const selfEdges = graph.edges.filter((e) => e.from === e.to);
    const selfIndex = new Map<string, number>();
    const selfCounts = new Map<string, number>();
    selfEdges.forEach((e) => {
      const i = selfCounts.get(e.from) ?? 0;
      selfIndex.set(e.variable, i);
      selfCounts.set(e.from, i + 1);
    });

    const simLinks: SimLink[] = normalEdges.map((e) => ({
      source: e.from,
      target: e.to,
      variable: e.variable
    }));

    const themePrefix = "mg-";

    const prevTransform = d3.zoomTransform(svgEl);

    const svg = d3
      .select(svgEl)
      .attr("viewBox", [0, 0, width, height].join(" "))
      .attr("width", "100%")
      .attr("height", "100%");
    svg.selectAll("*").remove();

    const defs = svg.append("defs");
    const root = svg.append("g");

    function persistLayoutPositions() {
      if (cancelled || positionsPersisted || !needsLayout) return;
      positionsPersisted = true;
      dispatch({
        type: "SET_MATCH_POSITIONS",
        positions: Object.fromEntries(
          simNodes.map((n) => [n.variable, { x: n.x ?? 0, y: n.y ?? 0 }])
        )
      });
    }

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .filter((event) => {
        // Wheel only zooms while holding ctrl/cmd; plain scroll passes through to the page.
        if (event.type === "wheel") return event.ctrlKey || event.metaKey;
        // Let node / handle / edge clicks through; pan only on background gestures.
        const target = event.target as Element;
        return (
          !target.closest?.("[data-node]") &&
          !target.closest?.("[data-port]") &&
          !target.closest?.("[data-edge]")
        );
      })
      .on("zoom", (event) => {
        root.attr("transform", event.transform.toString());
        if (event.sourceEvent && autoFitActive) {
          autoFitActive = false;
          if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
          }
          persistLayoutPositions();
        }
      });
    svg.call(zoom);
    zoomCtlRef.current = { svg, zoom };

    function tryAutoFit() {
      if (cancelled) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 1 || h < 1) return;
      svg.attr("viewBox", [0, 0, w, h].join(" "));
      if (!autoFitActive) return;
      fitGraphToView(svg, zoom, root, w, h, false, FIT_OPTIONS);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (cancelled || !autoFitActive) return;
        autoFitActive = false;
        persistLayoutPositions();
      }, 80);
    }

    installGraphThemeDefs(defs, themePrefix);
    installEdgeMeshGradients(defs, themePrefix, graph.edges.map((e) => e.variable));
    installNodeLightGradients(defs, themePrefix, simNodes.map((n) => n.variable));
    installNodeShadowGradients(defs, themePrefix, simNodes.map((n) => n.variable));
    installArrowMarkers(defs, themePrefix);

    const center = (v: string) => {
      const n = nodeByVar.get(v);
      return { x: n?.x ?? width / 2, y: n?.y ?? height / 2 };
    };

    // --- straight relationships ---
    const link = root
      .append("g")
      .selectAll("line")
      .data(normalEdges)
      .join("line")
      .attr("data-edge", (e) => e.variable)
      .attr("stroke", GRAPH_THEME.edge)
      .attr("stroke-opacity", GRAPH_THEME.edgeOpacity)
      // Optional hops render dashed to signal the OPTIONAL MATCH segment.
      .attr("stroke-dasharray", (e) => (e.relationship.optional === true ? "6 4" : null))
      .attr("marker-end", arrowMarkerUrl(themePrefix))
      .style("cursor", "pointer")
      .on("click", (event, e) => {
        event.stopPropagation();
        dispatch({ type: "SELECT_MATCH_ELEMENT", element: { kind: "relationship", variable: e.variable } });
      });

    const linkLabels = root
      .append("g")
      .selectAll("text")
      .data(normalEdges)
      .join("text")
      .attr("data-edge", (e) => e.variable)
      .text((e) => e.attributiveLabel || "(rel)")
      .attr("font-size", 10)
      .attr("text-anchor", "middle")
      .attr("fill", GRAPH_THEME.edgeLabel)
      .attr("stroke", GRAPH_THEME.labelHalo)
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .style("cursor", "pointer")
      .on("click", (event, e) => {
        event.stopPropagation();
        dispatch({ type: "SELECT_MATCH_ELEMENT", element: { kind: "relationship", variable: e.variable } });
      });

    // --- self-loops ---
    const selfLayer = root.append("g").attr("fill", "none");
    const selfLink = selfLayer
      .selectAll("path")
      .data(selfEdges)
      .join("path")
      .attr("data-edge", (e) => e.variable)
      .attr("stroke", GRAPH_THEME.edge)
      .attr("stroke-opacity", GRAPH_THEME.edgeOpacity)
      .attr("stroke-dasharray", (e) => (e.relationship.optional === true ? "6 4" : null))
      .attr("marker-end", arrowMarkerUrl(themePrefix, true))
      .style("cursor", "pointer")
      .on("click", (event, e) => {
        event.stopPropagation();
        dispatch({ type: "SELECT_MATCH_ELEMENT", element: { kind: "relationship", variable: e.variable } });
      });

    const selfLabels = root
      .append("g")
      .selectAll("text")
      .data(selfEdges)
      .join("text")
      .attr("data-edge", (e) => e.variable)
      .text((e) => e.attributiveLabel || "(rel)")
      .attr("font-size", 10)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", GRAPH_THEME.edgeLabel)
      .attr("stroke", GRAPH_THEME.labelHalo)
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .style("cursor", "pointer")
      .on("click", (event, e) => {
        event.stopPropagation();
        dispatch({ type: "SELECT_MATCH_ELEMENT", element: { kind: "relationship", variable: e.variable } });
      });

    // --- nodes ---
    const nodeG = root
      .append("g")
      .selectAll<SVGGElement, SimNode>("g")
      .data(simNodes, (d) => d.variable)
      .join("g")
      .attr("data-node", (d) => d.variable);

    nodeG
      .append("circle")
      .attr("class", "graph-node-shadow")
      .attr("r", NODE_RADIUS * 1.12)
      .attr("fill", (d) => nodeShadowFillUrl(themePrefix, d.variable))
      .attr("stroke", "none")
      .attr("pointer-events", "none");

    const nodeCircle = nodeG
      .append("circle")
      .attr("r", NODE_RADIUS)
      .attr("fill", `url(#${themePrefix}${nodeGradientId(label)})`)
      .attr("stroke", GRAPH_THEME.nodeStroke)
      .attr("stroke-width", 0)
      .attr("filter", `url(#${graphFilterId(themePrefix, "graph-node-elevate")})`)
      .style("cursor", "pointer");
    // Selection is driven by the node drag `end` (a no-move gesture is a click); d3-drag
    // suppresses native clicks after a gesture, so a separate circle.on("click") is unreliable.

    nodeG
      .append("circle")
      .attr("class", "graph-node-light")
      .attr("r", NODE_RADIUS)
      .attr("fill", (d) => nodeLightFillUrl(themePrefix, d.variable))
      .attr("stroke", "none")
      .attr("pointer-events", "none");

    const lightMotion = new GraphNodeLightMotion();
    lightMotion.syncNodeIds(simNodes.map((n) => n.variable));

    nodeG
      .append("text")
      .text((d) => nodeDisplayLabel(d.attributiveLabel))
      .attr("y", NODE_RADIUS + 14)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("fill", GRAPH_THEME.nodeLabel)
      .attr("stroke", GRAPH_THEME.labelHalo)
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .style("pointer-events", "none");

    // Connect handle (drag to draw a relationship) — only where hops are allowed.
    const ports = nodeG
      .filter((d) => canConnectFrom(d.attributiveLabel))
      .append("circle")
      .attr("data-port", (d) => d.variable)
      .attr("r", 5)
      .attr("cy", NODE_RADIUS)
      .attr("fill", portFillUrl(themePrefix))
      .attr("stroke", "none")
      .attr("stroke-width", 0)
      .attr("filter", `url(#${graphFilterId(themePrefix, "graph-node-glow")})`)
      .style("cursor", "crosshair");
    ports.append("title").text("Drag to add a relationship");

    const pointerInRoot = (event: { sourceEvent: Event } | MouseEvent): [number, number] => {
      const t = d3.zoomTransform(svgEl);
      const native = "sourceEvent" in event ? (event.sourceEvent as MouseEvent) : event;
      const [sx, sy] = d3.pointer(native, svgEl);
      return t.invert([sx, sy]);
    };

    // Style nodes/edges per the current selection without rebuilding the canvas.
    const applySelectionStyles = () => {
      const sel = selectedRef.current;
      const isSel = (kind: "node" | "relationship", variable: string) =>
        sel?.kind === kind && sel.variable === variable;
      nodeCircle
        .attr("stroke", (d) =>
          isSel("node", d.variable)
            ? `url(#${themePrefix}graph-mesh-stroke)`
            : GRAPH_THEME.nodeStroke
        )
        .attr("stroke-width", (d) => (isSel("node", d.variable) ? 2.5 : 0))
        .attr("filter", (d) =>
          isSel("node", d.variable)
            ? `url(#${graphFilterId(themePrefix, "graph-node-glow")})`
            : `url(#${graphFilterId(themePrefix, "graph-node-elevate")})`
        );
      nodeG
        .select(".graph-node-light")
        .attr("opacity", (d) => (isSel("node", d.variable) ? 0 : 1));
      link
        .attr("stroke", (e) =>
          isSel("relationship", e.variable)
            ? meshEdgeStrokeUrl(themePrefix, e.variable)
            : GRAPH_THEME.edge
        )
        .attr("stroke-width", (e) => (isSel("relationship", e.variable) ? 3 : 1.5))
        .attr("stroke-opacity", (e) =>
          isSel("relationship", e.variable) ? 1 : GRAPH_THEME.edgeOpacity
        )
        .attr("filter", (e) =>
          isSel("relationship", e.variable) ? graphGlowFilterUrl(themePrefix) : null
        );
      selfLink
        .attr("stroke", (e) =>
          isSel("relationship", e.variable)
            ? meshEdgeStrokeUrl(themePrefix, e.variable)
            : GRAPH_THEME.edge
        )
        .attr("stroke-width", (e) => (isSel("relationship", e.variable) ? 3 : 1.5))
        .attr("stroke-opacity", (e) =>
          isSel("relationship", e.variable) ? 1 : GRAPH_THEME.edgeOpacity
        )
        .attr("filter", (e) =>
          isSel("relationship", e.variable) ? graphGlowFilterUrl(themePrefix) : null
        );
    };
    restyleRef.current = applySelectionStyles;

    const updateNodeTransforms = () => {
      nodeG.attr("transform", (d) => {
        const s = d.pointerScale ?? 1;
        return `translate(${d.x ?? 0},${d.y ?? 0}) scale(${s})`;
      });
    };

    function render() {
      updateNodeTransforms();
      link.each(function (e) {
        const from = center(e.from);
        const to = center(e.to);
        const trimmed = trimLineForRelationship(from.x, from.y, to.x, to.y, NODE_RADIUS, NODE_RADIUS);
        d3.select(this)
          .attr("x1", trimmed.x1)
          .attr("y1", trimmed.y1)
          .attr("x2", trimmed.x2)
          .attr("y2", trimmed.y2);
        updateEdgeMeshGradient(
          defs,
          themePrefix,
          e.variable,
          trimmed.x1,
          trimmed.y1,
          trimmed.x2,
          trimmed.y2
        );
      });
      linkLabels
        .attr("x", (e) => {
          const from = center(e.from);
          const to = center(e.to);
          const trimmed = trimLineForRelationship(from.x, from.y, to.x, to.y, NODE_RADIUS, NODE_RADIUS);
          return (trimmed.x1 + trimmed.x2) / 2;
        })
        .attr("y", (e) => {
          const from = center(e.from);
          const to = center(e.to);
          const trimmed = trimLineForRelationship(from.x, from.y, to.x, to.y, NODE_RADIUS, NODE_RADIUS);
          return (trimmed.y1 + trimmed.y2) / 2 - 4;
        });
      selfLink.attr("d", (e) => {
        const c = center(e.from);
        return selfLoopPath(c.x, c.y, selfIndex.get(e.variable) ?? 0).path;
      });
      selfEdges.forEach((e) => {
        const c = center(e.from);
        const idx = selfIndex.get(e.variable) ?? 0;
        const { lx, ly } = selfLoopPath(c.x, c.y, idx);
        updateEdgeMeshGradient(defs, themePrefix, e.variable, c.x, c.y, lx, ly);
      });
      selfLabels
        .attr("x", (e) => {
          const c = center(e.from);
          return selfLoopPath(c.x, c.y, selfIndex.get(e.variable) ?? 0).lx;
        })
        .attr("y", (e) => {
          const c = center(e.from);
          return selfLoopPath(c.x, c.y, selfIndex.get(e.variable) ?? 0).ly;
        });
    }

    // Drag a port to connect.
    let tempLine: d3.Selection<SVGLineElement, unknown, null, undefined> | null = null;
    ports.call(
      d3
        .drag<SVGCircleElement, SimNode>()
        .on("start", (_event, d) => {
          const c = center(d.variable);
          tempLine = root
            .append("line")
            .lower()
            .attr("stroke", GRAPH_THEME.edgeSelected)
            .attr("stroke-width", 2)
            .attr("stroke-dasharray", "4 3")
            .attr("x1", c.x)
            .attr("y1", c.y)
            .attr("x2", c.x)
            .attr("y2", c.y);
        })
        .on("drag", (event) => {
          if (!tempLine) return;
          const [mx, my] = pointerInRoot(event);
          tempLine.attr("x2", mx).attr("y2", my);
        })
        .on("end", (event, d) => {
          tempLine?.remove();
          tempLine = null;
          const [mx, my] = pointerInRoot(event);
          let targetVar: string | null = null;
          for (const n of simNodes) {
            const c = center(n.variable);
            if (Math.hypot(c.x - mx, c.y - my) <= HIT_RADIUS) {
              targetVar = n.variable;
              break;
            }
          }
          if (targetVar) {
            // Read INSTANCE/SCHEMA cannot express self-relationships; SCHEMA create can.
            if (targetVar === d.variable && !allowSelfRelRef.current) return;
            connect(d.variable, { kind: "existing", variable: targetVar });
          } else {
            connect(d.variable, { kind: "new" });
          }
        })
    );

    // Drag a node body to reposition (pinning it); a no-move gesture selects the node.
    let nodeDragMoved = false;
    nodeG.call(
      d3
        .drag<SVGGElement, SimNode>()
        .filter((event) => {
          const target = event.target as Element;
          return !target.closest?.("[data-port]");
        })
        .on("start", () => {
          nodeDragMoved = false;
        })
        .on("drag", (event, d) => {
          nodeDragMoved = true;
          const [mx, my] = pointerInRoot(event);
          d.x = mx;
          d.y = my;
          d.fx = mx;
          d.fy = my;
          render();
        })
        .on("end", (_event, d) => {
          if (nodeDragMoved) {
            dispatch({
              type: "SET_MATCH_POSITIONS",
              positions: Object.fromEntries(
                simNodes.map((n) => [n.variable, { x: n.x ?? 0, y: n.y ?? 0 }])
              )
            });
          } else {
            dispatch({ type: "SELECT_MATCH_ELEMENT", element: { kind: "node", variable: d.variable } });
          }
        })
    );

    render();
    applySelectionStyles();

    const destroyMouseLight = attachGraphNodeLightLoop(
      svgEl,
      () => d3.zoomTransform(svgEl),
      lightMotion,
      () => simNodes.map((n) => ({ id: n.variable, x: n.x ?? 0, y: n.y ?? 0 })),
      NODE_RADIUS,
      (nodeId, cx, cy, scale) => {
        setNodeLightCenter(defs, themePrefix, nodeId, cx, cy);
        const n = simNodes.find((node) => node.variable === nodeId);
        if (n) n.pointerScale = scale;
      },
      updateNodeTransforms
    );

    const destroyBackgroundMotion = attachGraphBackgroundMotion(canvas);

    let simulation: d3.Simulation<SimNode, SimLink> | null = null;

    if (needsLayout) {
      const { ranks, maxRank } = computeNodeRanks(
        simNodes.map((n) => n.variable),
        simLinks.map((l) => ({ source: l.source as string, target: l.target as string }))
      );
      const layerY = (rank: number) => height / 2 + (rank - maxRank / 2) * LAYER_GAP;

      simulation = d3
        .forceSimulation<SimNode>(simNodes)
        .force(
          "link",
          d3
            .forceLink<SimNode, SimLink>(simLinks)
            .id((d) => d.variable)
            .distance(110)
        )
        .force("charge", d3.forceManyBody().strength(-320))
        .force("x", d3.forceX<SimNode>(width / 2).strength(0.06))
        .force(
          "y",
          d3.forceY<SimNode>((d) => layerY(ranks.get(d.variable) ?? 0)).strength(0.45)
        )
        .force("collide", d3.forceCollide<SimNode>().radius(NODE_RADIUS + 26));

      // Settle the layout synchronously (off-screen) before the first paint so nodes appear
      // already placed and fitted instead of visibly drifting into position. Dragging a node
      // repositions it directly (it never restarts the simulation), so no live ticking is needed.
      simulation.stop();
      const settleTicks = Math.ceil(
        Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())
      );
      for (let i = 0; i < settleTicks; i += 1) simulation.tick();
      render();
      autoFitActive = true;
      // Dashboard + split-pane widths often settle after the first layout pass; keep
      // refitting until the canvas size stops changing so the initial node stays in view.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => tryAutoFit());
      });
    } else {
      // Static render: keep the user's existing pan/zoom across rebuilds.
      svg.call(zoom.transform, prevTransform);
    }

    // Coalesce resize bursts (animated panel transitions, split-pane drag-resize) into one
    // re-fit per frame so we measure once the size has settled instead of thrashing getBBox().
    let resizeFrame = 0;
    let lastW = width;
    let lastH = height;

    const handleResize = () => {
      resizeFrame = 0;
      if (cancelled) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 1 || h < 1) return;
      const changed = w !== lastW || h !== lastH;
      lastW = w;
      lastH = h;
      // While the initial layout is still settling, defer to the auto-fit-until-stable flow.
      if (autoFitActive) {
        tryAutoFit();
        return;
      }
      // Settled (or static restore): recenter + rescale the existing layout to fit the new
      // viewport whenever the canvas actually changes size. This resets the current pan/zoom
      // to fit-all, but leaves the persisted node positions untouched.
      if (!changed) return;
      svg.attr("viewBox", [0, 0, w, h].join(" "));
      fitGraphToView(svg, zoom, root, w, h, false, FIT_OPTIONS);
    };

    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(handleResize);
    });
    resizeObserver.observe(canvas);
    tryAutoFit();

    return () => {
      cancelled = true;
      destroyMouseLight();
      destroyBackgroundMotion();
      if (settleTimer) clearTimeout(settleTimer);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      simulation?.stop();
      zoomCtlRef.current = null;
      restyleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey, outgoingKey, editable]);

  // Re-style the selection without tearing down the canvas (fixes click-to-select flicker).
  useEffect(() => {
    restyleRef.current?.();
  }, [selected]);

  return (
    <div ref={containerRef} className="matchGraphCanvas">
      <svg ref={svgRef} />
      <div className="matchZoomControls" role="group" aria-label="Zoom">
        <span className="matchZoomGlyph" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <button type="button" className="matchZoomBtn" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button type="button" className="matchZoomBtn" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
          −
        </button>
      </div>
    </div>
  );
}
