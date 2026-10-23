import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

const TIP_GAP = 6;
const VIEWPORT_PAD = 8;

function positionTip(mark: HTMLElement, bubble: HTMLElement): CSSProperties {
  const rect = mark.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;

  let left = rect.left;
  if (left + width > vw - VIEWPORT_PAD) left = rect.right - width;
  if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
  if (left + width > vw - VIEWPORT_PAD) left = Math.max(VIEWPORT_PAD, vw - VIEWPORT_PAD - width);

  let top = rect.bottom + TIP_GAP;
  if (top + height > vh - VIEWPORT_PAD && rect.top - TIP_GAP - height >= VIEWPORT_PAD) {
    top = rect.top - TIP_GAP - height;
  } else if (top + height > vh - VIEWPORT_PAD) {
    top = Math.max(VIEWPORT_PAD, vh - VIEWPORT_PAD - height);
  }

  return { position: "fixed", top, left, zIndex: 1200 };
}

export function FieldTip({ text }: { text: string }) {
  const tipId = useId();
  const markRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open) return;
    const mark = markRef.current;
    const bubble = bubbleRef.current;
    if (!mark || !bubble) return;

    function place() {
      if (!markRef.current || !bubbleRef.current) return;
      setStyle(positionTip(markRef.current, bubbleRef.current));
    }

    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, text]);

  return (
    <span
      className="builderTip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={markRef}
        type="button"
        className="builderTipMark"
        aria-label="More information"
        aria-describedby={tipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open
        ? createPortal(
            <span
              ref={bubbleRef}
              id={tipId}
              className="builderTipBubble isOpen"
              role="tooltip"
              style={style}
            >
              {text}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

export function FieldLabel({
  htmlFor,
  tip,
  children
}: {
  htmlFor?: string;
  tip?: string;
  children: ReactNode;
}) {
  return (
    <div className="createSequenceLabelRow">
      <label htmlFor={htmlFor}>{children}</label>
      {tip ? <FieldTip text={tip} /> : null}
    </div>
  );
}
