import type { Session } from "electron";
import log from "electron-log";
import type { BrowserFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";

/**
 * Session-level parts of a fingerprint profile: the proxy (the ONLY real IP
 * control — there is no way to change the observed IP without routing traffic) and
 * Chromium extensions (which the agent can write to fully customise the browser).
 * These are per-partition, not per-guest, so they're applied to the shared
 * agentic-browser session when the active profile changes.
 */

/** Apply (or clear) the profile's proxy on the browser session. */
export async function applyProfileProxyToSession(
  session: Session,
  profile: BrowserFingerprintProfile | null,
): Promise<void> {
  try {
    if (profile?.proxy) {
      await session.setProxy({ proxyRules: profile.proxy.server, proxyBypassRules: "<local>" });
      log.info("[browser-network] proxy set", { server: profile.proxy.server });
    } else {
      // Back to system/direct when no profile or no proxy.
      await session.setProxy({ mode: "system" });
    }
  } catch (error) {
    log.warn("[browser-network] setProxy failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Load the profile's unpacked extensions into the browser session. Extensions
 * require the persistent partition the agentic browser already uses. Missing/broken
 * dirs are logged and skipped, never fatal. Returns the ids that loaded.
 */
export async function loadProfileExtensions(
  session: Session,
  profile: BrowserFingerprintProfile | null,
): Promise<string[]> {
  const paths = profile?.extensions ?? [];
  const loaded: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || path.trim().length === 0) {
      continue;
    }
    try {
      const ext = await session.loadExtension(path, { allowFileAccess: true });
      loaded.push(ext.id);
      log.info("[browser-network] extension loaded", { path, id: ext.id });
    } catch (error) {
      log.warn("[browser-network] loadExtension failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return loaded;
}

/** Proxy credentials for the app-level `login` handler (authenticated proxies). */
export function proxyLogin(
  profile: BrowserFingerprintProfile | null,
): { username: string; password: string } | null {
  const proxy = profile?.proxy;
  if (proxy && typeof proxy.username === "string" && typeof proxy.password === "string") {
    return { username: proxy.username, password: proxy.password };
  }
  return null;
}
