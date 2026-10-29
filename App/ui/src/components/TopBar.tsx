import { Picker } from "./builder/Picker";
import "./builder/builder.css";

function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M9.8 2.8 4.5 8l5.3 5.2V2.8z" />
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
  showBackToBuilder: boolean;
  onBackToBuilder: () => void;
  showRunButton: boolean;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
  inFlightStatus?: "active" | "pending" | "waiting" | null;
  awaitingParams?: boolean;
  onStop?: () => void;
  /** Classic mode: return to the chat home screen. */
  onOpenChat?: () => void;
  /** Chat mode hides space settings; they live in classic mode. */
  showSpaceSettings?: boolean;
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
  showBackToBuilder,
  onBackToBuilder,
  showRunButton,
  canRun,
  running,
  onRun,
  inFlightStatus = null,
  awaitingParams = false,
  onStop,
  onOpenChat,
  showSpaceSettings = true
}: TopBarProps) {
  const parked = inFlightStatus === "waiting" || inFlightStatus === "active";
  const showStop = Boolean(onStop) && (parked || awaitingParams || inFlightStatus === "pending");
  const showRun = showRunButton && !parked;

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
      </div>
      <div className="topbarActions" data-tour="topbar-actions">
        {onOpenChat ? (
          <button type="button" className="topbarBackBtn" data-testid="topbar-chat-btn" onClick={onOpenChat}>
            Chat
          </button>
        ) : null}
        {showBackToBuilder ? (
          <button
            type="button"
            className="topbarBackBtn"
            data-testid="topbar-back-btn"
            aria-label="Back to workbench"
            onClick={onBackToBuilder}
          >
            <BackIcon />
            {compact ? "Workbench" : "Back to workbench"}
          </button>
        ) : null}
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
          {showSpaceSettings ? (
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
          ) : null}
        </span>
      </div>
    </header>
  );
}
