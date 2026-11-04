import type { ReactNode } from "react";
import { AgentFace } from "../../chat/AgentFace";

/** Chat column plus the canvas, matching the signed-in workbench before a session exists. */
export function SignedOutLayout({ children }: { children: ReactNode }) {
  return (
    <div className="appRoot signedOutRoot">
      <div className="signedOutChat">{children}</div>
      <div className="signedOutDivider" aria-hidden="true" />
      <section className="panel canvasStack signedOutCanvas" aria-label="Canvas">
        <div className="canvasTabs" role="tablist">
          <span className="muted">Canvas</span>
        </div>
        <div className="panel__body canvasBody">
          <AgentFace />
        </div>
      </section>
    </div>
  );
}
