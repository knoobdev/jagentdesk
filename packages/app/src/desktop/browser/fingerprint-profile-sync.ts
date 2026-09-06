import type { MutableDaemonConfig } from "@jagentdesk/protocol/messages";
import { getDesktopHost } from "@/desktop/host";
import { resolveActiveFingerprintProfile } from "@/screens/settings/browser-fingerprint-config";

/**
 * Keep the desktop main process's active fingerprint profile in sync with the
 * daemon config. Mounted alongside the browser-automation host handler (desktop
 * only), so the profile is applied BEFORE any agent-driven tab opens and re-applied
 * whenever the config changes. Fetches once on mount, then refetches on
 * `status:daemon_config_changed`. De-duped so an unchanged profile isn't re-pushed.
 */
interface ConfigSyncClient {
  getDaemonConfig(): Promise<{ config: MutableDaemonConfig }>;
  on(event: string, handler: (message: unknown) => void): () => void;
}

export function mountFingerprintProfileSync(client: ConfigSyncClient): () => void {
  let lastKey: string | null = null;
  let disposed = false;

  const apply = (config: MutableDaemonConfig | null): void => {
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
    void Promise.resolve(push(profile)).catch(() => {});
  };

  const refresh = (): void => {
    void client
      .getDaemonConfig()
      .then((result) => {
        if (!disposed) {
          apply(result.config);
        }
      })
      .catch(() => {});
  };

  refresh();
  const unsubscribe = client.on("status:daemon_config_changed", () => refresh());
  return () => {
    disposed = true;
    unsubscribe();
  };
}
