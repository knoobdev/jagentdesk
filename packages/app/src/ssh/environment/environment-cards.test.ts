import { describe, expect, it } from "vitest";
import type { ServerEnvironment } from "@jagentdesk/protocol/ssh/environment-schemas";
import { buildEnvironmentCards, formatBytes, formatUptime, hasDocker } from "./environment-cards";
import { serverChatTitle } from "./start-server-chat";

const BARE: ServerEnvironment = {
  serverId: "srv_a1b2c3",
  detectedAtMs: 1,
  hostname: null,
  os: {
    kernelName: "Linux",
    kernelRelease: "6.8.0",
    arch: "aarch64",
    distroId: "alpine",
    distroName: "Alpine Linux",
    distroVersion: "3.24.3",
    prettyName: "Alpine Linux v3.24",
  },
  cpuCores: null,
  cpuModel: null,
  memoryTotalBytes: null,
  memoryAvailableBytes: null,
  rootDisk: null,
  uptimeSeconds: null,
  shell: null,
  docker: null,
  podman: null,
  systemctl: null,
  kubectl: null,
  psql: null,
  mysql: null,
  redisCli: null,
  nginx: null,
  packageManagers: [],
  systemd: null,
};

describe("buildEnvironmentCards", () => {
  it("shows only what was detected", () => {
    expect(buildEnvironmentCards(BARE)).toEqual([
      {
        id: "system",
        rows: [
          { labelKey: "os", label: null, value: "Alpine Linux v3.24", tone: "default" },
          { labelKey: "kernel", label: null, value: "Linux 6.8.0", tone: "default" },
          { labelKey: "arch", label: null, value: "aarch64", tone: "default" },
        ],
      },
    ]);
    expect(hasDocker(BARE)).toBe(false);
  });

  it("lists resources, installed tools and services, warning on a full disk and failures", () => {
    const environment: ServerEnvironment = {
      ...BARE,
      cpuCores: 4,
      memoryTotalBytes: 8 * 1024 ** 3,
      memoryAvailableBytes: 2 * 1024 ** 3,
      rootDisk: { mount: "/", totalBytes: 100, usedBytes: 95, availableBytes: 5 },
      docker: {
        version: "Docker version 27.3.1",
        socketPath: "/var/run/docker.sock",
        socketAccessible: false,
      },
      psql: { version: "psql (PostgreSQL) 16.4" },
      packageManagers: ["apt"],
      systemd: {
        runningServices: ["a", "b"],
        failedServices: ["c.service"],
        runningTruncated: true,
      },
    };

    const cards = buildEnvironmentCards(environment);

    expect(cards.map((card) => card.id)).toEqual(["system", "resources", "software", "services"]);
    expect(cards[1].rows).toEqual([
      { labelKey: "cpu", label: null, value: "4", tone: "default" },
      { labelKey: "memoryAvailable", label: null, value: "2.0 GiB / 8.0 GiB", tone: "default" },
      { labelKey: "disk", label: null, value: "95 B / 100 B (95%)", tone: "warning" },
    ]);
    expect(cards[2].rows).toEqual([
      { labelKey: null, label: "docker", value: "Docker version 27.3.1", tone: "warning" },
      { labelKey: null, label: "psql", value: "psql (PostgreSQL) 16.4", tone: "default" },
      { labelKey: "packageManagers", label: null, value: "apt", tone: "default" },
    ]);
    expect(cards[3].rows).toEqual([
      { labelKey: "servicesRunning", label: null, value: "2+", tone: "default" },
      { labelKey: "servicesFailed", label: null, value: "c.service", tone: "warning" },
    ]);
    expect(hasDocker(environment)).toBe(true);
  });
});

describe("formatters", () => {
  it("formats bytes and uptime compactly", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(250 * 1024 ** 3)).toBe("250 GiB");
    expect(formatUptime(59)).toBe("0m");
    expect(formatUptime(3_660)).toBe("1h 1m");
    expect(formatUptime(3 * 86_400 + 7_200)).toBe("3d 2h");
  });

  it("titles a server chat from its first non-empty line", () => {
    expect(serverChatTitle("web-01", "\n  which containers   are running?\nthanks")).toBe(
      "web-01: which containers are running?",
    );
    expect(serverChatTitle("web-01", "   ")).toBeNull();
  });
});
