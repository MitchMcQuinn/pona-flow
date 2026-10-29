export type StackKind =
  | "saved_console"
  | "ephemeral_console"
  | "proposal"
  | "hitl"
  | "builder"
  | "run_log"
  | "reasoning"
  | "reads"
  | "walkthrough";

export interface ChatToolCall {
  name: string;
  status: string;
  summary?: string;
  read_index?: number;
}

export interface WalkthroughPin {
  target: string;
  note: string;
}

export interface WalkthroughFrame {
  view: "workbench" | "sequence" | "event" | "console";
  title: string;
  note: string;
  pins: WalkthroughPin[];
  document: Record<string, unknown>;
}

export interface ChatBatchItem {
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  preview?: unknown;
}

export interface ChatBatchResult {
  ok: boolean;
  validation_errors: string[];
  applied: Array<{ kind: string; summary: string; id?: string | null }>;
  failed: { kind: string; summary: string; error: string } | null;
  not_applied: Array<{ kind: string; summary: string }>;
  created_space_id: string | null;
}

export interface ChatBatch {
  status: "pending" | "accepted" | "rejected" | "partial";
  items: ChatBatchItem[];
  result?: ChatBatchResult | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: ChatToolCall[];
  batch: ChatBatch | null;
}

export interface ChatStackItem {
  id: string;
  kind: StackKind;
  title: string;
  payload: Record<string, unknown>;
  position: number;
}

export interface ChatThreadSummary {
  id: string;
  title: string;
  turn_status: "idle" | "running";
  updated_at: string;
}

export interface ChatThread extends ChatThreadSummary {
  active_stack_item_id: string | null;
  messages: ChatMessage[];
  stack: ChatStackItem[];
}

export interface ChatModelSettings {
  provider: "platform" | "anthropic" | "openai" | "gemini" | "local_llm";
  model: string;
  credential_name: string;
  local_llm_base_url: string;
  local_llm_config_id: string;
  max_rounds: number;
  platform_configured?: boolean;
}

export type ChatStreamEvent =
  | { event: "start"; data: { thread_id: string; title?: string } }
  | { event: "text"; data: { delta: string } }
  | { event: "round"; data: { index: number; max: number } }
  | { event: "tool"; data: { name: string; status: string; summary?: string; read_index?: number } }
  | { event: "canvas"; data: { item: ChatStackItem } }
  | { event: "canvas_update"; data: { item: ChatStackItem } }
  | { event: "batch"; data: { message_id: string; batch: ChatBatch } }
  | { event: "done"; data: { message_id: string; thread_id: string } }
  | { event: "error"; data: { message: string } };
