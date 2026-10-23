import { useEffect, useState } from "react";
import {
  clearEventTestCapture,
  fetchEventTestCapture,
  type EventTestCapture
} from "../../services/api";
import { EventInlineField } from "./EventInlineField";

interface EventTestListenerProps {
  /** Saved event id. Null while the event has not been created yet. */
  eventId: string | null;
  /** Ingest token minted on first save; empty until then. */
  ingestToken: string;
  /** True when the form currently has a signing secret, saved or not. */
  signed: boolean;
}

function apiOrigin(): string {
  if (typeof window !== "undefined" && window.location) return window.location.origin;
  return "";
}

function formatReceived(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function CopyField({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="agentTokenCode">
      <code data-testid={testId}>{value}</code>
      <button type="button" className="btnPrimary" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Test door for an external event: a URL that stores the posted body and a live
 * view of that body. Posting here does not run the event's sequences.
 */
export function EventTestListener({ eventId, ingestToken, signed }: EventTestListenerProps) {
  const testUrl = ingestToken ? `${apiOrigin()}/api/hooks/${ingestToken}/test` : "";
  const [capture, setCapture] = useState<EventTestCapture | null>(null);
  const [listening, setListening] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCapture(null);
    setError(null);
  }, [eventId]);

  useEffect(() => {
    if (!eventId || !ingestToken) {
      setListening(false);
      return;
    }
    let cancelled = false;

    async function poll() {
      if (cancelled || document.hidden) return;
      try {
        const next = await fetchEventTestCapture(eventId as string);
        if (cancelled) return;
        setError(null);
        setCapture(next);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to listen for a test payload");
        }
      }
    }

    setListening(true);
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    function onVisible() {
      if (!document.hidden) void poll();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      setListening(false);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [eventId, ingestToken]);

  async function clear() {
    if (!eventId || clearing) return;
    setClearing(true);
    setError(null);
    try {
      await clearEventTestCapture(eventId);
      setCapture(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to clear the test payload");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="eventTest" data-testid="event-test-endpoint">
      <EventInlineField
        label="test endpoint"
        tip={
          signed
            ? "POST a sample payload here to preview it. Sequences do not run. Send X-Pona-Signature when a signing secret is set."
            : "POST a sample payload here to preview it. Sequences do not run."
        }
      >
        {testUrl ? (
          <CopyField value={testUrl} testId="event-test-url" />
        ) : (
          <p className="muted">Save to generate a test endpoint.</p>
        )}
      </EventInlineField>

      {testUrl ? (
        <div className="eventTestMeta">
          {listening ? <span className="eventTestLive">Listening</span> : null}
          {capture ? (
            <span className="eventHint">Received {formatReceived(capture.receivedAt)}</span>
          ) : (
            <span className="muted">Waiting for a request…</span>
          )}
          {capture ? (
            <button type="button" className="tinyBtn" disabled={clearing} onClick={clear}>
              {clearing ? "Clearing…" : "Clear"}
            </button>
          ) : null}
        </div>
      ) : null}

      {capture ? (
        <pre className="eventTestPayload" data-testid="event-test-payload" aria-live="polite">
          {JSON.stringify(capture.payload, null, 2)}
        </pre>
      ) : null}

      {error ? <p className="errorText">{error}</p> : null}
    </div>
  );
}
