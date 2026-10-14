/**
 * Client for the built-in auth routes (`/api/auth/*`), used when the server runs in
 * local mode. All calls are same-origin and cookie-based; the server sets/clears the
 * HttpOnly session cookie, so nothing is stored in JavaScript.
 */
import type { Me } from "../state/types";
import { meFromPayload, type MePayload } from "./api";

export class AuthRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function postAuth(path: string, body: unknown, fallback: string): Promise<Me> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const data = (await response.json().catch(() => ({}))) as MePayload & { error?: string };
  if (!response.ok) {
    throw new AuthRequestError(response.status, data.error || fallback);
  }
  return meFromPayload(data);
}

export interface Credentials {
  email: string;
  password: string;
  displayName?: string;
}

export function setupFirstAccount(input: Credentials): Promise<Me> {
  return postAuth(
    "/api/auth/setup",
    { email: input.email, password: input.password, display_name: input.displayName || null },
    "Setup failed"
  );
}

export function login(input: Credentials): Promise<Me> {
  return postAuth("/api/auth/login", { email: input.email, password: input.password }, "Sign-in failed");
}

export function signup(input: Credentials): Promise<Me> {
  return postAuth(
    "/api/auth/signup",
    { email: input.email, password: input.password, display_name: input.displayName || null },
    "Sign-up failed"
  );
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", cache: "no-store" }).catch(() => undefined);
}
