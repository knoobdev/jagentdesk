/**
 * A browser tab's favicon as an image source for the app's UI, or null. Only `data:image/…` URLs
 * pass: main fetched them through the tab's own session with the tab's identity (desktop
 * browser-webviews/favicons.ts). A site URL would be loaded by the app window's session, which
 * sends the app's Electron User-Agent and the host's language outside the profile's proxy
 * (ADR-0026), so it is never rendered.
 */
export function isTabFaviconDataUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && /^data:image\//i.test(url);
}

export function tabFaviconSource(url: string | null | undefined): { uri: string } | undefined {
  return isTabFaviconDataUrl(url) ? { uri: url } : undefined;
}
