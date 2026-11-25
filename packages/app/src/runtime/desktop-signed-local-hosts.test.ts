import { beforeEach, describe, expect, it } from "vitest";
import {
  isDesktopSignedLocalHost,
  loadDesktopSignedLocalHosts,
  rememberDesktopSignedLocalHost,
  resetDesktopSignedLocalHostsForTests,
} from "./desktop-signed-local-hosts";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("desktop signed local hosts", () => {
  beforeEach(() => resetDesktopSignedLocalHostsForTests());

  it("signs only daemons this desktop started", async () => {
    const storage = memoryStorage();
    await rememberDesktopSignedLocalHost("srv_bundled", storage);

    expect(isDesktopSignedLocalHost("srv_bundled")).toBe(true);
    expect(isDesktopSignedLocalHost("srv_cli_daemon")).toBe(false);
  });

  it("restores the record after an app restart", async () => {
    const storage = memoryStorage();
    await rememberDesktopSignedLocalHost("srv_bundled", storage);

    resetDesktopSignedLocalHostsForTests();
    expect(isDesktopSignedLocalHost("srv_bundled")).toBe(false);
    await loadDesktopSignedLocalHosts(storage);
    expect(isDesktopSignedLocalHost("srv_bundled")).toBe(true);
  });

  it("ignores a corrupt record", async () => {
    await loadDesktopSignedLocalHosts(
      memoryStorage({ "@jagentdesk:desktop-signed-local-hosts:v1": "{not json" }),
    );
    expect(isDesktopSignedLocalHost("srv_bundled")).toBe(false);
  });
});
