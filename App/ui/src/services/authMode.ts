/**
 * Runtime auth mode discovery.
 *
 * The UI asks the server how to authenticate (`GET /api/auth/status`) before rendering
 * anything, so one built bundle works for both the built-in email/password mode
 * (self-hosted default) and the Clerk mode. The resolved mode is constant for the
 * lifetime of the page; hooks in `clerkAuth.ts` branch on it safely.
 */

export type AuthMode = "local" | "clerk";

export interface AuthStatus {
  mode: AuthMode;
  /** Local mode only: no account exists yet, show the first-run setup page. */
  setupRequired: boolean;
  /** Local mode only: anyone may create an account (PONA_FLOW_ALLOW_OPEN_SIGNUP). */
  openSignup: boolean;
  /** Clerk mode only: publishable key served by the backend. */
  clerkPublishableKey: string | null;
}

let resolvedMode: AuthMode | null = null;

export function setResolvedAuthMode(mode: AuthMode): void {
  resolvedMode = mode;
}

/** The mode the app booted in. Defaults to local until `setResolvedAuthMode` runs. */
export function authMode(): AuthMode {
  return resolvedMode ?? "local";
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const response = await fetch("/api/auth/status", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`auth status ${response.status}`);
  }
  const data = (await response.json()) as {
    mode?: string;
    setup_required?: boolean;
    open_signup?: boolean;
    clerk_publishable_key?: string | null;
  };
  return {
    mode: data.mode === "clerk" ? "clerk" : "local",
    setupRequired: Boolean(data.setup_required),
    openSignup: Boolean(data.open_signup),
    clerkPublishableKey: data.clerk_publishable_key ?? null
  };
}
