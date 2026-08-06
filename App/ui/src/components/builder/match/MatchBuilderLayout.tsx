import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import uiPersistence from "../../../services/uiPersistence";

/** Neither pane may shrink below this in the side-by-side layout. */
const MIN_PANE = 300;
/** Below this width the resizer is hidden and panes stack vertically. */
const STACK_BREAKPOINT = 600;
const DEFAULT_CONFIG = 400;
const HANDLE_HIT = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface MatchBuilderLayoutProps {
  /** The graph canvas pane content (rendered under the "match clause" title). */
  graph: ReactNode;
  /** The element-config pane content. */
  config: ReactNode;
}

/**
 * Side-by-side graph builder + element-config layout with a draggable, persistent
 * resizer (mirrors the main dashboard). Neither pane drops below MIN_PANE; once the
 * available width can't hold both at that minimum, it collapses to a stacked column
 * and hides the resizer.
 */
export function MatchBuilderLayout({ graph, config }: MatchBuilderLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [configWidth, setConfigWidth] = useState(() =>
    Math.max(MIN_PANE, uiPersistence.getMatchConfigWidth() ?? DEFAULT_CONFIG)
  );
  const configWidthRef = useRef(configWidth);
  configWidthRef.current = configWidth;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stacked = containerWidth > 0 && containerWidth < STACK_BREAKPOINT;
  const maxConfig = Math.max(MIN_PANE, containerWidth - MIN_PANE);
  const effConfigWidth = clamp(configWidth, MIN_PANE, maxConfig);
  const graphWidth = Math.max(0, containerWidth - effConfigWidth);

  const dragRef = useRef(false);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const el = containerRef.current;
    if (!dragRef.current || !el) return;
    const rect = el.getBoundingClientRect();
    // Handle sits on the config pane's left edge: drag left → wider config.
    const next = clamp(rect.right - event.clientX, MIN_PANE, Math.max(MIN_PANE, rect.width - MIN_PANE));
    setConfigWidth(next);
  }, []);

  const endResize = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = false;
    document.body.classList.remove("matchResizing");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endResize);
    uiPersistence.setMatchConfigWidth(configWidthRef.current);
  }, [onPointerMove]);

  const startResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      dragRef.current = true;
      document.body.classList.add("matchResizing");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endResize);
    },
    [onPointerMove, endResize]
  );

  useEffect(() => () => endResize(), [endResize]);

  return (
    <div
      ref={containerRef}
      className={`matchGraphLayout${stacked ? " matchGraphLayoutStacked" : ""}`}
    >
      <div
        className="matchGraphPane"
        style={stacked ? undefined : { width: graphWidth, flex: "0 0 auto" }}
      >
        <div className="matchPaneHead">
          <label className="matchPaneTitle">match clause</label>
        </div>
        {containerWidth > 0 ? graph : <div className="matchGraphCanvas" aria-hidden="true" />}
      </div>

      {!stacked ? (
        <div
          className="matchSplitHandle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize element config panel"
          style={{ left: graphWidth - HANDLE_HIT / 2 }}
          onPointerDown={startResize}
        />
      ) : null}

      <div
        className="matchConfigPane"
        style={stacked ? undefined : { width: effConfigWidth, flex: "0 0 auto" }}
      >
        {config}
      </div>
    </div>
  );
}
