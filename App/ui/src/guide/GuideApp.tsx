import { FormEvent, useState } from "react";
import { AgentFace } from "../chat/AgentFace";
import { Markdown } from "../chat/Markdown";
import { guideApi } from "./api";
import { Wizard } from "./Wizard";
import "../styles.css";
import "./guide.css";

type ChatMessage = { role: "user" | "assistant"; content: string };

export function GuideApp() {
  const [mode, setMode] = useState<"chat" | "wizard">("chat");
  const [locked, setLocked] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const data = await guideApi("/api/guide/chat", { messages: next });
      setMessages([...next, { role: "assistant", content: String(data.reply || "") }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The guide could not reply.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="guideShell">
      <header className="topbar">
        <div className="topbarStart">
          <span className="topbarSpaceName">pona flow</span>
        </div>
        <div className="topbarActions">
          {mode === "wizard" && !locked ? (
            <button type="button" data-testid="guide-back" onClick={() => setMode("chat")}>
              Back to chat
            </button>
          ) : null}
          <button
            type="button"
            className="btnPrimary"
            data-testid="guide-get-started"
            onClick={() => setMode("wizard")}
          >
            Get started
          </button>
        </div>
      </header>
      {mode === "chat" ? (
        <div className="guideStage">
          <section className="chatColumn guideChat" aria-label="Chat">
            <div className="guideFace">
              <div className="guideFaceBody">
                <AgentFace />
                <div className="guideHello">
                  <h1>hi im pona</h1>
                  <h2>how can i help</h2>
                </div>
              </div>
            </div>
            <div className="guideDivider" aria-hidden="true" />
            <header className="columnHead guideChatHead">
              <h1 className="chatTitle">chat with pona</h1>
            </header>
            <div className="chatTranscript">
              <div className="chatTranscriptInner">
                {messages.map((message, index) => (
                  <article key={`${message.role}-${index}`} className={`chatMessage chatMessage-${message.role}`}>
                    {message.role === "assistant" ? (
                      <div className="chatMessageBody">
                        <Markdown text={message.content} />
                      </div>
                    ) : (
                      <p>{message.content}</p>
                    )}
                  </article>
                ))}
                {busy ? <p className="muted">Thinking...</p> : null}
                {error ? <p className="errorText">{error}</p> : null}
              </div>
            </div>
            <form
              className="chatComposer"
              onSubmit={(event) => void send(event)}
            >
              <textarea
                value={draft}
                rows={3}
                placeholder="Ask about pona flow"
                aria-label="Message"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <button type="submit" className="btnPrimary" disabled={busy || !draft.trim()}>
                Send
              </button>
            </form>
          </section>
        </div>
      ) : (
        <Wizard onLock={setLocked} />
      )}
    </div>
  );
}
