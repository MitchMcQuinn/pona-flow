import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acceptChatBatch,
  addChatStackItem,
  ChatRequestError,
  fetchChatThread,
  fetchChatThreads,
  rejectChatBatch,
  setActiveChatStackItem,
  streamChatTurn,
  updateChatStackItem
} from "../services/api";
import { followUpPrompt } from "./followUp";
import { isInsightKind, resolveInsight, visibleCanvasId, type InsightRequest } from "./insight";
import type { ChatMessage, ChatStackItem, ChatThreadSummary } from "./types";

interface Options {
  spaceId: string | null;
  /** Refresh sequences, events, and consoles after a batch lands. */
  onApplied?: () => void;
  /** The batch created a space; switch the workbench into it. */
  onSpaceCreated?: (spaceId: string) => void;
}

export function useChatSession({ spaceId, onApplied, onSpaceCreated }: Options) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stack, setStack] = useState<ChatStackItem[]>([]);
  const [activeStackId, setActiveStackId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [queued, setQueued] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnStatus, setTurnStatus] = useState<"idle" | "running">("idle");
  const [round, setRound] = useState<{ index: number; max: number } | null>(null);
  const [insight, setInsight] = useState<InsightRequest | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const openerRef = useRef<{ spaceId: string; prompt: string } | null>(null);
  threadIdRef.current = threadId;
  const onAppliedRef = useRef(onApplied);
  const onSpaceCreatedRef = useRef(onSpaceCreated);
  onAppliedRef.current = onApplied;
  onSpaceCreatedRef.current = onSpaceCreated;

  const pending = messages.some((message) => message.batch?.status === "pending");

  const applyThread = useCallback((thread: Awaited<ReturnType<typeof fetchChatThread>>) => {
    setThreadId(thread.id);
    setMessages(thread.messages);
    setStack(thread.stack);
    setActiveStackId(visibleCanvasId(thread.stack, thread.active_stack_item_id));
    setInsight((current) => {
      if (!current) return null;
      if (thread.messages.some((message) => message.id === current.messageId)) return current;
      const last = [...thread.messages].reverse().find((message) => message.role === "assistant");
      return last ? { ...current, messageId: last.id } : null;
    });
    setTurnStatus(thread.turn_status);
  }, []);

  const reloadThreads = useCallback(async (currentSpaceId: string) => {
    const rows = await fetchChatThreads(currentSpaceId);
    setThreads(rows);
  }, []);

  useEffect(() => {
    threadIdRef.current = null;
    setThreadId(null);
    setMessages([]);
    setStack([]);
    setActiveStackId(null);
    setInsight(null);
    setQueued(null);
    setDraft("");
    setError(null);
    setTurnStatus("idle");
    if (!spaceId) {
      setThreads([]);
      return;
    }
    let cancelled = false;
    fetchChatThreads(spaceId)
      .then((rows) => {
        if (!cancelled) setThreads(rows);
      })
      .catch(() => {
        if (!cancelled) setThreads([]);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  const send = useCallback(
    async (text: string, options?: { bypassPending?: boolean; hidden?: boolean }) => {
      const content = text.trim();
      if (!spaceId || !content || streaming) return;
      if (pending && !options?.bypassPending) {
        setQueued(content);
        setDraft("");
        return;
      }
      if (!options?.hidden) {
        setError(null);
        setDraft("");
      }
      setStreaming(true);
      setRound(null);
      const localUser: ChatMessage | null = options?.hidden
        ? null
        : {
            id: `local-user-${Date.now()}`,
            role: "user",
            content,
            tool_calls: [],
            batch: null
          };
      const localAssistantId = `local-assistant-${Date.now()}`;
      setMessages((current) => [
        ...current,
        ...(localUser ? [localUser] : []),
        { id: localAssistantId, role: "assistant", content: "", tool_calls: [], batch: null }
      ]);
      let assistant = "";
      const tools: ChatMessage["tool_calls"] = [];
      try {
        await streamChatTurn(spaceId, { threadId: threadIdRef.current, content }, (event) => {
          if (event.event === "start") {
            threadIdRef.current = event.data.thread_id;
            setThreadId(event.data.thread_id);
          } else if (event.event === "text") {
            assistant += event.data.delta;
            const next = assistant;
            setMessages((current) =>
              current.map((message) =>
                message.id === localAssistantId ? { ...message, content: next } : message
              )
            );
          } else if (event.event === "round") {
            setRound({ index: event.data.index, max: event.data.max });
          } else if (event.event === "tool" && event.data.status === "done") {
            tools.push({
              name: event.data.name,
              status: "done",
              summary: event.data.summary,
              read_index: event.data.read_index
            });
            const nextTools = [...tools];
            setMessages((current) =>
              current.map((message) =>
                message.id === localAssistantId ? { ...message, tool_calls: nextTools } : message
              )
            );
          } else if (event.event === "canvas" || event.event === "canvas_update") {
            const item = event.data.item;
            setStack((current) => {
              const index = current.findIndex((entry) => entry.id === item.id);
              if (index < 0) return [...current, item];
              const next = current.slice();
              next[index] = item;
              return next;
            });
            if (event.event === "canvas" && !isInsightKind(item.kind)) setActiveStackId(item.id);
          } else if (event.event === "error") {
            setError(event.data.message);
          }
        });
        if (threadIdRef.current) {
          const thread = await fetchChatThread(spaceId, threadIdRef.current);
          applyThread(thread);
          void reloadThreads(spaceId);
        }
      } catch (caught) {
        setMessages((current) =>
          current.filter((message) => message.id !== localUser?.id && message.id !== localAssistantId)
        );
        if (options?.hidden) {
          setError(caught instanceof Error ? caught.message : "Chat request failed");
        } else if (caught instanceof ChatRequestError && caught.status === 409 && caught.message === "batch_pending") {
          setQueued(content);
        } else {
          setError(caught instanceof Error ? caught.message : "Chat request failed");
          setDraft(content);
        }
      } finally {
        setStreaming(false);
        setRound(null);
      }
    },
    [applyThread, pending, reloadThreads, spaceId, streaming]
  );

  useEffect(() => {
    const opener = openerRef.current;
    if (!spaceId || streaming || !opener || opener.spaceId !== spaceId) return;
    const prompt = opener.prompt;
    // After a space switch, wait until the reset effect has cleared the previous thread.
    const timer = window.setTimeout(() => {
      if (openerRef.current?.prompt !== prompt || openerRef.current.spaceId !== spaceId) return;
      openerRef.current = null;
      void send(prompt, { bypassPending: true, hidden: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [spaceId, streaming, send]);

  const reloadOpenThread = useCallback(async () => {
    if (!spaceId || !threadIdRef.current) return;
    const thread = await fetchChatThread(spaceId, threadIdRef.current);
    applyThread(thread);
  }, [applyThread, spaceId]);

  useEffect(() => {
    if (!spaceId || !threadId || streaming || turnStatus !== "running") return;
    const timer = window.setInterval(() => {
      void reloadOpenThread();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [spaceId, threadId, streaming, turnStatus, reloadOpenThread]);

  const flushQueue = useCallback(
    async () => {
      const next = queued;
      if (!next) return;
      setQueued(null);
      await send(next, { bypassPending: true });
    },
    [queued, send]
  );

  async function openThread(id: string) {
    if (!spaceId) return;
    setError(null);
    const thread = await fetchChatThread(spaceId, id);
    applyThread(thread);
  }

  function newThread() {
    setThreadId(null);
    threadIdRef.current = null;
    setMessages([]);
    setStack([]);
    setActiveStackId(null);
    setInsight(null);
    setQueued(null);
    setError(null);
    setTurnStatus("idle");
  }

  function selectMessage(messageId: string) {
    setInsight({ kind: "reasoning", messageId });
  }

  function selectRead(messageId: string, index: number) {
    setInsight({ kind: "read", messageId, index });
  }

  function closeInsight() {
    setInsight(null);
  }

  function selectStack(id: string) {
    setActiveStackId(id);
    if (spaceId && threadIdRef.current) {
      void setActiveChatStackItem(spaceId, threadIdRef.current, id).catch(() => undefined);
    }
  }

  async function accept() {
    if (!spaceId || !threadIdRef.current) return;
    setBatchBusy(true);
    setError(null);
    try {
      const result = await acceptChatBatch(spaceId, threadIdRef.current);
      await reloadOpenThread();
      if (result.validation_errors?.length) {
        setError(result.validation_errors.join(" "));
        return;
      }
      if (!result.ok && result.failed) {
        const skipped = result.not_applied.map((item) => item.summary || item.kind).join(", ");
        setError(
          `${result.failed.summary || result.failed.kind} failed: ${result.failed.error}${
            skipped ? `. Not applied: ${skipped}` : ""
          }`
        );
      }
      const prompt = followUpPrompt(result);
      if (result.created_space_id) {
        if (queued) await flushQueue();
        else openerRef.current = { spaceId: result.created_space_id, prompt };
        onSpaceCreatedRef.current?.(result.created_space_id);
      } else {
        onAppliedRef.current?.();
        if (queued) await flushQueue();
        else if (streaming) openerRef.current = { spaceId, prompt };
        else await send(prompt, { bypassPending: true, hidden: true });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to apply the change");
    } finally {
      setBatchBusy(false);
    }
  }

  async function reject() {
    if (!spaceId || !threadIdRef.current) return;
    setBatchBusy(true);
    setError(null);
    try {
      await rejectChatBatch(spaceId, threadIdRef.current);
      await reloadOpenThread();
      await flushQueue();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to reject the change");
    } finally {
      setBatchBusy(false);
    }
  }

  async function recordStackItem(item: {
    kind: ChatStackItem["kind"];
    title: string;
    payload: Record<string, unknown>;
  }) {
    if (!spaceId || !threadIdRef.current) return null;
    const saved = await addChatStackItem(spaceId, threadIdRef.current, item);
    setStack((current) => [...current, saved]);
    setActiveStackId(saved.id);
    return saved;
  }

  async function patchStackItem(itemId: string, payload: Record<string, unknown>) {
    if (!spaceId || !threadIdRef.current) return;
    const saved = await updateChatStackItem(spaceId, threadIdRef.current, itemId, payload);
    setStack((current) => current.map((item) => (item.id === itemId ? saved : item)));
  }

  const insightView = useMemo(
    () => resolveInsight(insight, messages, stack),
    [insight, messages, stack]
  );

  return {
    threads,
    threadId,
    messages,
    stack,
    activeStackId,
    draft,
    setDraft,
    queued,
    setQueued,
    streaming,
    round,
    insight,
    insightView,
    closeInsight,
    batchBusy,
    error,
    pending,
    send,
    openThread,
    newThread,
    selectStack,
    selectMessage,
    selectRead,
    accept,
    reject,
    recordStackItem,
    patchStackItem
  };
}
