/**
 * Shared request plumbing for every connector endpoint.
 *
 * The browser injects the Clerk token by wrapping `window.fetch` (see the UI's
 * services/authFetch.ts), which is invisible to this package. Node callers (the MCP
 * authoring server) have no `window` and authenticate with an `stg_` agent key
 * instead, so they register a fetch implementation and header provider through
 * `configure()`. Routing every call through `requestJson` gives both worlds one
 * place to attach credentials, resolve the API base, and normalize error text.
 */

export interface ConnectorConfig {
  /** Fetch implementation to use. Defaults to the ambient global. */
  fetch?: typeof globalThis.fetch;
  /** Base URL prefixed to every relative path when a call omits its own. */
  apiBase?: string;
  /** Extra headers (e.g. an agent key) resolved per request. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

let config: ConnectorConfig = {};

/** Merge connector-wide defaults (fetch implementation, API base, auth headers). */
export function configure(cfg: ConnectorConfig): void {
  config = { ...config, ...cfg };
}

/** Drop all configured defaults (test isolation). */
export function resetConfig(): void {
  config = {};
}

/** The configured API base, or "" when calls should stay relative. */
export function configuredApiBase(): string {
  return config.apiBase || "";
}

function resolveFetch(): typeof globalThis.fetch {
  const impl = config.fetch ?? globalThis.fetch;
  if (typeof impl !== "function") {
    throw new Error(
      "No fetch implementation available. Call configure({ fetch }) before using the connector."
    );
  }
  return impl;
}

export interface RequestOptions {
  /** HTTP verb; GET when omitted. */
  method?: string;
  /** Query parameters; entries with an empty/undefined value are dropped. */
  query?: Record<string, string | undefined>;
  /** JSON request body. */
  body?: unknown;
  /** Per-call base URL override; falls back to the configured base. */
  apiBase?: string;
  /** Trailing text for the thrown error, e.g. "loading spaces". */
  errorLabel: string;
}

function buildUrl(path: string, opts: RequestOptions): string {
  const base = (opts.apiBase ?? configuredApiBase()).replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = base ? `${base}${p}` : p;
  if (!opts.query) return url;
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.query)) {
    if (value === undefined || value === null || value === "") continue;
    q.set(key, value);
  }
  const qs = q.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Issue a request and return its parsed JSON body, throwing the server's `error`
 * field (or an HTTP status line) when the response is not ok.
 */
export async function requestJson<T = Record<string, unknown>>(
  path: string,
  opts: RequestOptions
): Promise<T> {
  const method = (opts.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  if (config.headers) {
    Object.assign(headers, await config.headers());
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  if (method === "GET") {
    init.cache = "no-store";
  }

  const res = await resolveFetch()(buildUrl(path, opts), init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status} ${opts.errorLabel}`);
  }
  return data;
}
