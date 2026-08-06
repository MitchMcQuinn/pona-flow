import { useEffect } from "react";

/** Default mesh blob anchors — match `styles.css` resting positions. */
const BLOBS = [
  { varX: "--mesh-bg-x1", varY: "--mesh-bg-y1", baseX: -8, baseY: 28, parallaxX: 18, parallaxY: 12, stiffness: 0.048, damping: 0.8 },
  { varX: "--mesh-bg-x2", varY: "--mesh-bg-y2", baseX: 88, baseY: -12, parallaxX: 14, parallaxY: 10, stiffness: 0.034, damping: 0.84 },
  { varX: "--mesh-bg-x3", varY: "--mesh-bg-y3", baseX: 55, baseY: 118, parallaxX: 12, parallaxY: 16, stiffness: 0.04, damping: 0.82 }
] as const;

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

/**
 * Drives `--mesh-bg-*` CSS variables with spring-smoothed mouse tracking so ambient
 * mesh blobs lag elastically behind the cursor.
 */
export function useMeshBackgroundMotion(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;

    const root = document.documentElement;
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
        root.style.setProperty(blob.varX, `${px}%`);
        root.style.setProperty(blob.varY, `${py}%`);
      }
    };

    applyPositions();

    const onPointerMove = (event: PointerEvent) => {
      targetX = event.clientX / window.innerWidth;
      targetY = event.clientY / window.innerHeight;
    };

    let raf = 0;
    const tick = () => {
      for (const s of state) {
        const { blob } = s;
        [s.x, s.vx] = springStep(s.x, s.vx, targetX, blob.stiffness, blob.damping);
        [s.y, s.vy] = springStep(s.y, s.vy, targetY, blob.stiffness, blob.damping);
      }
      applyPositions();
      raf = window.requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    raf = window.requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.cancelAnimationFrame(raf);
      for (const blob of BLOBS) {
        root.style.removeProperty(blob.varX);
        root.style.removeProperty(blob.varY);
      }
    };
  }, [enabled]);
}
