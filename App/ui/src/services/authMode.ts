/**
 * Local-development auth bypass flag.
 *
 * When `VITE_DISABLE_AUTH=true` (set in `App/ui/.env`), the app skips Clerk entirely:
 * no `ClerkProvider`, no sign-in redirect, and no bearer token on `/api/*` requests.
 * Pair it with `PONA_FLOW_DISABLE_AUTH=1` on the backend so the API grants a synthetic
 * local principal. Never enable this in a deployed environment.
 */
export const AUTH_DISABLED =
  (import.meta.env.VITE_DISABLE_AUTH as string | undefined) === "true";
