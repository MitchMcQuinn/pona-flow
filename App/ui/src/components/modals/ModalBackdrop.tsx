import { type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalBackdropProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/**
 * Full-screen modal backdrop rendered through a portal to `document.body`.
 *
 * Panels use transforms/filters for their neumorphism styling, which create a
 * containing block for `position: fixed`. A modal rendered inline inside a panel
 * is therefore trapped in that panel's stacking context and can slip underneath a
 * sibling panel (e.g. the visualizer). Portaling to the body root lets the backdrop
 * (and its z-index) sit above every panel regardless of where it originates.
 */
export function ModalBackdrop({ className, children, ...rest }: ModalBackdropProps) {
  return createPortal(
    <div className={`builderModalBackdrop${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </div>,
    document.body
  );
}
