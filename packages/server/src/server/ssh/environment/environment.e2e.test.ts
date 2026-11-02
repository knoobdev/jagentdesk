import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRemoteCommand } from "./remote-exec.js";
import { SshEnvironmentService } from "./service.js";
import { FileEnvironmentStore } from "./store.js";
import { createTestSshPool, type TestSshPool } from "./test-sshd.js";

async function remote(pool: TestSshPool, command: string): Promise<string> {
  const { client } = await pool.acquire("srv_e2e");
  const result = await runRemoteCommand(client, {
    command,
    timeoutMs: 20_000,
    maxBytesPerStream: 64 * 1024,
  });
  return result.stdout.trim();
}

// Opt-in: needs the Docker-enabled test sshd (jad-sshd-envdocker, see the header) and
// JAD_SSH_DOCKER_E2E=1.
describe.runIf(process.env.JAD_SSH_DOCKER_E2E === "1")(
  "SshEnvironmentService against a real sshd",
  () => {
    let pool: TestSshPool;
    let home: string;

    beforeAll(() => {
      pool = createTestSshPool();
      home = mkdtempSync(path.join(tmpdir(), "jad-ssh-env-"));
    });

    afterAll(() => {
      pool.close();
      rmSync(home, { recursive: true, force: true });
    });

    it("detects the server facts the shell reports, over one exec channel", async () => {
      const service = new SshEnvironmentService({
        acquire: pool.acquire,
        store: new FileEnvironmentStore(home),
        isAutoDetectEnabled: () => true,
        now: () => 1_700_000_000_000,
      });

      const environment = await service.detect("srv_e2e", { force: true });

      const expectedPretty = await remote(pool, '. /etc/os-release && echo "$PRETTY_NAME"');
      const expectedKernel = await remote(pool, "uname -r");
      const expectedArch = await remote(pool, "uname -m");
      const expectedCores = Number(await remote(pool, "nproc"));
      const expectedSocket = await remote(pool, "test -S /var/run/docker.sock && echo yes");
      expect(environment).toMatchObject({
        serverId: "srv_e2e",
        detectedAtMs: 1_700_000_000_000,
        os: {
          kernelName: "Linux",
          kernelRelease: expectedKernel,
          arch: expectedArch,
          distroId: "alpine",
          prettyName: expectedPretty,
        },
        cpuCores: expectedCores,
        shell: "/bin/bash",
        packageManagers: ["apk"],
        // The test image has no systemd, no docker CLI and none of the database clients.
        systemd: null,
        systemctl: null,
        kubectl: null,
        psql: null,
        mysql: null,
        redisCli: null,
        podman: null,
      });
      expect(expectedSocket).toBe("yes");
      // The host Docker socket is mounted but owned by root:root 0660, so jad cannot use it.
      expect(environment.docker).toEqual({
        version: null,
        socketPath: "/var/run/docker.sock",
        socketAccessible: false,
      });
      expect(environment.memoryTotalBytes).toBeGreaterThan(0);
      expect(environment.rootDisk?.mount).toBe("/");
    });

    it("serves the cached environment until forced, and persists it 0600", async () => {
      let tick = 1;
      const store = new FileEnvironmentStore(home);
      const service = new SshEnvironmentService({
        acquire: pool.acquire,
        store,
        isAutoDetectEnabled: () => false,
        now: () => tick++,
      });

      const first = await service.detect("srv_cache", { force: false });
      const cached = await service.detect("srv_cache", { force: false });
      const refreshed = await service.detect("srv_cache", { force: true });

      expect(first.detectedAtMs).toBe(1);
      expect(cached.detectedAtMs).toBe(1);
      expect(refreshed.detectedAtMs).toBe(2);
      expect(await service.onConnected("srv_cache")).toBeNull();
      expect(new FileEnvironmentStore(home).read("srv_cache")?.detectedAtMs).toBe(2);
      const file = path.join(home, "ssh", "environments.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    });
  },
);
