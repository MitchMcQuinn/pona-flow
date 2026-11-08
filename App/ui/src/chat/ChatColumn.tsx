import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { acceptBlockingProblems, inputProblemBlocksAccept, isFollowUp } from "./followUp";
import { Markdown } from "./Markdown";
import type { ChatMessage, ChatThreadSummary } from "./types";

/** How close to the end still counts as the bottom, so subpixel rounding stays pinned. */
const BOTTOM_SLOP_PX = 16;

function distanceFromBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 7 7 6.96 6.96 0 0 1-4.94-2.06l-1.42 1.42A8.95 8.95 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
    </svg>
  );
}

interface ChatColumnProps {
  threads: ChatThreadSummary[];
  threadId: string | null;
  messages: ChatMessage[];
  draft: string;
  queued: string | null;
  streaming: boolean;
  batchBusy: boolean;
  error: string | null;
  selectedMessageId?: string | null;
  onSelectMessage?: (messageId: string) => void;
  onSelectRead?: (messageId: string, index: number) => void;
  onDraft: (value: string) => void;
  onSend: () => void;
  onComposerFocus: (focused: boolean) => void;
  onOpenThread: (threadId: string) => void;
  onNewThread: () => void;
  onAccept: () => void;
  onReject: () => void;
  acceptBlocked?: string | null;
  onClearQueue: () => void;
}

export function ChatColumn({
  threads,
  threadId,
  messages,
  draft,
  queued,
  streaming,
  batchBusy,
  error,
  selectedMessageId,
  onSelectMessage,
  onSelectRead,
  onDraft,
  onSend,
  onComposerFocus,
  onOpenThread,
  onNewThread,
  onAccept,
  onReject,
  acceptBlocked = null,
  onClearQueue
}: ChatColumnProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const streamingRef = useRef(streaming);
  const threadRef = useRef(threadId);
  const lastScrollTop = useRef(0);
  const lastScrollHeight = useRef(0);
  const pinningRef = useRef(false);
  const pinRef = useRef(() => {});

  function rememberScroll(transcript: HTMLElement) {
    lastScrollTop.current = transcript.scrollTop;
    lastScrollHeight.current = transcript.scrollHeight;
  }

  function pinToBottom() {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    pinningRef.current = true;
    transcript.scrollTop = transcript.scrollHeight;
    rememberScroll(transcript);
    pinningRef.current = false;
  }

  pinRef.current = pinToBottom;

  function onTranscriptScroll() {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (pinningRef.current) {
      rememberScroll(transcript);
      return;
    }
    const topDelta = transcript.scrollTop - lastScrollTop.current;
    const heightDelta = transcript.scrollHeight - lastScrollHeight.current;
    rememberScroll(transcript);
    // A shorter transcript clamps scrollTop. That is not the user moving up.
    if (heightDelta < 0 && topDelta <= 0) {
      if (distanceFromBottom(transcript) <= BOTTOM_SLOP_PX) stickRef.current = true;
      return;
    }
    if (topDelta < -1) {
      stickRef.current = false;
      return;
    }
    if (distanceFromBottom(transcript) <= BOTTOM_SLOP_PX) stickRef.current = true;
  }

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const responseStarted = streaming && !streamingRef.current;
    const threadChanged = threadRef.current !== threadId;
    streamingRef.current = streaming;
    threadRef.current = threadId;
    if (responseStarted || threadChanged) stickRef.current = true;
    // A scroll event can arrive a frame after the position changes. If the
    // viewport has already moved up, keep that place instead of pinning.
    if (
      transcript &&
      !responseStarted &&
      !threadChanged &&
      distanceFromBottom(transcript) > BOTTOM_SLOP_PX &&
      transcript.scrollTop < lastScrollTop.current - 1
    ) {
      stickRef.current = false;
    }
    if (stickRef.current) pinToBottom();
  }, [messages, streaming, error, threadId]);

  useEffect(() => {
    const content = contentRef.current;
    const transcript = transcriptRef.current;
    if (!content || !transcript) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) pinRef.current();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="chatColumn" aria-label="chat">
      <header className="columnHead chatHeader">
        <h1 className="chatTitle">chat</h1>
        <div className="chatHeaderActions">
          <button
            type="button"
            className="navAddBtn"
            aria-label="new thread"
            title="new thread"
            onClick={() => {
              onNewThread();
              setDrawerOpen(false);
            }}
          >
            +
          </button>
          <button
            type="button"
            className="chatHistoryBtn"
            aria-label="threads"
            title="threads"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <HistoryIcon />
          </button>
        </div>
        <div
          className="chatDrawer"
          role="dialog"
          aria-label="threads"
          aria-hidden={!drawerOpen}
        >
          <ul className="chatThreadList">
            {threads.length === 0 ? <li className="muted">no saved threads yet.</li> : null}
            {threads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className={thread.id === threadId ? "active" : undefined}
                  onClick={() => {
                    void onOpenThread(thread.id);
                    setDrawerOpen(false);
                  }}
                >
                  {thread.title || "untitled"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </header>
      <div className="chatTranscript panel__body" ref={transcriptRef} onScroll={onTranscriptScroll}>
        <div className="chatTranscriptInner" ref={contentRef}>
        {messages.length === 0 ? (
          <p className="muted">ask for a console, a change, or an explanation of this space.</p>
        ) : null}
        {messages.map((message) => {
          if (message.role === "user" && isFollowUp(message.content)) return null;
          return (
          <article
            key={message.id}
            className={`chatMessage chatMessage-${message.role}${
              message.role === "assistant" && message.id === selectedMessageId ? " selected" : ""
            }`}
          >
            {message.role === "assistant" ? (
              <div
                className="chatMessageBody"
                role="button"
                tabIndex={0}
                onClick={() => onSelectMessage?.(message.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectMessage?.(message.id);
                  }
                }}
              >
                {message.content ? <Markdown text={message.content} /> : null}
              </div>
            ) : (
              <p>{message.content}</p>
            )}
            {message.tool_calls.length > 0 ? (
              <ul className="chatTools" onClick={(event) => event.stopPropagation()}>
                {message.tool_calls.map((call, index) =>
                  call.read_index != null ? (
                    <li key={`${call.name}-${index}`}>
                      <button
                        type="button"
                        className="chatToolButton"
                        onClick={() => onSelectRead?.(message.id, call.read_index as number)}
                      >
                        {call.summary || call.name}
                      </button>
                    </li>
                  ) : (
                    <li key={`${call.name}-${index}`}>{call.summary || call.name}</li>
                  )
                )}
              </ul>
            ) : null}
            {message.batch?.status === "pending" ? (
              <div className="chatBatch" onClick={(event) => event.stopPropagation()}>
                <p>
                  {message.batch.items.length} change{message.batch.items.length === 1 ? "" : "s"} waiting
                </p>
                {message.batch.items.some((item) => item.kind === "create_space") ? (
                  <p className="muted">
                    this instance already has its workspace, so this change cannot be applied.
                  </p>
                ) : null}
                {acceptBlocked ? <p className="builderCheckMsg error">{acceptBlocked}</p> : null}
                {(message.batch.problems || []).map((problem) => (
                  <p
                    key={problem}
                    className={inputProblemBlocksAccept(problem) ? "builderCheckMsg error" : "muted"}
                  >
                    {problem}
                  </p>
                ))}
                <div className="buttonRow">
                  <button
                    type="button"
                    className="btnPrimary"
                    disabled={
                      batchBusy ||
                      Boolean(acceptBlocked) ||
                      acceptBlockingProblems(message.batch.problems).length > 0 ||
                      message.batch.items.some((item) => item.kind === "create_space")
                    }
                    onClick={onAccept}
                  >
                    accept
                  </button>
                  <button type="button" disabled={batchBusy} onClick={onReject}>
                    reject
                  </button>
                </div>
              </div>
            ) : null}
            {message.batch && message.batch.status !== "pending" ? (
              <p className="muted">
                change {message.batch.status}.
                {message.batch.result?.failed
                  ? ` ${message.batch.result.failed.summary || message.batch.result.failed.kind} failed: ${message.batch.result.failed.error}`
                  : ""}
                {message.batch.result?.not_applied?.length
                  ? ` not applied: ${message.batch.result.not_applied
                      .map((item) => item.summary || item.kind)
                      .join(", ")}.`
                  : ""}
              </p>
            ) : null}
          </article>
          );
        })}
        {streaming ? (
          <p className="chatThinking" role="status" aria-label="thinking">
            <span className="chatThinkingDots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </p>
        ) : null}
        {error ? <p className="errorText">{error}</p> : null}
        </div>
      </div>
      {queued ? (
        <div className="chatQueue">
          <p>waiting until you accept or reject: {queued}</p>
          <button type="button" onClick={onClearQueue}>
            remove
          </button>
        </div>
      ) : null}
      <form
        className="chatComposer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <textarea
          value={draft}
          rows={3}
          placeholder="message"
          aria-label="message"
          onFocus={() => onComposerFocus(true)}
          onBlur={() => onComposerFocus(false)}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <button type="submit" className="btnPrimary" disabled={streaming || !draft.trim()}>
          send
        </button>
      </form>
    </section>
  );
}
