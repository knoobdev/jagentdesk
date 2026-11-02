import { describe, expect, it } from "vitest";
import {
  EnvironmentReportError,
  RUNNING_SERVICES_CAP,
  parseDfLine,
  parseEnvironmentReport,
} from "./detect.js";

// Report lines as ENVIRONMENT_DETECT_SCRIPT prints them on a systemd Ubuntu host with Docker.
const UBUNTU_REPORT = [
  "uname.s=Linux",
  "uname.r=6.8.0-45-generic",
  "uname.m=x86_64",
  "hostname=<hostname>",
  "shell=/bin/bash",
  'osr.PRETTY_NAME="Ubuntu 24.04.1 LTS"',
  'osr.NAME="Ubuntu"',
  'osr.VERSION_ID="24.04"',
  "osr.ID=ubuntu",
  "cpu.cores=8",
  "cpu.model=AMD EPYC 7763 64-Core Processor",
  "mem.total_kb=16303412",
  "mem.avail_kb=12001000",
  "disk.df=/dev/sda1        101444572 20412324  81015864      21% /",
  "uptime.s=86400.42",
  "tool.docker=Docker version 27.3.1, build ce12230",
  "tool.systemctl=systemd 255 (255.4-1ubuntu8.4)",
  "tool.psql=psql (PostgreSQL) 16.4",
  "tool.nginx=nginx version: nginx/1.24.0 (Ubuntu)",
  "tool.kubectl=Client Version: v1.31.1",
  "pm=apt-get",
  "docker.socket=/var/run/docker.sock",
  "docker.access=rw",
  "systemd=1",
  "svc.running=docker.service",
  "svc.running=nginx.service",
  "svc.running=ssh.service",
  "svc.failed=postgresql@16-main.service",
  "end=1",
].join("\n");

describe("parseEnvironmentReport", () => {
  it("turns a systemd Linux report into a ServerEnvironment", () => {
    const environment = parseEnvironmentReport({
      serverId: "srv_a1b2c3",
      output: UBUNTU_REPORT,
      detectedAtMs: 1_730_000_000_000,
    });

    expect(environment).toEqual({
      serverId: "srv_a1b2c3",
      detectedAtMs: 1_730_000_000_000,
      hostname: "<hostname>",
      os: {
        kernelName: "Linux",
        kernelRelease: "6.8.0-45-generic",
        arch: "x86_64",
        distroId: "ubuntu",
        distroName: "Ubuntu",
        distroVersion: "24.04",
        prettyName: "Ubuntu 24.04.1 LTS",
      },
      cpuCores: 8,
      cpuModel: "AMD EPYC 7763 64-Core Processor",
      memoryTotalBytes: 16303412 * 1024,
      memoryAvailableBytes: 12001000 * 1024,
      rootDisk: {
        mount: "/",
        totalBytes: 101444572 * 1024,
        usedBytes: 20412324 * 1024,
        availableBytes: 81015864 * 1024,
      },
      uptimeSeconds: 86400,
      shell: "/bin/bash",
      docker: {
        version: "Docker version 27.3.1, build ce12230",
        socketPath: "/var/run/docker.sock",
        socketAccessible: true,
      },
      podman: null,
      systemctl: { version: "systemd 255 (255.4-1ubuntu8.4)" },
      kubectl: { version: "Client Version: v1.31.1" },
      psql: { version: "psql (PostgreSQL) 16.4" },
      mysql: null,
      redisCli: null,
      nginx: { version: "nginx version: nginx/1.24.0 (Ubuntu)" },
      packageManagers: ["apt"],
      systemd: {
        runningServices: ["docker.service", "nginx.service", "ssh.service"],
        failedServices: ["postgresql@16-main.service"],
        runningTruncated: false,
      },
    });
  });

  it("reads macOS facts from sysctl and has no os-release, systemd or docker", () => {
    const output = [
      "uname.s=Darwin",
      "uname.r=24.1.0",
      "uname.m=arm64",
      "hostname=<hostname>",
      "shell=/bin/zsh",
      "cpu.cores=10",
      "cpu.cores=10",
      "cpu.model=Apple M1 Pro",
      "mem.total_bytes=34359738368",
      "disk.df=/dev/disk3s1s1   971350180 10471956 400023432     3% /",
      "pm=brew",
      "end=1",
    ].join("\n");

    const environment = parseEnvironmentReport({
      serverId: "srv_mac",
      output,
      detectedAtMs: 1,
    });

    expect(environment.os).toEqual({
      kernelName: "Darwin",
      kernelRelease: "24.1.0",
      arch: "arm64",
      distroId: null,
      distroName: null,
      distroVersion: null,
      prettyName: null,
    });
    expect(environment.memoryTotalBytes).toBe(34359738368);
    expect(environment.memoryAvailableBytes).toBeNull();
    expect(environment.uptimeSeconds).toBeNull();
    expect(environment.docker).toBeNull();
    expect(environment.systemd).toBeNull();
    expect(environment.packageManagers).toEqual(["brew"]);
  });

  it("reports a Docker socket the user cannot open as inaccessible, without a CLI", () => {
    const output = [
      "uname.s=Linux",
      "docker.socket=/var/run/docker.sock",
      "docker.access=denied",
      "end=1",
    ].join("\n");

    const environment = parseEnvironmentReport({ serverId: "srv_x", output, detectedAtMs: 1 });

    expect(environment.docker).toEqual({
      version: null,
      socketPath: "/var/run/docker.sock",
      socketAccessible: false,
    });
  });

  it("caps the running service list and says so", () => {
    const services = Array.from(
      { length: RUNNING_SERVICES_CAP + 1 },
      (_, index) => `svc.running=unit-${index}.service`,
    );
    const output = ["uname.s=Linux", "systemd=1", ...services, "end=1"].join("\n");

    const environment = parseEnvironmentReport({ serverId: "srv_x", output, detectedAtMs: 1 });

    expect(environment.systemd?.runningServices).toHaveLength(RUNNING_SERVICES_CAP);
    expect(environment.systemd?.runningTruncated).toBe(true);
  });

  it("rejects a report that was cut off before the end marker", () => {
    expect(() =>
      parseEnvironmentReport({ serverId: "srv_x", output: "uname.s=Linux\n", detectedAtMs: 1 }),
    ).toThrow(new EnvironmentReportError("missing_end_marker"));
  });

  it("rejects output that is not a detection report (a shell that ignored the script)", () => {
    expect(() =>
      parseEnvironmentReport({
        serverId: "srv_x",
        output: "% Unknown command\nend=1",
        detectedAtMs: 1,
      }),
    ).toThrow(new EnvironmentReportError("missing_uname"));
  });
});

describe("parseDfLine", () => {
  it("keeps mount points with spaces", () => {
    expect(parseDfLine("/dev/sdb1 1000 400 600 40% /mnt/backup disk")).toEqual({
      mount: "/mnt/backup disk",
      totalBytes: 1000 * 1024,
      usedBytes: 400 * 1024,
      availableBytes: 600 * 1024,
    });
  });

  it("returns null for a df error line", () => {
    expect(parseDfLine("df: /: No such file or directory")).toBeNull();
  });
});
