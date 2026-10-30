import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { EventBuilder } from "../components/events/EventBuilder";
import type { SequenceSummary } from "../state/types";
import { ConsoleConfigPreview, QueryConfig, sequenceStubs } from "./ConfigPreview";
import { eventPreviewFrom } from "./eventPreviewDocument";
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
      <div className="walkthroughScrubber">
        <input
          type="range"
          min={0}
          max={Math.max(frames.length - 1, 0)}
          value={index}
          aria-label="Walkthrough frame"
          onChange={(event) => setIndex(Number(event.target.value))}
        />
        <span>
          {frame.title || frame.view} ({index + 1} of {frames.length})
        </span>
      </div>
      <FrameNotes frame={frame} activePin={activePin} onChoosePin={choosePin} />
      <div className="walkthroughScreen">
        <PreviewBoundary resetKey={`${item.id}:${index}`}>
          <FrameScreen spaceId={spaceId} frame={frame} sequences={sequences} />
        </PreviewBoundary>
      </div>
      <FrameNotes frame={frame} activePin={activePin} onChoosePin={choosePin} pinsOnly />
    </div>
  );
}

function FrameNotes({
  frame,
  activePin,
  onChoosePin,
  pinsOnly = false
}: {
  frame: WalkthroughFrame;
  activePin: string | null;
  onChoosePin: (target: string) => void;
  pinsOnly?: boolean;
}) {
  if (pinsOnly) {
    if (frame.pins.length === 0) return null;
    return (
      <div className="agentNote">
        <p className="agentNoteLabel">Pinned notes</p>
        <ul className="walkthroughPins">
          {frame.pins.map((pin) => (
            <li key={pin.target}>
              <button
                type="button"
                className={activePin === pin.target ? "active" : undefined}
                onClick={() => onChoosePin(pin.target)}
              >
                {pin.target}
              </button>
              {pin.note ? <Markdown text={pin.note} /> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (!frame.note) return null;
  return (
    <div className="agentNote">
      <p className="agentNoteLabel">Agent note</p>
      <Markdown text={frame.note} />
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
      <ConsoleConfigPreview
        name={frame.title}
        document={consoleDocument(frame.document)}
        sequences={sequences}
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
  const preview = useMemo(
    () => eventPreviewFrom(frame.document, { note: frame.note, pins: frame.pins }),
    [frame]
  );
  const listed = useMemo(() => {
    const ids = [...(preview.sequences ?? []), ...(preview.recovery_sequences ?? [])];
    return sequenceStubs(ids, sequences);
  }, [preview, sequences]);
  return (
    <EventBuilder
      spaceId={spaceId}
      sequences={listed}
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
  const payload = useMemo(
    () => ({
      ...frame.document,
      kind: frame.view === "sequence" ? "sequence" : frame.document.kind
    }),
    [frame]
  );
  return <QueryConfig spaceId={spaceId} payload={payload} />;
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
