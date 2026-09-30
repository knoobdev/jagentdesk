import { describe, expect, it, vi } from "vitest";
import { generateFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import type { MutableDaemonConfig } from "@jagentdesk/protocol/messages";

const setFingerprintProfile = vi.fn(async () => ({ ok: true }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ browser: { setFingerprintProfile } }),
}));

const { mountFingerprintProfileSync, syncFingerprintProfileNow } =
  await import("./fingerprint-profile-sync");

const profile = generateFingerprintProfile({
  id: "bfp_a1b2c3",
  name: "work",
  os: "windows",
  nowMs: 1_790_000_000_000,
});

function configWith(activeProfileId: string | null): MutableDaemonConfig {
  return {
    browserTools: { enabled: true, profiles: [profile], activeProfileId },
  } as unknown as MutableDaemonConfig;
}

function createClient(initial: MutableDaemonConfig) {
  let config = initial;
  const handlers = new Map<string, (message: unknown) => void>();
  return {
    setConfig(next: MutableDaemonConfig) {
      config = next;
    },
    emit(type: string, message: unknown) {
      handlers.get(type)?.(message);
    },
    getDaemonConfig: vi.fn(async () => ({ config })),
    on: vi.fn((type: string, handler: (message: unknown) => void) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    }),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mountFingerprintProfileSync", () => {
  it("applies the profile carried by a daemon_config_changed status message", async () => {
    setFingerprintProfile.mockClear();
    const client = createClient(configWith(null));
    const unmount = mountFingerprintProfileSync(client as never);
    await flush();
    expect(client.on).toHaveBeenCalledWith("status", expect.any(Function));
    expect(setFingerprintProfile).toHaveBeenLastCalledWith(null);

    client.emit("status", {
      type: "status",
      payload: { status: "daemon_config_changed", config: configWith(profile.id) },
    });
    await flush();
    expect(setFingerprintProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: profile.id }),
    );
    unmount();
  });

  it("re-reads the config before a tab opens", async () => {
    setFingerprintProfile.mockClear();
    const client = createClient(configWith(null));
    const unmount = mountFingerprintProfileSync(client as never);
    await flush();

    client.setConfig(configWith(profile.id));
    await syncFingerprintProfileNow(client);
    expect(setFingerprintProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: profile.id }),
    );
    unmount();
  });
});
