/**
 * Parallel-edge geometry: A→B and B→A must bow to opposite sides of the chord.
 *
 * Grouping by unordered pair already fans siblings, but the perpendicular used
 * to be each edge's own direction. Opposite-direction edges then shared one arc
 * and the result (and match) graphs stacked both relationships.
 *
 * Run from App/ui: `npx tsx ../../tests/graph-layout-parallel-edges.mjs`
 */
import assert from "node:assert/strict";
import { parallelEdgeGeometry } from "../App/ui/src/utils/graphLayout.ts";

const R = 14;

function sideSign(geom) {
  // Signed offset of the control point from the chord, using a canonical
  // left-to-right / top-to-bottom axis so A→B and B→A are comparable.
  const dx = geom.ex - geom.sx;
  const dy = geom.ey - geom.sy;
  let ux = dx;
  let uy = dy;
  if (ux < 0 || (ux === 0 && uy < 0)) {
    ux = -ux;
    uy = -uy;
  }
  const len = Math.hypot(ux, uy) || 1;
  const nx = -uy / len;
  const ny = ux / len;
  const mx = (geom.sx + geom.ex) / 2;
  const my = (geom.sy + geom.ey) / 2;
  return (geom.cx - mx) * nx + (geom.cy - my) * ny;
}

// --- 1. A lone edge stays on the chord (control at the midpoint) ---
{
  const geom = parallelEdgeGeometry(0, 0, 100, 0, R, R, 0, 1);
  assert.ok(Math.abs(sideSign(geom)) < 1e-9, "single edge must not bow");
}

// --- 2. Two same-direction edges fan to opposite sides ---
{
  const first = parallelEdgeGeometry(0, 0, 100, 0, R, R, 0, 2);
  const second = parallelEdgeGeometry(0, 0, 100, 0, R, R, 1, 2);
  assert.ok(sideSign(first) * sideSign(second) < 0, "same-direction parallels must split");
  assert.ok(Math.abs(sideSign(first) - sideSign(second)) > 20, "same-direction gap must be visible");
}

// --- 3. A→B and B→A bow to opposite sides (the overlapping-path bug) ---
{
  const ab = parallelEdgeGeometry(0, 0, 100, 0, R, R, 0, 2);
  const ba = parallelEdgeGeometry(100, 0, 0, 0, R, R, 1, 2);
  const abSide = sideSign(ab);
  const baSide = sideSign(ba);
  assert.ok(
    abSide * baSide < 0,
    `bidirectional edges must not share an arc (A→B side=${abSide}, B→A side=${baSide})`
  );
  assert.ok(
    Math.abs(abSide - baSide) > 20,
    `bidirectional gap must be visible (A→B=${abSide}, B→A=${baSide})`
  );
  assert.notEqual(ab.path, ba.path, "bidirectional edges must not reuse the same path");
}

// --- 4. Vertical pair: canonical normal still separates opposites ---
{
  const ab = parallelEdgeGeometry(40, 0, 40, 120, R, R, 0, 2);
  const ba = parallelEdgeGeometry(40, 120, 40, 0, R, R, 1, 2);
  assert.ok(
    sideSign(ab) * sideSign(ba) < 0,
    "vertical A→B / B→A must bow to opposite sides"
  );
}

console.log("graph-layout-parallel-edges: ok");
