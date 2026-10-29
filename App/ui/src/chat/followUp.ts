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
  lines.push(
    "Continue the conversation. Say what landed, then ask one question or offer one concrete next step. Reply in text only. Do not call a tool."
  );
  return lines.join("\n");
}
