import * as d3 from "d3";
import { computeNodeLightCenter } from "./graphTheme";

function springStep(
  current: number,
  velocity: number,
  target: number,
  stiffness: number,
  damping: number
): [number, number] {
  const force = (target - current) * stiffness;
  const nextVelocity = (velocity + force) * damping;
  return [current + nextVelocity, nextVelocity];
}

/** Per-node gradient center — very slow drift so blobs lag far behind fast cursor sweeps. */
const NODE_LIGHT_STIFFNESS = 0.003;
/** Lower damping dissipates velocity faster (not Hooke-style critical damping). */
const NODE_LIGHT_DAMPING = 0.965;

/** Proximity scale: 0.95 at range edge → 1.05 when the cursor is on the node. */
const NODE_SCALE_MIN = 0.95;
const NODE_SCALE_MAX = 1.05;
const NODE_SCALE_REACH = 7;
const NODE_SCALE_STIFFNESS = 0.005;
const NODE_SCALE_DAMPING = 0.88;

export function computeNodePointerScale(
  nodeX: number,
  nodeY: number,
  lightX: number,
  lightY: number,
  nodeRadius: number
): number {
  const dist = Math.hypot(lightX - nodeX, lightY - nodeY);
  const reach = nodeRadius * NODE_SCALE_REACH;
  const proximity = reach > 0 ? Math.max(0, 1 - dist / reach) : 0;
  return NODE_SCALE_MIN + (NODE_SCALE_MAX - NODE_SCALE_MIN) * proximity;
}

export interface GraphLightNode {
  id: string;
  x: number;
  y: number;
}

/** Spring-smoothed gradient center per node (independent of each other). */
type NodeMotionState = {
  cx: number;
  cy: number;
  vx: number;
  vy: number;
  scale: number;
  vScale: number;
};

export class GraphNodeLightMotion {
  private states = new Map<string, NodeMotionState>();

  syncNodeIds(nodeIds: string[]) {
    const keep = new Set(nodeIds);
    for (const id of this.states.keys()) {
      if (!keep.has(id)) this.states.delete(id);
    }
    for (const id of nodeIds) {
      if (!this.states.has(id)) {
        this.states.set(id, { cx: 0.5, cy: 0.5, vx: 0, vy: 0, scale: 1, vScale: 0 });
      }
    }
  }

  tick(
    nodes: GraphLightNode[],
    lightX: number,
    lightY: number,
    nodeRadius: number,
    apply: (nodeId: string, cx: number, cy: number, scale: number) => void
  ) {
    for (const node of nodes) {
      const target = computeNodeLightCenter(node.x, node.y, lightX, lightY, nodeRadius);
      const targetScale = computeNodePointerScale(node.x, node.y, lightX, lightY, nodeRadius);
      const state = this.states.get(node.id) ?? {
        cx: 0.5,
        cy: 0.5,
        vx: 0,
        vy: 0,
        scale: 1,
        vScale: 0
      };
      [state.cx, state.vx] = springStep(
        state.cx,
        state.vx,
        target.cx,
        NODE_LIGHT_STIFFNESS,
        NODE_LIGHT_DAMPING
      );
      [state.cy, state.vy] = springStep(
        state.cy,
        state.vy,
        target.cy,
        NODE_LIGHT_STIFFNESS,
        NODE_LIGHT_DAMPING
      );
      [state.scale, state.vScale] = springStep(
        state.scale,
        state.vScale,
        targetScale,
        NODE_SCALE_STIFFNESS,
        NODE_SCALE_DAMPING
      );
      this.states.set(node.id, state);
      apply(node.id, state.cx, state.cy, state.scale);
    }
  }
}

/**
 * Tracks pointer in graph coordinates and spring-smooths each node's light gradient
 * independently so fast cursor sweeps do not snap blobs across node surfaces.
 */
export function attachGraphNodeLightLoop(
  svgEl: SVGSVGElement,
  getTransform: () => d3.ZoomTransform,
  motion: GraphNodeLightMotion,
  getNodes: () => GraphLightNode[],
  nodeRadius: number,
  apply: (nodeId: string, cx: number, cy: number, scale: number) => void,
  onFrame?: () => void
): () => void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let lightX = 0;
  let lightY = 0;

  const syncFromPointer = (event: PointerEvent) => {
    const t = getTransform();
    const [sx, sy] = d3.pointer(event, svgEl);
    [lightX, lightY] = t.invert([sx, sy]);
    if (reducedMotion) {
      const nodes = getNodes();
      motion.syncNodeIds(nodes.map((n) => n.id));
      for (const node of nodes) {
        const { cx, cy } = computeNodeLightCenter(node.x, node.y, lightX, lightY, nodeRadius);
        const scale = computeNodePointerScale(node.x, node.y, lightX, lightY, nodeRadius);
        apply(node.id, cx, cy, scale);
      }
      onFrame?.();
    }
  };

  const rect = svgEl.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    [lightX, lightY] = getTransform().invert([rect.width / 2, rect.height / 2]);
  }

  let raf = 0;
  const tick = () => {
    const nodes = getNodes();
    motion.syncNodeIds(nodes.map((n) => n.id));
    motion.tick(nodes, lightX, lightY, nodeRadius, apply);
    onFrame?.();
    raf = window.requestAnimationFrame(tick);
  };

  window.addEventListener("pointermove", syncFromPointer, { passive: true });
  if (!reducedMotion) {
    raf = window.requestAnimationFrame(tick);
  } else {
    const nodes = getNodes();
    motion.syncNodeIds(nodes.map((n) => n.id));
    for (const node of nodes) {
      const { cx, cy } = computeNodeLightCenter(node.x, node.y, lightX, lightY, nodeRadius);
      const scale = computeNodePointerScale(node.x, node.y, lightX, lightY, nodeRadius);
      apply(node.id, cx, cy, scale);
    }
    onFrame?.();
  }

  return () => {
    window.removeEventListener("pointermove", syncFromPointer);
    window.cancelAnimationFrame(raf);
  };
}
