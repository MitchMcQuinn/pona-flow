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

interface TopBarProps {
  showBackToBuilder: boolean;
  onBackToBuilder: () => void;
  showRunButton: boolean;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
}

export function TopBar({
  showBackToBuilder,
  onBackToBuilder,
  showRunButton,
  canRun,
  running,
  onRun
}: TopBarProps) {
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
        {showRunButton ? (
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
