import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

interface PendingConfirm {
  message: string;
  resolve: (accepted: boolean) => void;
}

let current: PendingConfirm | null = null;
const queue: PendingConfirm[] = [];
let notify: ((pending: PendingConfirm | null) => void) | null = null;

function publish() {
  notify?.(current);
}

function settle(accepted: boolean) {
  const pending = current;
  current = queue.shift() ?? null;
  pending?.resolve(accepted);
  publish();
}

/** Ask the user to confirm. Resolves true for OK and false for Cancel. */
export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const pending = { message, resolve };
    if (current) {
      queue.push(pending);
      return;
    }
    current = pending;
    publish();
  });
}

export function ConfirmDialogHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(current);
  const okRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    notify = setPending;
    setPending(current);
    return () => {
      notify = null;
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    okRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [pending]);

  if (!pending) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      settle(false);
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = cardRef.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!buttons || buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="confirmCardBackdrop" onMouseDown={() => settle(false)}>
      <div
        ref={cardRef}
        className="confirmCard"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-card-message"
        data-testid="confirm-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <p id="confirm-card-message">{pending.message}</p>
        <div className="confirmCardActions">
          <button type="button" data-testid="confirm-cancel" onClick={() => settle(false)}>
            Cancel
          </button>
          <button
            ref={okRef}
            type="button"
            data-testid="confirm-ok"
            onClick={() => settle(true)}
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
