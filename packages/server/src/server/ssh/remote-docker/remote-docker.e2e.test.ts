import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execCommand } from "../../../utils/spawn.js";
import { createTestSshPool, type TestSshPool } from "../environment/test-sshd.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { RemoteDockerService, RemoteDockerStreams, remoteDockerArgs } from "./cockpit.js";
import type { HostToolPermissionRequest } from "../environment/agent-tools.js";
import { createRemoteDockerTools } from "./agent-tools.js";
import { RemoteDockerError, RemoteDockerHosts } from "./hosts.js";
import { handleSshRemoteDockerMessage, type SshRemoteDockerOutboundMessage } from "./rpc.js";
import { DockerService } from "../../docker/docker-service.js";
import { DockerStreams } from "../../docker/docker-streams.js";
import { disposeRemoteDocker, routeDockerMessage } from "./route.js";
import { setDockerSocketAccess, setSshdOption } from "./test-remote-docker.js";

// The test sshd has the host Docker socket mounted at /var/run/docker.sock (root:root 0660), so
// "Docker on the server" is the host engine seen through SSH. The probe container is ours.
const PROBE = "jad-envdocker-probe";

async function hostDocker(args: string[]): Promise<string> {
  return (await execCommand("docker", args, { timeout: 60_000 })).stdout.trim();
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Opt-in: needs the Docker-enabled test sshd (jad-sshd-envdocker, see the header) and
// JAD_SSH_DOCKER_E2E=1.
describe.runIf(process.env.JAD_SSH_DOCKER_E2E === "1")(
  "Docker on an SSH server through a forwarded socket",
  () => {
    let pool: TestSshPool;
    let home: string;

    beforeAll(async () => {
      pool = createTestSshPool();
      home = mkdtempSync(path.join(tmpdir(), "jad-rd-"));
      await hostDocker(["rm", "-f", PROBE]).catch(() => "");
      await hostDocker(["run", "-d", "--name", PROBE, "alpine:latest", "sleep", "600"]);
      // The image defaults: jad may not open the socket, and sshd refuses forwarding.
      await setDockerSocketAccess(false);
    });

    afterAll(async () => {
      pool.close();
      await setDockerSocketAccess(false);
      await setSshdOption("AllowTcpForwarding", "no");
      await hostDocker(["rm", "-f", PROBE]);
      rmSync(home, { recursive: true, force: true });
    });

    it("ssh.docker.attach answers docker_socket_denied with the reason", async () => {
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
      });
      const emitted: SshRemoteDockerOutboundMessage[] = [];

      await handleSshRemoteDockerMessage(
        hosts,
        { type: "ssh.docker.attach.request", requestId: "req_1", serverId: "srv_e2e" },
        (message) => emitted.push(message),
      );

      expect(emitted).toEqual([
        {
          type: "ssh.docker.attach.response",
          payload: {
            requestId: "req_1",
            serverId: "srv_e2e",
            dockerHost: null,
            remoteSocketPath: null,
            error:
              "this user cannot open /var/run/docker.sock; add it to the docker group and reconnect",
            errorCode: "docker_socket_denied",
          },
        },
      ]);
    });

    it("refuses with docker_socket_denied while the user may not open the socket", async () => {
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
      });

      const attempt = hosts.attach("srv_e2e");

      await expect(attempt).rejects.toThrow(RemoteDockerError);
      await expect(attempt).rejects.toMatchObject({ code: "docker_socket_denied" });
      expect(hosts.isAttached("srv_e2e")).toBe(false);
    });

    // OpenSSH also gates direct-streamlocal channels on AllowTcpForwarding (local), which this image
    // sets to "no" — a common hardening that must surface as forwarding_refused.
    it("refuses with forwarding_refused when sshd disallows forwarding", async () => {
      await setDockerSocketAccess(true);
      pool.reconnect();
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
      });

      await expect(hosts.attach("srv_e2e")).rejects.toMatchObject({ code: "forwarding_refused" });

      await setSshdOption("AllowTcpForwarding", "yes");
      pool.reconnect();
    });

    it("lists exactly what `docker ps -a` shows, execs and restarts a container", async () => {
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
      });
      const attachment = await hosts.attach("srv_e2e");
      const cockpit = new RemoteDockerService(attachment.dockerHost);

      const snapshot = await cockpit.list();
      const expectedIds = (await hostDocker(["ps", "-a", "--no-trunc", "--format", "{{.ID}}"]))
        .split("\n")
        .map((id) => id.slice(0, 12));
      const hostname = await cockpit.exec(PROBE, "cat /etc/hostname");
      const startedBefore = await hostDocker(["inspect", "-f", "{{.State.StartedAt}}", PROBE]);
      await cockpit.action(PROBE, "restart");
      const startedAfter = await hostDocker(["inspect", "-f", "{{.State.StartedAt}}", PROBE]);

      expect(attachment.remoteSocketPath).toBe("/var/run/docker.sock");
      expect(attachment.dockerHost).toBe(`unix://${path.join(home, "run", "docker-srv_e2e.sock")}`);
      expect(statSync(attachment.localSocketPath).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(attachment.localSocketPath)).mode & 0o777).toBe(0o700);
      expect(snapshot.available).toBe(true);
      expect(snapshot.containers.map((container) => container.id).sort()).toEqual(
        expectedIds.sort(),
      );
      expect(snapshot.containers.find((container) => container.name === PROBE)).toMatchObject({
        image: "alpine:latest",
        state: "running",
      });
      const probeId = await hostDocker(["inspect", "-f", "{{.Id}}", PROBE]);
      expect(hostname).toBe(probeId.slice(0, 12));
      expect(startedAfter).not.toBe(startedBefore);
      await hosts.stopAll();
    });

    it("carries an interactive shell in a container both ways (the cockpit's exec terminal)", async () => {
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
      });
      const attachment = await hosts.attach("srv_e2e");
      const child = spawnProcess(
        "docker",
        remoteDockerArgs(attachment.dockerHost, ["exec", "-i", PROBE, "sh"]),
      );
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });

      child.stdin?.write("echo $((40 + 2))\n");
      await waitFor(() => output.includes("42"), 15_000);
      child.stdin?.end("exit\n");
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      await hosts.stopAll();

      expect(output).toBe("42\n");
      expect(code).toBe(0);
    });

    it("streams the snapshot and logs like the host cockpit", async () => {
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
      });
      const attachment = await hosts.attach("srv_e2e");
      const streams = new RemoteDockerStreams(new RemoteDockerService(attachment.dockerHost));
      const snapshots: number[] = [];
      const logChunks: string[] = [];

      await streams.subscribeSnapshot("sub_1", (snapshot) =>
        snapshots.push(snapshot.containers.length),
      );
      await hostDocker(["exec", PROBE, "sh", "-c", "echo jad-log-line > /proc/1/fd/1"]);
      streams.subscribeLogs("logs_1", PROBE, 10, (chunk) => logChunks.push(chunk));
      await waitFor(() => logChunks.join("").includes("jad-log-line"), 15_000);
      streams.disposeAll();
      await hosts.stopAll();

      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      expect(logChunks.join("")).toContain("jad-log-line");
    });

    it("closes the forwarded socket once nobody holds it for the idle timeout", async () => {
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
        idleTimeoutMs: 150,
      });

      const first = await hosts.use("srv_e2e", async (attachment) => {
        const second = await hosts.attach("srv_e2e");
        return { attachment, sameSocket: second.localSocketPath === attachment.localSocketPath };
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const stillHeld = hosts.isAttached("srv_e2e");
      hosts.detach("srv_e2e");
      await waitFor(() => !hosts.isAttached("srv_e2e"), 2_000);
      await waitFor(() => !existsSync(first.attachment.localSocketPath), 2_000);

      expect(first.sameSocket).toBe(true);
      expect(stillHeld).toBe(true);
    });

    it("server chat: docker_ps needs no approval and matches the server's docker ps", async () => {
      const asked: HostToolPermissionRequest[] = [];
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
      });
      const tools = createRemoteDockerTools({
        hosts,
        callerAgentId: "agt_e2e",
        defaultServerId: "srv_e2e",
        async requestPermission(_agentId, request) {
          asked.push(request);
          return { behavior: "allow" };
        },
      });
      const ps = tools.find((tool) => tool.name === "docker_ps")!;

      const result = await ps.handler({}, {});
      const expected = await hostDocker([
        "ps",
        "--format",
        "{{.ID}}  {{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}",
      ]);
      await hosts.stopAll();

      // Status ("Up 3 seconds") moves between the two calls; identity columns must match.
      const identity = (text: string) =>
        text.split("\n").map((line) => line.split("  ").slice(0, 3).join("  "));
      expect(asked).toEqual([]);
      expect(result.isError).toBeUndefined();
      expect(identity(result.content[0].text ?? "")).toEqual(identity(expected));
    });

    it("server chat: docker_restart raises the permission card and restarts only when allowed", async () => {
      const asked: HostToolPermissionRequest[] = [];
      let answer: "allow" | "deny" = "deny";
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
      });
      const tools = createRemoteDockerTools({
        hosts,
        callerAgentId: "agt_e2e",
        defaultServerId: "srv_e2e",
        async requestPermission(_agentId, request) {
          asked.push(request);
          return { behavior: answer };
        },
      });
      const restart = tools.find((tool) => tool.name === "docker_restart")!;
      const startedAt = () => hostDocker(["inspect", "-f", "{{.State.StartedAt}}", PROBE]);

      const before = await startedAt();
      const denied = await restart.handler({ container: PROBE }, {});
      const afterDenied = await startedAt();
      answer = "allow";
      const allowed = await restart.handler({ container: PROBE }, {});
      const afterAllowed = await startedAt();
      await hosts.stopAll();

      expect(asked).toEqual([
        {
          name: "docker_restart",
          kind: "tool",
          title: "Docker restart on srv_e2e",
          description: `docker restart ${PROBE}`,
          input: { serverId: "srv_e2e", args: ["restart", PROBE] },
        },
        {
          name: "docker_restart",
          kind: "tool",
          title: "Docker restart on srv_e2e",
          description: `docker restart ${PROBE}`,
          input: { serverId: "srv_e2e", args: ["restart", PROBE] },
        },
      ]);
      expect(denied).toEqual({
        content: [{ type: "text", text: "Denied by user." }],
        isError: true,
      });
      expect(afterDenied).toBe(before);
      expect(allowed).toEqual({ content: [{ type: "text", text: PROBE }] });
      expect(afterAllowed).not.toBe(before);
    });

    it("routes a docker/* request with serverId to the server and releases it after", async () => {
      const hosts = new RemoteDockerHosts({
        acquire: pool.acquire,
        runDirectory: path.join(home, "run"),
        idleTimeoutMs: 100,
      });
      const localService = new DockerService();
      const local = { service: localService, streams: new DockerStreams(localService) };

      const routed = await routeDockerMessage({ serverId: "srv_e2e" }, local, hosts);
      const again = await routeDockerMessage({ serverId: "srv_e2e" }, local, hosts);
      const snapshot = await routed.service.list();
      routed.release();
      routed.release();
      const heldByOther = hosts.isAttached("srv_e2e");
      again.release();
      await waitFor(() => !hosts.isAttached("srv_e2e"), 2_000);
      disposeRemoteDocker(local);

      expect(routed.serverId).toBe("srv_e2e");
      expect(routed.service).not.toBe(localService);
      expect(again.service).toBe(routed.service);
      expect(snapshot.containers.some((container) => container.name === PROBE)).toBe(true);
      expect(heldByOther).toBe(true);
    });
  },
);
