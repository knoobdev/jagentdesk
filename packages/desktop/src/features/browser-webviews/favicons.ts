/**
 * Favicons for the app's own UI (tab strip, browser tabs list). Electron only reports a tab's
 * favicon URLs (`page-favicon-updated`); nothing downloads them unless the app does. The app
 * window must not load them itself: its session sends the app's Electron User-Agent and the
 * host's Accept-Language, outside the profile's proxy, which hands the site the identity the tab
 * hides (ADR-0026). Main fetches the icon through the tab's own session, with the tab's identity
 * headers, and the UI only ever renders the resulting `data:` URL.
 */

/** Larger icons are dropped; the UI draws them at 16 px. */
export const MAX_FAVICON_BYTES = 256 * 1024;
const FAVICON_TIMEOUT_MS = 10_000;
const MAX_CACHED_FAVICONS = 200;
/** What Chrome sends for an image. */
const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

export interface FaviconSession {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface FaviconFetcherOptions {
  /** The identity headers the tab's page would send to `url`. */
  identityHeaders(url: string): Record<string, string>;
}

/** A page-declared `data:image/…` icon is used as is; only http(s) icons are fetched. */
export function isInlineFaviconUrl(url: string): boolean {
  return /^data:image\//i.test(url);
}

function isFetchableFaviconUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function faviconMimeType(response: Response, url: string): string | null {
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type?.startsWith("image/")) {
    return type;
  }
  // Many servers send .ico files as a generic binary.
  if ((!type || type === "application/octet-stream") && /\.ico(?:$|[?#])/i.test(url)) {
    return "image/x-icon";
  }
  return null;
}

export class GuestFaviconFetcher {
  private readonly cache = new WeakMap<FaviconSession, Map<string, Promise<string | null>>>();

  constructor(private readonly options: FaviconFetcherOptions) {}

  /** The icon as a `data:` URL, or null when it is not an image or cannot be fetched. */
  resolve(session: FaviconSession, url: string): Promise<string | null> {
    if (isInlineFaviconUrl(url)) {
      return Promise.resolve(url);
    }
    if (!isFetchableFaviconUrl(url)) {
      return Promise.resolve(null);
    }
    let entries = this.cache.get(session);
    if (!entries) {
      entries = new Map();
      this.cache.set(session, entries);
    }
    const cached = entries.get(url);
    if (cached) {
      return cached;
    }
    const pending = this.fetchDataUrl(session, url);
    entries.set(url, pending);
    // A failure may be transient; the next favicon update tries again.
    void pending.then((dataUrl) => {
      if (dataUrl === null && entries.get(url) === pending) entries.delete(url);
      return undefined;
    });
    if (entries.size > MAX_CACHED_FAVICONS) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    return pending;
  }

  private async fetchDataUrl(session: FaviconSession, url: string): Promise<string | null> {
    try {
      const response = await session.fetch(url, {
        headers: { Accept: IMAGE_ACCEPT, ...this.options.identityHeaders(url) },
        credentials: "include",
        redirect: "follow",
        signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
      });
      if (!response.ok) {
        return null;
      }
      const mimeType = faviconMimeType(response, response.url || url);
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (!mimeType || declaredLength > MAX_FAVICON_BYTES) {
        await response.body?.cancel();
        return null;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) {
        return null;
      }
      return `data:${mimeType};base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  }
}
