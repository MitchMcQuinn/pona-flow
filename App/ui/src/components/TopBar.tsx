import logoUrl from "../../../assets/pona-flow-white.svg";

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

interface TopBarProps {
  /** Phone/tablet: shorter button labels and a smaller logo. */
  compact?: boolean;
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
}

export function TopBar({
  compact = false,
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
  onStop
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
        <img src={logoUrl} alt="pona flow" className="topbarLogo" />
      </div>
      <div className="topbarActions" data-tour="topbar-actions">
        {showBackToBuilder ? (
          <button
            type="button"
            className="topbarBackBtn"
            data-testid="topbar-back-btn"
            aria-label="Back to builder"
            onClick={onBackToBuilder}
          >
            <BackIcon />
            {compact ? "Builder" : "Back to builder"}
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
      </div>
    </header>
  );
}
