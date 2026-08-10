/** Join a relative API path with an optional base URL. */

import { configuredApiBase } from "./http.js";

export function joinApiPath(path: string, apiBase?: string): string {
  const base = (apiBase ?? configuredApiBase()).replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}
