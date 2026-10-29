import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { newQuery, type Operation } from "@pona-flow/authoring";
import { BuilderPanel } from "../components/builder/BuilderPanel";
import { EventBuilder, type EventPreviewDocument } from "../components/events/EventBuilder";
import type { QueryObject } from "../state/builder/types";
import type { SequenceSummary } from "../state/types";
import { EphemeralConsole } from "./EphemeralConsole";
import { Markdown } from "./Markdown";
import type { ChatStackItem, WalkthroughFrame, WalkthroughPin } from "./types";

interface WalkthroughProps {
  spaceId: string;
  item: ChatStackItem;
  sequences: SequenceSummary[];
}

export function Walkthrough({ spaceId, item, sequences }: WalkthroughProps) {
  const frames = useMemo(() => framesOf(item.payload.frames), [item]);
  const [index, setIndex] = useState(0);
  const [activePin, setActivePin] = useState<string | null>(null);
  const frame = frames[Math.min(index, Math.max(frames.length - 1, 0))] ?? null;

  useEffect(() => {
    setActivePin(null);
    document.querySelectorAll(".pinHighlight").forEach((node) => node.classList.remove("pinHighlight"));
  }, [index, item.id]);

  if (!frame) return <p className="muted">This walkthrough has no frames.</p>;

  function choosePin(target: string) {
    setActivePin(target);
    document.querySelectorAll(".pinHighlight").forEach((node) => node.classList.remove("pinHighlight"));
    const escaped = window.CSS?.escape ? window.CSS.escape(target) : target.replace(/"/g, '\\"');
    const node = document.querySelector(`[data-pin-target="${escaped}"]`);
    if (node instanceof HTMLElement) {
      node.classList.add("pinHighlight");
      node.scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <div className="walkthrough">
      <label className="walkthroughScrubber">
        <span>
          {frame.title || frame.view} ({index + 1} of {frames.length})
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(frames.length - 1, 0)}
          value={index}
          aria-label="Walkthrough frame"
          onChange={(event) => setIndex(Number(event.target.value))}
        />
      </label>
      <div className="walkthroughMain">
        <div className="walkthroughScreen">
          <PreviewBoundary resetKey={`${item.id}:${index}`}>
            <FrameScreen spaceId={spaceId} frame={frame} sequences={sequences} />
          </PreviewBoundary>
        </div>
        <aside className="walkthroughNote">
          <h2>{frame.title || frame.view}</h2>
          <div className="agentNote">
            <p className="agentNoteLabel">Agent note</p>
            {frame.note ? <Markdown text={frame.note} /> : <p className="muted">No note on this frame.</p>}
          </div>
          {frame.pins.length > 0 ? (
            <div className="agentNote">
              <p className="agentNoteLabel">Pinned notes</p>
              <ul className="walkthroughPins">
                {frame.pins.map((pin) => (
                  <li key={pin.target}>
                    <button
                      type="button"
                      className={activePin === pin.target ? "active" : undefined}
                      onClick={() => choosePin(pin.target)}
                    >
                      {pin.target}
                    </button>
                    {pin.note ? <Markdown text={pin.note} /> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function FrameScreen({
  spaceId,
  frame,
  sequences
}: {
  spaceId: string;
  frame: WalkthroughFrame;
  sequences: SequenceSummary[];
}) {
  if (frame.view === "console") {
    return (
      <EphemeralConsole
        spaceId={spaceId}
        sequences={sequences}
        item={{
          id: `walkthrough-${frame.title}`,
          kind: "ephemeral_console",
          title: frame.title,
          payload: { name: frame.title, document: consoleDocument(frame.document) },
          position: 0
        }}
      />
    );
  }
  if (frame.view === "event") {
    return <EventPreview spaceId={spaceId} frame={frame} sequences={sequences} />;
  }
  return <QueryPreview spaceId={spaceId} frame={frame} />;
}

function EventPreview({
  spaceId,
  frame,
  sequences
}: {
  spaceId: string;
  frame: WalkthroughFrame;
  sequences: SequenceSummary[];
}) {
  const preview = useMemo(() => eventDocument(frame.document), [frame]);
  return (
    <EventBuilder
      spaceId={spaceId}
      sequences={sequences}
      eventId={null}
      defaultTimezone={null}
      onSaved={() => undefined}
      onDeleted={() => undefined}
      consoles={[]}
      preview={preview}
    />
  );
}

function QueryPreview({ spaceId, frame }: { spaceId: string; frame: WalkthroughFrame }) {
  const preview = useMemo(() => {
    const query = queryDocument(frame.document);
    const name = typeof frame.document.name === "string" ? frame.document.name : query.name;
    const description =
      typeof frame.document.description === "string" ? frame.document.description : undefined;
    return { query, name, description };
  }, [frame]);
  return (
    <BuilderPanel
      spaceId={spaceId}
      createSequenceMode={frame.view === "sequence"}
      preview={preview}
    />
  );
}

function framesOf(raw: unknown): WalkthroughFrame[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const frame = entry as Partial<WalkthroughFrame>;
    const view = frame.view;
    if (view !== "workbench" && view !== "sequence" && view !== "event" && view !== "console") return [];
    const pins = Array.isArray(frame.pins)
      ? frame.pins.flatMap((pin) => {
          if (!pin || typeof pin !== "object") return [];
          const target = String((pin as WalkthroughPin).target || "").trim();
          if (!target) return [];
          return [{ target, note: String((pin as WalkthroughPin).note || "") }];
        })
      : [];
    return [
      {
        view,
        title: String(frame.title || view),
        note: String(frame.note || ""),
        pins,
        document:
          frame.document && typeof frame.document === "object" ? (frame.document as Record<string, unknown>) : {}
      }
    ];
  });
}

const queryOperations: readonly Operation[] = ["read", "create", "update", "delete"];

function queryDocument(document: Record<string, unknown>): QueryObject {
  const nested = document.query;
  const source =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : document;
  const operation: Operation = queryOperations.includes(source.operation as Operation)
    ? (source.operation as Operation)
    : "read";
  const query = newQuery(operation);
  if (typeof source.name === "string") query.name = source.name;
  if (typeof source.id === "string" && source.id) query.id = source.id;
  if (Array.isArray(source.parameters)) query.parameters = source.parameters as QueryObject["parameters"];
  if (Array.isArray(source.match) && source.match.length) query.match = source.match as QueryObject["match"];
  if (source.return && typeof source.return === "object" && !Array.isArray(source.return)) {
    query.return = source.return as QueryObject["return"];
  }
  if (Array.isArray(source.set)) query.set = source.set as QueryObject["set"];
  if (source.delete && typeof source.delete === "object" && !Array.isArray(source.delete)) {
    query.delete = source.delete as QueryObject["delete"];
  }
  return query;
}

function eventDocument(document: Record<string, unknown>): EventPreviewDocument {
  const nested = document.event;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as EventPreviewDocument;
  return document as EventPreviewDocument;
}

function consoleDocument(document: Record<string, unknown>): Record<string, unknown> {
  const nested = document.document;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  return document;
}

class PreviewBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || "This frame could not be shown." };
  }

  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) return <p className="errorText">{this.state.error}</p>;
    return this.props.children;
  }
}
