import type { ChatMessage, ChatStackItem } from "./types";

export type InsightRequest =
  | { kind: "reasoning"; messageId: string }
  | { kind: "read"; messageId: string; index: number };

export type InsightView =
  | { kind: "reasoning"; rounds: unknown[] }
  | { kind: "read"; entry: { name?: string; arguments?: unknown; result?: unknown } | null };

const CANVAS_KINDS = new Set(["reasoning", "reads"]);

export function isInsightKind(kind: string): boolean {
  return CANVAS_KINDS.has(kind);
}

/** The canvas tab to restore, skipping reasoning and read panels. */
export function visibleCanvasId(stack: ChatStackItem[], activeId: string | null): string | null {
  const visible = stack.filter((item) => !isInsightKind(item.kind));
  if (activeId && visible.some((item) => item.id === activeId)) return activeId;
  return visible[visible.length - 1]?.id ?? null;
}

function stampedItem(
  stack: ChatStackItem[],
  kind: "reasoning" | "reads",
  messageId: string
): ChatStackItem | null {
  return (
    stack.find((item) => item.kind === kind && item.payload.message_id === messageId) ?? null
  );
}

function itemForMessage(
  messages: ChatMessage[],
  stack: ChatStackItem[],
  kind: "reasoning" | "reads",
  messageId: string
): ChatStackItem | null {
  const stamped = stampedItem(stack, kind, messageId);
  if (stamped) return stamped;
  const items = stack.filter((item) => item.kind === kind);
  const owners =
    kind === "reasoning"
      ? messages.filter((message) => message.role === "assistant")
      : messages.filter(
          (message) =>
            message.role === "assistant" &&
            message.tool_calls.some((call) => call.read_index != null)
        );
  const index = owners.findIndex((message) => message.id === messageId);
  return index >= 0 ? items[index] ?? null : null;
}

export function resolveInsight(
  request: InsightRequest | null,
  messages: ChatMessage[],
  stack: ChatStackItem[]
): InsightView | null {
  if (!request) return null;
  if (request.kind === "reasoning") {
    const item = itemForMessage(messages, stack, "reasoning", request.messageId);
    const rounds = item && Array.isArray(item.payload.rounds) ? item.payload.rounds : [];
    return { kind: "reasoning", rounds };
  }
  const item = itemForMessage(messages, stack, "reads", request.messageId);
  const entries = item && Array.isArray(item.payload.entries) ? item.payload.entries : [];
  const entry = entries[request.index];
  return {
    kind: "read",
    entry:
      entry && typeof entry === "object"
        ? (entry as { name?: string; arguments?: unknown; result?: unknown })
        : null
  };
}
