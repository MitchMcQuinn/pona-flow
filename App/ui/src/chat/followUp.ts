import type { ChatBatchResult } from "./types";

/** Stored on the user row so the transcript can hide it. The model sees the text after this mark. */
export const FOLLOW_UP_MARK = "[[pona-follow-up]]";

export function isFollowUp(content: string): boolean {
  return content.trimStart().startsWith(FOLLOW_UP_MARK);
}

/** Prompt for the turn that runs after a batch is applied. The user does not see this bubble. */
export function followUpPrompt(result: ChatBatchResult): string {
  const applied = result.applied.map((item) => item.summary || item.kind).filter(Boolean);
  const lines = [
    FOLLOW_UP_MARK,
    "The user accepted the proposed changes and they have been applied.",
    applied.length ? `Applied: ${applied.join("; ")}.` : "Nothing new was applied."
  ];
  if (result.failed) {
    lines.push(
      `This item failed: ${result.failed.summary || result.failed.kind}. ${result.failed.error}`
    );
  }
  const skipped = result.not_applied.map((item) => item.summary || item.kind).filter(Boolean);
  if (skipped.length) lines.push(`Not applied: ${skipped.join("; ")}.`);
  const inputs = result.inputs ?? [];
  if (inputs.length) {
    lines.push(
      `Inputs: ${inputs.map((item) => `${item.name} (${item.source} → ${item.lands_as})`).join("; ")}.`,
      "Say which inputs are simulated or set from the console, and which one to switch to a live event when the real source exists."
    );
  }
  const consoles = result.applied.filter((item) => item.kind === "upsert_console" && item.id);
  if (consoles.length) {
    const named = consoles.map((item) => `${item.summary || "Console"} (${item.id})`).join("; ");
    lines.push(
      `Check these consoles with check_console_modules, then open_console for each: ${named}.`,
      "Say what each module shows, or which sequence it runs. If a module is not ok, say what is wrong and propose a fix. Do not call any other tool."
    );
  } else {
    lines.push(
      "Continue the conversation. Say what landed, then ask one question or offer one concrete next step. Reply in text only. Do not call a tool."
    );
  }
  return lines.join("\n");
}
