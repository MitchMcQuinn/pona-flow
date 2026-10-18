import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import uiPersistence from "../../services/uiPersistence";
import type { ViewportMode } from "../../hooks/useViewport";

const NAV_DEFAULT = 260;
const NAV_MIN = 200;
const NAV_MAX = 420;
const CONFIG_DEFAULT = 440;
const CONFIG_MIN = 300;
// Wide enough for the graph match builder's side-by-side canvas + element-config layout
// (≥600px). The layout-aware clamp still keeps the visualization panel visible.
const CONFIG_MAX = 1800;

/** Matches `.layoutResizable { padding: 12px }` — flex children sit in the inner content box. */
const LAYOUT_H_PADDING = 24;
/** Matches `.layoutResizeHandle { flex: 0 0 10px; margin: 0 2px }`. */
const RESIZE_HANDLE_WIDTH = 14;
/** Matches `.layoutVizSlot { min-width: 200px }`. */
const VIZ_MIN_WIDTH = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Persist and restore the vertical scroll of a panel slot's ``.panel__body`` so it
 * survives refreshes. Restore re-runs only when the body element is swapped (a panel
 * view change), never on in-place content edits, so it won't fight active typing/scroll.
 */
function usePanelScrollPersistence(
  ref: React.RefObject<HTMLElement | null>,
  storageKey: string,
  enabled: boolean
) {
  useEffect(() => {
    const slot = ref.current;
    if (!slot || !enabled) return;

    const getBody = () => slot.querySelector<HTMLElement>(".panel__body");

    let saveTimer: number | null = null;
    let latestTop = 0;
    const onScroll = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.classList || !target.classList.contains("panel__body")) return;
      latestTop = target.scrollTop;
      if (saveTimer !== null) return;
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        uiPersistence.setScroll(storageKey, latestTop);
      }, 150);
    };

    let lastBody: HTMLElement | null = null;
    const restore = () => {
      const body = getBody();
      if (!body || body === lastBody) return;
      lastBody = body;
      const saved = uiPersistence.getScroll(storageKey);
      if (saved !== null) body.scrollTop = saved;
    };

    const raf = window.requestAnimationFrame(restore);
    const observer = new MutationObserver(restore);
    observer.observe(slot, { childList: true, subtree: true });
    slot.addEventListener("scroll", onScroll, true);

    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      slot.removeEventListener("scroll", onScroll, true);
      if (saveTimer !== null) window.clearTimeout(saveTimer);
    };
  }, [ref, storageKey, enabled]);
}

function resizeHandleCount(
  showConfig: boolean,
  showVisualization: boolean,
  navInFlow = true
): number {
  // Nav↔config handle is present while nav sits in the row (not a tablet drawer);
  // config↔viz handle only when both panels show.
  return (navInFlow ? 1 : 0) + (showConfig && showVisualization ? 1 : 0);
}

function innerContentWidth(main: HTMLElement): number {
  return main.clientWidth - LAYOUT_H_PADDING;
}

function maxConfigWidthForLayout(
  main: HTMLElement,
  navWidth: number,
  showConfig: boolean,
  showVisualization: boolean,
  navInFlow = true
): number {
  if (!showVisualization) return CONFIG_MAX;
  const available =
    innerContentWidth(main) -
    (navInFlow ? navWidth : 0) -
    resizeHandleCount(showConfig, showVisualization, navInFlow) * RESIZE_HANDLE_WIDTH -
    VIZ_MIN_WIDTH;
  return Math.min(CONFIG_MAX, Math.max(available, 0));
}

function maxNavWidthForLayout(
  main: HTMLElement,
  configWidth: number,
  showConfig: boolean,
  showVisualization: boolean
): number {
  const handles = resizeHandleCount(showConfig, showVisualization) * RESIZE_HANDLE_WIDTH;
  const configPart = showConfig ? configWidth : 0;
  const vizPart = showVisualization ? VIZ_MIN_WIDTH : 0;
  const available = innerContentWidth(main) - configPart - handles - vizPart;
  return Math.min(NAV_MAX, Math.max(available, 0));
}

export type MobilePane = "menu" | "workbench" | "map";

interface ResizableDashboardLayoutProps {
  navigation: ReactNode;
  visualization: ReactNode;
  config: ReactNode;
  showVisualization?: boolean;
  showConfig?: boolean;
  /** phone = one pane at a time; tablet = nav becomes a drawer; desktop = resizable row. */
  mode?: ViewportMode;
  mobilePane?: MobilePane;
  navDrawerOpen?: boolean;
  onCloseNavDrawer?: () => void;
}

function EmptyPane({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div className="panel layoutEmptyPane" data-testid={testId}>
      <div className="panel__body">
        <p className="muted">{children}</p>
      </div>
    </div>
  );
}

export function ResizableDashboardLayout({
  navigation,
  visualization,
  config,
  showVisualization = true,
  showConfig = true,
  mode = "desktop",
  mobilePane = "menu",
  navDrawerOpen = false,
  onCloseNavDrawer
}: ResizableDashboardLayoutProps) {
  const isPhone = mode === "phone";
  const isTablet = mode === "tablet";
  const navInFlow = mode === "desktop";
  // Phones keep every pane mounted (switching tabs must not discard builder state) and
  // show a hint where a pane has nothing yet; tablets need something beside the drawer.
  const renderConfig = showConfig || isPhone || (isTablet && !showVisualization);
  const renderViz = showVisualization || isPhone;
  // Restore persisted panel sizes across refreshes, clamped to absolute bounds; the
  // layout-aware clamp in enforceLayoutLimits runs on mount to fit the current viewport.
  const [navWidth, setNavWidth] = useState(() =>
    clamp(uiPersistence.getNavWidth() ?? NAV_DEFAULT, NAV_MIN, NAV_MAX)
  );
  const [configWidth, setConfigWidth] = useState(() =>
    clamp(uiPersistence.getConfigWidth() ?? CONFIG_DEFAULT, CONFIG_MIN, CONFIG_MAX)
  );

  const mainRef = useRef<HTMLElement>(null);
  const navSlotRef = useRef<HTMLElement>(null);
  const configSlotRef = useRef<HTMLElement>(null);
  const vizSlotRef = useRef<HTMLDivElement>(null);

  usePanelScrollPersistence(navSlotRef, "nav", true);
  usePanelScrollPersistence(configSlotRef, "config", showConfig);
  usePanelScrollPersistence(vizSlotRef, "viz", showVisualization);

  const navWidthRef = useRef(navWidth);
  const configWidthRef = useRef(configWidth);
  navWidthRef.current = navWidth;
  configWidthRef.current = configWidth;

  const resizeRef = useRef<{
    edge: "nav" | "config";
    startX: number;
    startNav: number;
    startConfig: number;
  } | null>(null);

  const enforceLayoutLimits = useCallback(() => {
    const main = mainRef.current;
    if (!main) return;

    // Phone panes are full width; the persisted desktop sizes must not be clobbered.
    if (isPhone) return;

    let nav = navWidthRef.current;
    let config = configWidthRef.current;

    if (!navInFlow) {
      if (showVisualization && showConfig) {
        config = clamp(
          config,
          CONFIG_MIN,
          maxConfigWidthForLayout(main, 0, showConfig, showVisualization, false)
        );
      }
    } else if (showVisualization && showConfig) {
      config = clamp(
        config,
        CONFIG_MIN,
        maxConfigWidthForLayout(main, nav, showConfig, showVisualization)
      );
      nav = clamp(nav, NAV_MIN, maxNavWidthForLayout(main, config, showConfig, showVisualization));
      config = clamp(
        config,
        CONFIG_MIN,
        maxConfigWidthForLayout(main, nav, showConfig, showVisualization)
      );
    } else if (showVisualization) {
      nav = clamp(nav, NAV_MIN, maxNavWidthForLayout(main, 0, showConfig, showVisualization));
    }

    if (nav !== navWidthRef.current) setNavWidth(nav);
    if (config !== configWidthRef.current) setConfigWidth(config);
  }, [showConfig, showVisualization, isPhone, navInFlow]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const r = resizeRef.current;
      const main = mainRef.current;
      if (!r || !main) return;
      const dx = event.clientX - r.startX;
      if (r.edge === "nav") {
        const maxNav = maxNavWidthForLayout(main, r.startConfig, showConfig, showVisualization);
        setNavWidth(clamp(r.startNav + dx, NAV_MIN, maxNav));
      } else {
        // Handle sits on the config panel's right edge: drag right → wider config.
        const maxConfig = maxConfigWidthForLayout(
          main,
          r.startNav,
          showConfig,
          showVisualization,
          navInFlow
        );
        setConfigWidth(clamp(r.startConfig + dx, CONFIG_MIN, maxConfig));
      }
    },
    [showConfig, showVisualization, navInFlow]
  );

  const endResize = useCallback(() => {
    resizeRef.current = null;
    document.body.classList.remove("layoutResizing");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endResize);
    enforceLayoutLimits();
    uiPersistence.setNavWidth(navWidthRef.current);
    uiPersistence.setConfigWidth(configWidthRef.current);
  }, [onPointerMove, enforceLayoutLimits]);

  const startResize = useCallback(
    (edge: "nav" | "config") => (event: React.PointerEvent) => {
      event.preventDefault();
      resizeRef.current = {
        edge,
        startX: event.clientX,
        startNav: navWidth,
        startConfig: configWidth
      };
      document.body.classList.add("layoutResizing");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endResize);
    },
    [navWidth, configWidth, onPointerMove, endResize]
  );

  useEffect(() => () => endResize(), [endResize]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    enforceLayoutLimits();
    const observer = new ResizeObserver(() => enforceLayoutLimits());
    observer.observe(main);
    return () => observer.disconnect();
  }, [enforceLayoutLimits]);

  useEffect(() => {
    if (!isTablet || !navDrawerOpen || !onCloseNavDrawer) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseNavDrawer?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isTablet, navDrawerOpen, onCloseNavDrawer]);

  const layoutClass = [
    "layoutResizable",
    `layoutMode-${mode}`,
    isPhone && `layoutPane-${mobilePane}`,
    isTablet && navDrawerOpen && "layoutNavDrawerOpen",
    !renderViz && "layoutVizHidden",
    !renderConfig && "layoutConfigHidden"
  ]
    .filter(Boolean)
    .join(" ");

  const configWidthStyle = isPhone || !renderViz ? undefined : { width: configWidth };

  return (
    <main
      ref={mainRef}
      className={layoutClass}
      style={
        {
          "--nav-width": `${navWidth}px`,
          "--config-width": `${configWidth}px`
        } as React.CSSProperties
      }
    >
      <aside
        ref={navSlotRef}
        className="layoutNavSlot"
        style={navInFlow ? { width: navWidth } : undefined}
        aria-hidden={isTablet && !navDrawerOpen ? true : undefined}
      >
        {navigation}
      </aside>

      {isTablet && navDrawerOpen ? (
        <button
          type="button"
          className="layoutNavDrawerScrim"
          aria-label="Close navigation"
          data-testid="nav-drawer-scrim"
          onClick={onCloseNavDrawer}
        />
      ) : null}

      {navInFlow ? (
        <div
          className="layoutResizeHandle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize navigation panel"
          onPointerDown={startResize("nav")}
        />
      ) : null}

      {renderConfig ? (
        <aside
          ref={configSlotRef}
          className="layoutConfigSlot"
          data-tour="workbench"
          style={configWidthStyle}
        >
          {showConfig ? (
            config
          ) : (
            <EmptyPane testId="workbench-empty">
              Nothing is open yet. Choose a sequence or event from the menu, or press + to create
              one.
            </EmptyPane>
          )}
        </aside>
      ) : null}

      {!isPhone && renderConfig && renderViz ? (
        <div
          className="layoutResizeHandle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize configuration panel"
          onPointerDown={startResize("config")}
        />
      ) : null}

      {renderViz ? (
        <div ref={vizSlotRef} className="layoutVizSlot" data-tour="canvas">
          {showVisualization ? (
            visualization
          ) : (
            <EmptyPane testId="map-empty">
              The map appears here when you open a sequence or run one.
            </EmptyPane>
          )}
        </div>
      ) : null}
    </main>
  );
}
