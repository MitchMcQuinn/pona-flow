/** Point the browser tab at this instance's app name and icon. */

export function applyInstanceTitle(appName: string | null | undefined): void {
  document.title = (appName || "").trim() || "pona flow";
}

export function applyInstanceIcon(iconLabel: string | null | undefined, cacheKey?: string): void {
  const key = cacheKey ?? (iconLabel || "").trim();
  const href = key ? `/favicon.svg?v=${encodeURIComponent(key)}` : "/favicon.svg";
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = href;
}
