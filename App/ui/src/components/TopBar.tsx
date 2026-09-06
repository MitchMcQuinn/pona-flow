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

interface TopBarProps {
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
    <header className="topbar">
      <img src={logoUrl} alt="pona flow" className="topbarLogo" />
      <div className="topbarActions">
        {showBackToBuilder ? (
          <button
            type="button"
            className="topbarBackBtn"
            data-testid="topbar-back-btn"
            onClick={onBackToBuilder}
          >
            <BackIcon />
            Back to builder
          </button>
        ) : null}
        {showStop ? (
          <button
            type="button"
            className="btnDanger topbarStopBtn"
            data-testid="topbar-stop-btn"
            onClick={onStop}
          >
            <StopIcon />
            Stop Sequence
          </button>
        ) : null}
        {showRun ? (
          <button
            className="btnPrimary topbarRunBtn"
            data-testid="topbar-run-btn"
            onClick={onRun}
            disabled={!canRun}
          >
            {!running ? <PlayIcon /> : null}
            {running ? "Running..." : "Run Sequence"}
          </button>
        ) : null}
      </div>
    </header>
  );
}
