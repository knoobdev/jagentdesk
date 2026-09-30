import type { MutableDaemonConfig, SessionOutboundMessage } from "@jagentdesk/protocol/messages";
import { getDesktopHost } from "@/desktop/host";
import { resolveActiveFingerprintProfile } from "@/screens/settings/browser-fingerprint-config";

/**
 * Keep the desktop main process's active fingerprint profile in sync with the
 * daemon config. Mounted alongside the browser-automation host handler (desktop
 * only), so the profile is applied BEFORE any agent-driven tab opens and re-applied
 * whenever the config changes. Fetches once on mount, then applies the config
 * carried by every `daemon_config_changed` status message. De-duped so an unchanged
 * profile isn't re-pushed.
 */
interface ConfigSyncClient {
  getDaemonConfig(): Promise<{ config: MutableDaemonConfig }>;
  // Same shape as DaemonClient.on: handlers are keyed by message `type` ("status"), never by
  // a status value, so a "status:daemon_config_changed" subscription would never fire.
  on<TType extends SessionOutboundMessage["type"]>(
    type: TType,
    handler: (message: Extract<SessionOutboundMessage, { type: TType }>) => void,
  ): () => void;
}

// One sync per connected daemon client; the browser-automation handler for that client
// awaits it before opening a tab (see syncFingerprintProfileNow).
const refreshByClient = new WeakMap<object, () => Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function mountFingerprintProfileSync(client: ConfigSyncClient): () => void {
  let lastKey: string | null = null;
  let disposed = false;

  const apply = async (config: MutableDaemonConfig | null): Promise<void> => {
    const push = getDesktopHost()?.browser?.setFingerprintProfile;
    if (!push) {
      return;
    }
    const profile = resolveActiveFingerprintProfile(config);
    const key = profile ? JSON.stringify(profile) : "null";
    if (key === lastKey) {
      return;
    }
    lastKey = key;
    try {
      await push(profile);
    } catch {
      // Let the next config change or tab open retry.
      lastKey = null;
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      const result = await client.getDaemonConfig();
      if (!disposed) {
        await apply(result.config);
      }
    } catch {
      // Offline or not authorised: keep the last applied profile.
    }
  };

  refreshByClient.set(client, refresh);
  void refresh();
  const unsubscribe = client.on("status", (message) => {
    const payload = message.payload as { status?: unknown; config?: unknown };
    if (payload.status !== "daemon_config_changed" || disposed) {
      return;
    }
    if (isRecord(payload.config)) {
      void apply(payload.config as MutableDaemonConfig);
      return;
    }
    void refresh();
  });
  return () => {
    disposed = true;
    refreshByClient.delete(client);
    unsubscribe();
  };
}

/**
 * Re-read the daemon config and push the active profile to the main process, resolving
 * once main has applied it. Called before an agent opens a tab so `browser_profile_use`
 * followed immediately by `browser_new_tab` gets the new identity.
 */
export async function syncFingerprintProfileNow(client: object): Promise<void> {
  await refreshByClient.get(client)?.();
}
