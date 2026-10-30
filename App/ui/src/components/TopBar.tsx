import { Picker } from "./builder/Picker";
import "./builder/builder.css";

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 0 1-3.476.383.39.39 0 0 0-.297.17l-2.755 4.133a.75.75 0 0 1-1.248 0l-2.755-4.133a.39.39 0 0 0-.297-.17 48.9 48.9 0 0 1-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M12 6.75a5.25 5.25 0 0 1 6.775-5.025.75.75 0 0 1 .313 1.248l-3.32 3.319c.063.475.276.934.641 1.299.365.365.824.578 1.3.64l3.318-3.319a.75.75 0 0 1 1.248.313 5.25 5.25 0 0 1-5.472 6.756c-1.018-.086-1.87.1-2.309.634L7.344 21.3A3.298 3.298 0 1 1 2.7 16.657l8.684-7.151c.533-.44.72-1.291.634-2.309A5.342 5.342 0 0 1 12 6.75ZM4.117 19.125a.75.75 0 0 1 .75-.75h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75h-.008a.75.75 0 0 1-.75-.75v-.008Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M5.25 3.5v9l7.25-4.5L5.25 3.5z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect fill="currentColor" x="4" y="4" width="8" height="8" rx="1" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M3 5h14v1.6H3V5zm0 4.2h14v1.6H3V9.2zm0 4.2h14V15H3v-1.6z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z" />
    </svg>
  );
}

interface TopBarProps {
  /** Phone/tablet: shorter button labels. */
  compact?: boolean;
  spaces: Array<{ id: string; label: string }>;
  selectedSpaceId: string | null;
  onSelectSpace: (spaceId: string) => void;
  onCreateSpace: () => void;
  canCreateSpace: boolean;
  spaceConfigActive: boolean;
  onOpenSpaceConfig: () => void;
  /** Tablet: toggles the navigation drawer. */
  onToggleNav?: () => void;
  navOpen?: boolean;
  /** Which home is showing. Its icon is hidden; only the other one is offered. */
  mode: "chat" | "classic";
  onOpenChat: () => void;
  onOpenWorkbench: () => void;
  showRunButton: boolean;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
  inFlightStatus?: "active" | "pending" | "waiting" | null;
  awaitingParams?: boolean;
  onStop?: () => void;
}

export function TopBar({
  compact = false,
  spaces,
  selectedSpaceId,
  onSelectSpace,
  onCreateSpace,
  canCreateSpace,
  spaceConfigActive,
  onOpenSpaceConfig,
  onToggleNav,
  navOpen = false,
  mode,
  onOpenChat,
  onOpenWorkbench,
  showRunButton,
  canRun,
  running,
  onRun,
  inFlightStatus = null,
  awaitingParams = false,
  onStop
}: TopBarProps) {
  const parked = inFlightStatus === "waiting" || inFlightStatus === "active";
  const showStop = Boolean(onStop) && (parked || awaitingParams || inFlightStatus === "pending");
  const showRun = showRunButton && !parked;
  const chatActive = mode === "chat";

  return (
    <header className={`topbar${compact ? " topbarCompact" : ""}`}>
      <div className="topbarStart">
        {onToggleNav ? (
          <button
            type="button"
            className="topbarMenuBtn"
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpen}
            data-testid="topbar-nav-toggle"
            data-tour="nav-toggle"
            onClick={onToggleNav}
          >
            <MenuIcon />
          </button>
        ) : null}
        <Picker
          id="space-selector"
          ariaLabel="Space"
          dataTour="space-picker"
          className="topbarSpacePicker"
          toggleClassName="topbarSpaceSelect"
          toggleTestId="space-selector-toggle"
          menuTestId="space-selector-menu"
          caret="end"
          menuFit="content"
          value={selectedSpaceId || ""}
          placeholder="Select a space"
          options={spaces.map((space) => ({ value: space.id, label: space.label }))}
          onSelect={onSelectSpace}
          emptyHint="No spaces yet."
        />
        <div className="topbarModeSwitch" role="group" aria-label="View">
          {chatActive ? null : (
            <button
              type="button"
              className="topbarModeBtn"
              data-testid="topbar-chat-btn"
              aria-label="Chat"
              title="Chat"
              onClick={onOpenChat}
            >
              <ChatIcon />
            </button>
          )}
          {chatActive ? (
            <button
              type="button"
              className="topbarModeBtn"
              data-testid="topbar-back-btn"
              aria-label="Workbench"
              title="Workbench"
              onClick={onOpenWorkbench}
            >
              <WrenchIcon />
            </button>
          ) : null}
        </div>
      </div>
      <div className="topbarActions" data-tour="topbar-actions">
        {showStop ? (
          <button
            type="button"
            className="btnDanger topbarStopBtn"
            data-testid="topbar-stop-btn"
            aria-label="Stop sequence"
            onClick={onStop}
          >
            <StopIcon />
            {compact ? "Stop" : "Stop Sequence"}
          </button>
        ) : null}
        {showRun ? (
          <button
            className="btnPrimary topbarRunBtn"
            data-testid="topbar-run-btn"
            aria-label="Run sequence"
            onClick={onRun}
            disabled={!canRun}
          >
            {!running ? <PlayIcon /> : null}
            {running ? "Running..." : compact ? "Run" : "Run Sequence"}
          </button>
        ) : null}
        <span className="topbarSpaceActions">
          {canCreateSpace ? (
            <button
              type="button"
              className="navAddBtn"
              aria-label="Create space"
              data-testid="nav-create-space"
              onClick={onCreateSpace}
            >
              +
            </button>
          ) : null}
          <button
            type="button"
            className={`tinyBtn tinyBtnIcon navSpaceConfigBtn${spaceConfigActive ? " active" : ""}`}
            aria-label="Open space settings"
            title="Space settings"
            data-testid="nav-space-settings"
            data-tour="space-settings"
            disabled={!selectedSpaceId}
            onClick={onOpenSpaceConfig}
          >
            <GearIcon />
          </button>
        </span>
      </div>
    </header>
  );
}
