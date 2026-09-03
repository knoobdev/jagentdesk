import { describe, expect, it } from "vitest";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import {
  addHostBackup,
  parseHostBackups,
  restoreHostProfile,
  serializeHostBackups,
  takeHostBackup,
} from "./host-backups";

function conn(id: string): HostConnection {
  return { id, type: "directTcp", endpoint: "localhost:6768", useTls: false } as HostConnection;
}

function host(overrides: Partial<HostProfile> = {}): HostProfile {
  return {
    serverId: "srv_a",
    label: "JCode.local",
    appearance: { color: "none", badgeDisplay: null },
    lifecycle: {},
    connections: [conn("direct:localhost:6768")],
    preferredConnectionId: "direct:localhost:6768",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("host backups", () => {
  it("round-trips through storage serialization", () => {
    const backups = [host()];
    expect(parseHostBackups(serializeHostBackups(backups))).toEqual(backups);
  });

  it("tolerates malformed persisted data", () => {
    expect(parseHostBackups(null)).toEqual([]);
    expect(parseHostBackups("not json")).toEqual([]);
    expect(parseHostBackups('{"serverId":"x"}')).toEqual([]);
  });

  it("dedupes backups by serverId, newest wins", () => {
    const first = host({ label: "old" });
    const second = host({ label: "new" });
    const result = addHostBackup(addHostBackup([], first), second);
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("new");
  });

  it("pops a backup by serverId", () => {
    const backups = [host({ serverId: "srv_a" }), host({ serverId: "srv_b" })];
    const { backup, remaining } = takeHostBackup(backups, "srv_a");
    expect(backup?.serverId).toBe("srv_a");
    expect(remaining.map((entry) => entry.serverId)).toEqual(["srv_b"]);
  });

  it("returns null when no backup matches", () => {
    const backups = [host({ serverId: "srv_b" })];
    expect(takeHostBackup(backups, "srv_a").backup).toBeNull();
  });

  it("restores saved label, appearance, createdAt and missing connections", () => {
    const backup = host({
      label: "My Mac",
      appearance: { color: "blue", badgeDisplay: null },
      connections: [conn("direct:localhost:6768"), conn("tailnet:jcode-2")],
      createdAt: "2025-06-01T00:00:00.000Z",
    });
    const fresh = host({
      label: "JCode.local",
      appearance: { color: "none", badgeDisplay: null },
      connections: [conn("direct:localhost:6768")],
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T10:00:00.000Z",
    });
    const restored = restoreHostProfile(fresh, backup);
    expect(restored.label).toBe("My Mac");
    expect(restored.appearance.color).toBe("blue");
    expect(restored.createdAt).toBe("2025-06-01T00:00:00.000Z");
    expect(restored.updatedAt).toBe("2026-09-03T10:00:00.000Z");
    // fresh connection kept + backed-up tailnet connection re-added, no dupes
    expect(restored.connections.map((entry) => entry.id)).toEqual([
      "direct:localhost:6768",
      "tailnet:jcode-2",
    ]);
  });

  it("keeps the fresh label when the backup label is blank", () => {
    const restored = restoreHostProfile(host({ label: "JCode.local" }), host({ label: "  " }));
    expect(restored.label).toBe("JCode.local");
  });
});
