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

/** Resting mesh blob anchors — match graph surface CSS defaults. */
const BLOBS = [
  {
    varX: "--graph-mesh-x1",
    varY: "--graph-mesh-y1",
    baseX: 18,
    baseY: 0,
    parallaxX: 7,
    parallaxY: 5,
    stiffness: 0.01,
    damping: 0.9
  },
  {
    varX: "--graph-mesh-x2",
    varY: "--graph-mesh-y2",
    baseX: 95,
    baseY: 100,
    parallaxX: 6,
    parallaxY: 7,
    stiffness: 0.012,
    damping: 0.89
  }
] as const;

/**
 * Spring-smoothed pointer tracking for graph canvas mesh backgrounds. Each blob
 * drifts slightly from its resting anchor with a long lag behind the cursor.
 */
export function attachGraphBackgroundMotion(container: HTMLElement): () => void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let targetX = 0.5;
  let targetY = 0.5;
  const state = BLOBS.map((blob) => ({
    blob,
    x: 0.5,
    y: 0.5,
    vx: 0,
    vy: 0
  }));

  const applyPositions = () => {
    for (const s of state) {
      const { blob, x, y } = s;
      const px = blob.baseX + (x - 0.5) * blob.parallaxX;
      const py = blob.baseY + (y - 0.5) * blob.parallaxY;
      container.style.setProperty(blob.varX, `${px}%`);
      container.style.setProperty(blob.varY, `${py}%`);
    }
  };

  applyPositions();

  const onPointerMove = (event: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    targetX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    targetY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    if (reducedMotion) {
      for (const s of state) {
        s.x = targetX;
        s.y = targetY;
      }
      applyPositions();
    }
  };

  const onPointerLeave = () => {
    targetX = 0.5;
    targetY = 0.5;
    if (reducedMotion) {
      for (const s of state) {
        s.x = 0.5;
        s.y = 0.5;
      }
      applyPositions();
    }
  };

  let raf = 0;
  const tick = () => {
    if (!reducedMotion) {
      for (const s of state) {
        const { blob } = s;
        [s.x, s.vx] = springStep(s.x, s.vx, targetX, blob.stiffness, blob.damping);
        [s.y, s.vy] = springStep(s.y, s.vy, targetY, blob.stiffness, blob.damping);
      }
      applyPositions();
    }
    raf = window.requestAnimationFrame(tick);
  };

  container.addEventListener("pointermove", onPointerMove, { passive: true });
  container.addEventListener("pointerleave", onPointerLeave);
  if (!reducedMotion) {
    raf = window.requestAnimationFrame(tick);
  }

  return () => {
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerleave", onPointerLeave);
    window.cancelAnimationFrame(raf);
    for (const blob of BLOBS) {
      container.style.removeProperty(blob.varX);
      container.style.removeProperty(blob.varY);
    }
  };
}
