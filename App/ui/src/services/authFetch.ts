/**
 * Global fetch interceptor that attaches the Clerk session token to same-origin
 * `/api/*` requests.
 *
 * Why a global interceptor: API calls are spread across services/api.ts,
 * services/execute.ts, the @pona-flow/connector package, and a few components.
 * Wrapping window.fetch once injects `Authorization: Bearer <token>` everywhere
 * without rewriting every call site, and centralizes 401 handling.
 *
 * The Clerk token getter is registered from React (where the useAuth hook lives)
 * via `setTokenGetter`. Until it is registered, requests proceed without a token
 * (e.g. static asset loads before sign-in).
 */

type TokenGetter = () => Promise<string | null>;

let tokenGetter: TokenGetter | null = null;
let onUnauthorized: (() => void) | null = null;
let installed = false;

export function setTokenGetter(getter: TokenGetter | null): void {
  tokenGetter = getter;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

function isApiRequest(input: RequestInfo | URL): boolean {
  try {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // Relative "/api/..." or absolute same-origin "/api/...".
    if (url.startsWith("/api/")) return true;
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

export function installAuthFetch(): void {
  if (installed) return;
  installed = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isApiRequest(input)) {
      return originalFetch(input, init);
    }

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    if (tokenGetter && !headers.has("Authorization")) {
      try {
        const token = await tokenGetter();
        if (token) headers.set("Authorization", `Bearer ${token}`);
      } catch {
        // No token available; let the request proceed and surface a 401 below.
      }
    }

    const response = await originalFetch(input, { ...init, headers });
    // Only sign out when we sent a token and the server still rejected it — not when
    // a request raced ahead of Clerk token registration on first mount.
    if (response.status === 401 && onUnauthorized && headers.has("Authorization")) {
      onUnauthorized();
    }
    return response;
  };
}
