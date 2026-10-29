import type { ReactNode } from "react";
import type { MobilePane } from "./ResizableDashboardLayout";

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 5h14v1.6H3V5zm0 4.2h14v1.6H3V9.2zm0 4.2h14V15H3v-1.6z"
      />
    </svg>
  );
}

function WorkbenchIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 3h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm.6 1.6v10.8h10.8V4.6H4.6zM6 6.5h8V8H6V6.5zm0 3h8V11H6V9.5zm0 3h5V14H6v-1.5z"
      />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5 4.5a2 2 0 1 1-.01 0H5zm10 2a2 2 0 1 1-.01 0H15zM8 13a2 2 0 1 1-.01 0H8zM6.3 7.6l1.2 3.8-1.4.4-1.2-3.8 1.4-.4zm7.3.2.8 1.2-5 3.4-.8-1.2 5-3.4zM6.7 5.6l6.4 1.3-.3 1.5-6.4-1.3.3-1.5z"
      />
    </svg>
  );
}

const TABS: Array<{ pane: MobilePane; label: string; icon: ReactNode }> = [
  { pane: "menu", label: "Menu", icon: <MenuIcon /> },
  { pane: "workbench", label: "Workbench", icon: <WorkbenchIcon /> },
  { pane: "map", label: "Map", icon: <MapIcon /> }
];

interface MobileTabBarProps {
  active: MobilePane;
  onChange: (pane: MobilePane) => void;
  /** Panes with something new the person hasn't looked at yet (e.g. a finished run). */
  unseen?: Partial<Record<MobilePane, boolean>>;
  /** Chat mode uses Chat and Canvas instead of Menu, Workbench, and Map. */
  chatMode?: boolean;
}

export function MobileTabBar({ active, onChange, unseen = {}, chatMode = false }: MobileTabBarProps) {
  const tabs = chatMode
    ? [
        { pane: "menu" as const, label: "Chat", icon: <MenuIcon /> },
        { pane: "map" as const, label: "Canvas", icon: <MapIcon /> }
      ]
    : TABS;
  return (
    <nav className="mobileTabBar" aria-label="Screens" data-tour="mobile-tabs">
      {tabs.map((tab) => {
        const isActive = tab.pane === active;
        return (
          <button
            key={tab.pane}
            type="button"
            className={`mobileTab${isActive ? " active" : ""}`}
            aria-current={isActive ? "page" : undefined}
            data-testid={`mobile-tab-${tab.pane}`}
            data-tour={`mobile-tab-${tab.pane}`}
            onClick={() => onChange(tab.pane)}
          >
            <span className="mobileTabIcon">
              {tab.icon}
              {unseen[tab.pane] && !isActive ? (
                <span className="mobileTabDot" aria-label="new" />
              ) : null}
            </span>
            <span className="mobileTabLabel">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
