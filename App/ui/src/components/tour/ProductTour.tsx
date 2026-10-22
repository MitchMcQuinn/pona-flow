import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MobilePane } from "../layout/ResizableDashboardLayout";
import type { ViewportMode } from "../../hooks/useViewport";
import { tourStepsFor } from "./tourSteps";

const SPOTLIGHT_PAD = 6;
const VIEWPORT_MARGIN = 12;
const CARD_GAP = 14;
const SWIPE_MIN_PX = 50;
/** Longer than the tablet drawer's slide so the spotlight lands on its final position. */
const PANE_SETTLE_MS = 280;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

type CardPos = { top: number; left: number } | { sheet: "top" | "bottom" };

function findTarget(target: string | undefined): HTMLElement | null {
  if (!target) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

function measure(el: HTMLElement | null): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: r.top - SPOTLIGHT_PAD,
    left: r.left - SPOTLIGHT_PAD,
    width: r.width + SPOTLIGHT_PAD * 2,
    height: r.height + SPOTLIGHT_PAD * 2
  };
}

/** Put the card on whichever side of the spotlight has room, clamped to the viewport. */
function placeCard(spot: Box | null, card: { width: number; height: number }): CardPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) =>
    Math.min(Math.max(x, VIEWPORT_MARGIN), vw - card.width - VIEWPORT_MARGIN);
  const clampY = (y: number) =>
    Math.min(Math.max(y, VIEWPORT_MARGIN), vh - card.height - VIEWPORT_MARGIN);
  if (!spot) {
    return { top: clampY((vh - card.height) / 2), left: clampX((vw - card.width) / 2) };
  }
  const room = {
    right: vw - (spot.left + spot.width) - CARD_GAP,
    left: spot.left - CARD_GAP,
    bottom: vh - (spot.top + spot.height) - CARD_GAP,
    top: spot.top - CARD_GAP
  };
  const midY = spot.top + spot.height / 2 - card.height / 2;
  const midX = spot.left + spot.width / 2 - card.width / 2;
  if (room.right >= card.width + VIEWPORT_MARGIN) {
    return { top: clampY(midY), left: spot.left + spot.width + CARD_GAP };
  }
  if (room.left >= card.width + VIEWPORT_MARGIN) {
    return { top: clampY(midY), left: spot.left - CARD_GAP - card.width };
  }
  if (room.bottom >= card.height + VIEWPORT_MARGIN) {
    return { top: spot.top + spot.height + CARD_GAP, left: clampX(midX) };
  }
  if (room.top >= card.height + VIEWPORT_MARGIN) {
    return { top: spot.top - CARD_GAP - card.height, left: clampX(midX) };
  }
  // Target fills the screen (e.g. a wide workbench): float the card over its middle.
  return { top: clampY(midY), left: clampX(midX) };
}

/** Phones: a full-width sheet on the opposite half of the screen from the spotlight. */
function placeSheet(spot: Box | null): CardPos {
  if (!spot) return { sheet: "bottom" };
  return { sheet: spot.top + spot.height / 2 > window.innerHeight / 2 ? "top" : "bottom" };
}

interface ProductTourProps {
  open: boolean;
  onClose: () => void;
  mode?: ViewportMode;
  /** Bring a step's screen into view (phone tab / tablet drawer); null = leave as is. */
  onShowPane?: (pane: MobilePane | null) => void;
}

export function ProductTour({ open, onClose, mode = "desktop", onShowPane }: ProductTourProps) {
  const steps = useMemo(() => tourStepsFor(mode), [mode]);
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Box | null>(null);
  const [cardPos, setCardPos] = useState<CardPos | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const isPhone = mode === "phone";
  const safeIndex = Math.min(index, steps.length - 1);
  const step = steps[safeIndex];
  const isFirst = safeIndex === 0;
  const isLast = safeIndex === steps.length - 1;
  const target = isPhone && step?.phoneTarget ? step.phoneTarget : step?.target;

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const relayout = useCallback(() => {
    const nextSpot = measure(findTarget(target));
    setSpot(nextSpot);
    const card = cardRef.current;
    if (isPhone) {
      setCardPos(placeSheet(nextSpot));
    } else if (card) {
      setCardPos(placeCard(nextSpot, { width: card.offsetWidth, height: card.offsetHeight }));
    }
  }, [target, isPhone]);

  useLayoutEffect(() => {
    if (!open || !step) return;
    onShowPane?.(step.pane ?? null);
    findTarget(target)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    relayout();
    // Switching panes re-renders the app after this effect; measure again once it settles.
    const raf = window.requestAnimationFrame(relayout);
    const settle = window.setTimeout(relayout, PANE_SETTLE_MS);
    // The panels load content asynchronously, so keep following size/position changes.
    const observer = new ResizeObserver(() => relayout());
    observer.observe(document.body);
    if (cardRef.current) observer.observe(cardRef.current);
    const el = findTarget(target);
    if (el) observer.observe(el);
    window.addEventListener("resize", relayout);
    window.addEventListener("scroll", relayout, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      observer.disconnect();
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", relayout, true);
    };
  }, [open, step, target, relayout, onShowPane]);

  useEffect(() => {
    if (open) primaryRef.current?.focus({ preventScroll: true });
  }, [open, safeIndex]);

  const close = useCallback(() => {
    onShowPane?.(null);
    onClose();
  }, [onClose, onShowPane]);

  const next = useCallback(() => {
    if (isLast) close();
    else setIndex((i) => i + 1);
  }, [isLast, close]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, next, back, close]);

  if (!open || !step) return null;

  const stepBody = isPhone && step.phoneBody ? step.phoneBody : step.body;
  const body = step.target && !spot && step.missingBody ? step.missingBody : stepBody;

  const sheet = cardPos && "sheet" in cardPos ? cardPos.sheet : isPhone ? "bottom" : null;
  const cardStyle: React.CSSProperties | undefined = sheet
    ? undefined
    : cardPos && "top" in cardPos
      ? { top: cardPos.top, left: cardPos.left }
      : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };

  return (
    <div className="tourRoot" data-testid="product-tour">
      {spot ? (
        <div
          className="tourSpotlight"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
        />
      ) : (
        <div className="tourBackdrop" />
      )}
      <div
        ref={cardRef}
        className={`tourCard${sheet ? ` tourCardSheet tourCardSheet-${sheet}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        data-testid="tour-card"
        data-sheet={sheet ?? undefined}
        style={cardStyle}
        onPointerDown={(e) => {
          if (e.pointerType !== "mouse") swipeStart.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const start = swipeStart.current;
          swipeStart.current = null;
          if (!start) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
          if (dx < 0) next();
          else back();
        }}
        onPointerCancel={() => {
          swipeStart.current = null;
        }}
      >
        <div className="tourCardHead">
          <span className="tourProgress">
            {safeIndex + 1} of {steps.length}
          </span>
          {!isLast ? (
            <button type="button" className="tourSkip" data-testid="tour-skip" onClick={close}>
              Skip tour
            </button>
          ) : null}
        </div>
        <h1 id="tour-title" className="tourTitle">
          {step.title}
        </h1>
        <div className="tourBody">{body}</div>
        <div className="tourFooter">
          <div className="tourDots" aria-hidden="true">
            {steps.map((s, i) => (
              <span key={s.id} className={`tourDot${i === safeIndex ? " active" : ""}`} />
            ))}
          </div>
          <div className="tourNav">
            {!isFirst ? (
              <button type="button" data-testid="tour-back" onClick={back}>
                Back
              </button>
            ) : null}
            <button
              ref={primaryRef}
              type="button"
              className="btnPrimary"
              data-testid="tour-next"
              onClick={next}
            >
              {isFirst ? "Show me around" : isLast ? "Finish" : "Next"}
            </button>
          </div>
        </div>
        {isPhone && !isLast ? <p className="tourSwipeHint">Swipe to move between steps</p> : null}
      </div>
    </div>
  );
}
