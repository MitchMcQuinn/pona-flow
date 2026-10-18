import { useEffect, useState } from "react";

export type ViewportMode = "phone" | "tablet" | "desktop";

/** Upper bounds (exclusive) for each compact mode; keep in sync with the CSS media queries. */
export const PHONE_MAX_WIDTH = 768;
export const TABLET_MAX_WIDTH = 1100;

const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH - 0.02}px)`;
const TABLET_QUERY = `(max-width: ${TABLET_MAX_WIDTH - 0.02}px)`;
const COARSE_QUERY = "(pointer: coarse)";

export interface Viewport {
  mode: ViewportMode;
  /** Primary input is a finger rather than a mouse/trackpad. */
  coarsePointer: boolean;
}

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

export function readViewport(): Viewport {
  const mode: ViewportMode = matches(PHONE_QUERY)
    ? "phone"
    : matches(TABLET_QUERY)
      ? "tablet"
      : "desktop";
  return { mode, coarsePointer: matches(COARSE_QUERY) };
}

export function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(readViewport);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const lists = [PHONE_QUERY, TABLET_QUERY, COARSE_QUERY].map((q) => window.matchMedia(q));
    const update = () =>
      setViewport((prev) => {
        const next = readViewport();
        return prev.mode === next.mode && prev.coarsePointer === next.coarsePointer ? prev : next;
      });
    lists.forEach((list) => list.addEventListener("change", update));
    update();
    return () => lists.forEach((list) => list.removeEventListener("change", update));
  }, []);

  return viewport;
}

/** Non-reactive check for event handlers and imperative graph code. */
export function isCoarsePointer(): boolean {
  return matches(COARSE_QUERY);
}
