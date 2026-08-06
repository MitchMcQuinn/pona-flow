/** Join a relative API path with an optional base URL. */

export function joinApiPath(path: string, apiBase = ""): string {
  const base = (apiBase || "").replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}
