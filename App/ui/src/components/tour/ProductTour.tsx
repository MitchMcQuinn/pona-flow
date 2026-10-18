import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TOUR_STEPS } from "./tourSteps";

const SPOTLIGHT_PAD = 6;
const VIEWPORT_MARGIN = 12;
const CARD_GAP = 14;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

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
function placeCard(spot: Box | null, card: { width: number; height: number }) {
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

interface ProductTourProps {
  open: boolean;
  onClose: () => void;
}

export function ProductTour({ open, onClose }: ProductTourProps) {
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Box | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const step = TOUR_STEPS[index];
  const isFirst = index === 0;
  const isLast = index === TOUR_STEPS.length - 1;

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const relayout = useCallback(() => {
    const el = findTarget(step?.target);
    const nextSpot = measure(el);
    setSpot(nextSpot);
    const card = cardRef.current;
    if (card) {
      setCardPos(placeCard(nextSpot, { width: card.offsetWidth, height: card.offsetHeight }));
    }
  }, [step]);

  useLayoutEffect(() => {
    if (!open || !step) return;
    findTarget(step.target)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    relayout();
    // The panels load content asynchronously, so keep following size/position changes.
    const observer = new ResizeObserver(() => relayout());
    observer.observe(document.body);
    if (cardRef.current) observer.observe(cardRef.current);
    const target = findTarget(step.target);
    if (target) observer.observe(target);
    window.addEventListener("resize", relayout);
    window.addEventListener("scroll", relayout, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", relayout, true);
    };
  }, [open, step, relayout]);

  useEffect(() => {
    if (open) primaryRef.current?.focus();
  }, [open, index]);

  const next = useCallback(() => {
    if (isLast) onClose();
    else setIndex((i) => i + 1);
  }, [isLast, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
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
  }, [open, next, back, onClose]);

  if (!open || !step) return null;

  const body = step.target && !spot && step.missingBody ? step.missingBody : step.body;

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
        className="tourCard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        style={
          cardPos
            ? { top: cardPos.top, left: cardPos.left }
            : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
        }
      >
        <div className="tourCardHead">
          <span className="tourProgress">
            {index + 1} of {TOUR_STEPS.length}
          </span>
          {!isLast ? (
            <button
              type="button"
              className="tourSkip"
              data-testid="tour-skip"
              onClick={onClose}
            >
              Skip tour
            </button>
          ) : null}
        </div>
        <h2 id="tour-title" className="tourTitle">
          {step.title}
        </h2>
        <div className="tourBody">{body}</div>
        <div className="tourFooter">
          <div className="tourDots" aria-hidden="true">
            {TOUR_STEPS.map((s, i) => (
              <span key={s.id} className={`tourDot${i === index ? " active" : ""}`} />
            ))}
          </div>
          <div className="tourNav">
            {!isFirst ? (
              <button type="button" onClick={back}>
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
      </div>
    </div>
  );
}
