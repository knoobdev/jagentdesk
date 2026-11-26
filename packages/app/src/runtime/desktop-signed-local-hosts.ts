import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Daemons this desktop app started itself (spec `05.2.5`, ADR-0010).
 *
 * The desktop supervisor hands the daemon the desktop device public key, and
 * the daemon records it as a paired device at bootstrap. The renderer can then
 * sign its Local hello to that daemon with the desktop key, the same way a
 * phone signs over relay or the tailnet. A loopback daemon this app did not
 * start (a CLI or dev daemon) never saw the key, so its Local connection stays
 * on the plain hello. The record is per serverId: the pairing lives in that
 * daemon's home, so it outlasts restarts of either side.
 */
const STORAGE_KEY = "@jagentdesk:desktop-signed-local-hosts:v1";

let serverIds = new Set<string>();
let loaded: Promise<void> | null = null;

export interface DesktopSignedLocalHostsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

function parse(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function loadDesktopSignedLocalHosts(
  storage: DesktopSignedLocalHostsStorage = AsyncStorage,
): Promise<void> {
  if (!loaded) {
    loaded = storage
      .getItem(STORAGE_KEY)
      .then((value) => {
        serverIds = new Set([...parse(value), ...serverIds]);
        return undefined;
      })
      .catch(() => undefined);
  }
  return loaded;
}

export async function rememberDesktopSignedLocalHost(
  serverId: string,
  storage: DesktopSignedLocalHostsStorage = AsyncStorage,
): Promise<void> {
  await loadDesktopSignedLocalHosts(storage);
  if (serverIds.has(serverId)) return;
  serverIds.add(serverId);
  await storage.setItem(STORAGE_KEY, JSON.stringify([...serverIds]));
}

export function isDesktopSignedLocalHost(serverId: string): boolean {
  return serverIds.has(serverId);
}

export function resetDesktopSignedLocalHostsForTests(): void {
  serverIds = new Set();
  loaded = null;
}
