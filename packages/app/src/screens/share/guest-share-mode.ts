// True when the app is running as the session-share GUEST surface (served through the tunnel with an
// injected share hint or ?agentId= query). Host-only chrome (e.g. the Share button) checks this so it
// never renders for a guest — a guest must not be able to re-share, and the host share RPCs are not in
// the guest scope anyway. Kept standalone (no imports) to avoid a cycle with guest-share-screen.
export function isGuestShareMode(): boolean {
  const g = (globalThis as { __JAGENTDESK_SHARE__?: { agentId?: unknown } }).__JAGENTDESK_SHARE__;
  if (g && typeof g.agentId === "string" && g.agentId) return true;
  if (typeof location !== "undefined") {
    try {
      return Boolean(new URLSearchParams(location.search).get("agentId"));
    } catch {
      return false;
    }
  }
  return false;
}

// True when the current guest share is read-only (chat-only view) — the composer is hidden and the
// daemon denies sending. Read from the injected share hint's capabilities.
export function isGuestReadOnlyShare(): boolean {
  const g = (globalThis as { __JAGENTDESK_SHARE__?: { capabilities?: { readOnly?: unknown } } })
    .__JAGENTDESK_SHARE__;
  return isGuestShareMode() && g?.capabilities?.readOnly === true;
}
