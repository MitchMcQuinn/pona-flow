import { useState } from "react";
import { isFollowUp } from "./followUp";
import { Markdown } from "./Markdown";
import type { ChatMessage, ChatThreadSummary } from "./types";

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
  onOpenThread: (threadId: string) => void;
  onNewThread: () => void;
  onAccept: () => void;
  onReject: () => void;
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
  onOpenThread,
  onNewThread,
  onAccept,
  onReject,
  onClearQueue
}: ChatColumnProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <section className="chatColumn" aria-label="Chat">
      <header className="chatHeader">
        <h1 className="chatTitle">chat</h1>
        <button
          type="button"
          className="tinyBtn"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          Threads
        </button>
      </header>
      {drawerOpen ? (
        <div className="chatDrawer" role="dialog" aria-label="Threads">
          <button
            type="button"
            className="btnPrimary"
            onClick={() => {
              onNewThread();
              setDrawerOpen(false);
            }}
          >
            New thread
          </button>
          <ul className="chatThreadList">
            {threads.length === 0 ? <li className="muted">No saved threads yet.</li> : null}
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
                  {thread.title || "Untitled"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="chatTranscript panel__body">
        {messages.length === 0 ? (
          <p className="muted">Ask for a console, a change, or an explanation of this space.</p>
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
                <div className="buttonRow">
                  <button type="button" className="btnPrimary" disabled={batchBusy} onClick={onAccept}>
                    Accept
                  </button>
                  <button type="button" disabled={batchBusy} onClick={onReject}>
                    Reject
                  </button>
                </div>
              </div>
            ) : null}
            {message.batch && message.batch.status !== "pending" ? (
              <p className="muted">
                Change {message.batch.status}.
                {message.batch.result?.failed
                  ? ` ${message.batch.result.failed.summary || message.batch.result.failed.kind} failed: ${message.batch.result.failed.error}`
                  : ""}
                {message.batch.result?.not_applied?.length
                  ? ` Not applied: ${message.batch.result.not_applied
                      .map((item) => item.summary || item.kind)
                      .join(", ")}.`
                  : ""}
              </p>
            ) : null}
          </article>
          );
        })}
        {streaming ? (
          <p className="chatThinking" role="status">
            thinking
            <span className="chatThinkingDots" aria-hidden="true">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </p>
        ) : null}
        {error ? <p className="errorText">{error}</p> : null}
      </div>
      {queued ? (
        <div className="chatQueue">
          <p>Waiting until you accept or reject: {queued}</p>
          <button type="button" onClick={onClearQueue}>
            Remove
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
          placeholder="Message"
          aria-label="Message"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <button type="submit" className="btnPrimary" disabled={streaming || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
