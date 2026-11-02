const SESSION_KEY = "pf-guide-session";

function apiBase() {
  return ((import.meta.env.VITE_GUIDE_API as string | undefined) || "").replace(/\/$/, "");
}

export function rememberSession(data: Record<string, unknown>) {
  const token = data.session_token;
  if (typeof token === "string" && token) {
    sessionStorage.setItem(SESSION_KEY, token);
  }
}

export async function guideApi(path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = sessionStorage.getItem(SESSION_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBase()}${path}`, {
    credentials: "include",
    method: body === undefined ? "GET" : "POST",
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as { detail?: string }) : {};
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "Request failed");
  }
  return data as Record<string, unknown>;
}
