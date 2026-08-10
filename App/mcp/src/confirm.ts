/**
 * Confirmation tokens for destructive tools.
 *
 * Deleting a STEP or SCHEMA cascades: dependent sequences, catalog rows, and graph nodes go
 * with it. An agent asked to "remove the old approval step" has no way to know that until it
 * sees the blast radius, so every destructive tool refuses to write on its first call. It
 * returns the preview plus a token, and only the second call — carrying that token — writes.
 *
 * Tokens are bound to the exact target and expire, so a token issued for one label cannot be
 * replayed against another, and a stale confirmation from earlier in a conversation cannot
 * authorize a deletion the agent has since reconsidered.
 */

import { randomUUID } from "node:crypto";

const TOKEN_TTL_MS = 10 * 60 * 1000;

interface PendingConfirmation {
  fingerprint: string;
  expiresAt: number;
}

const pending = new Map<string, PendingConfirmation>();

function fingerprintOf(action: string, spaceId: string, target: string): string {
  return `${action}::${spaceId}::${target}`;
}

function sweep(now: number): void {
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

export function issueConfirmation(action: string, spaceId: string, target: string): string {
  const now = Date.now();
  sweep(now);
  const token = randomUUID();
  pending.set(token, {
    fingerprint: fingerprintOf(action, spaceId, target),
    expiresAt: now + TOKEN_TTL_MS,
  });
  return token;
}

/** Consume a token, throwing when it is unknown, expired, or issued for a different target. */
export function redeemConfirmation(
  token: string,
  action: string,
  spaceId: string,
  target: string
): void {
  const now = Date.now();
  sweep(now);
  const entry = pending.get(token);
  if (!entry) {
    throw new Error(
      "confirm_token is unknown or has expired. Call this tool again without it to get a " +
        "fresh preview, review what would be deleted, then retry with the new token."
    );
  }
  if (entry.fingerprint !== fingerprintOf(action, spaceId, target)) {
    throw new Error(
      "confirm_token was issued for a different target. Request a preview for this target first."
    );
  }
  pending.delete(token);
}

/** Test seam: forget every outstanding token. */
export function resetConfirmations(): void {
  pending.clear();
}
