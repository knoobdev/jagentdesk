import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SSH_SERVER_AGENT_LABEL } from "@jagentdesk/protocol/ssh/server-chat-prompt";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { execCommand } from "../../utils/spawn.js";
import { SshModules } from "./modules.js";
import { SshService } from "./ssh-service.js";
import net from "node:net";

// S1's real SshService with the S6–S8 modules wired as bootstrap does, against a real sshd whose
// /var/run/docker.sock is the host's Docker socket (read-only use here: `docker ps`), with `jad`
// in the socket's group, the docker CLI installed and TCP forwarding on. Start it with
//   bash src/server/ssh/test-support/start-docker-test-sshd.sh   (jad-sshd-wire, 127.0.0.1:2237)
// then run with JAD_SSH_DOCKER_E2E=1 (JAD_WIRE_SSHD_PORT for another port).
const PORT = Number(process.env.JAD_WIRE_SSHD_PORT ?? 2237);

// Opt-in: needs the Docker-enabled test sshd (jad-sshd-wire) and JAD_SSH_DOCKER_E2E=1.
describe.runIf(process.env.JAD_SSH_DOCKER_E2E === "1")(
  "SSH modules wired into SshService (real sshd)",
  () => {
    let home: string;
    let service: SshService;
    let modules: SshModules;
    let serverId: string;
    const pushes: SessionOutboundMessage[] = [];
    const permissionRequests: string[] = [];

    beforeAll(async () => {
      // Short base dir: the forwarded Docker socket path must fit sun_path (104 bytes on macOS).
      home = await mkdtemp("/tmp/jad-wire-");
      service = new SshService({
        jagentdeskHome: home,
        logger: createTestLogger(),
        broadcast: (message) => {
          pushes.push(message);
          // The user trusts the throwaway test host key on first use (spec 25.3).
          if (message.type === "ssh.hostkey.prompt")
            service.respondHostKey(message.promptId, "accept");
        },
      });
      await service.initialize();
      modules = new SshModules({
        sshService: service,
        jagentdeskHome: home,
        logger: createTestLogger(),
        agentLabels: (agentId) =>
          agentId === "agent_server_chat" ? { [SSH_SERVER_AGENT_LABEL]: serverId } : null,
        requestPermission: async (_agentId, request) => {
          permissionRequests.push(request.name);
          return { behavior: "allow" };
        },
      });
      service.modules = modules;
      const saved = await service.saveServer(
        {
          id: "",
          label: "wire test",
          address: "127.0.0.1",
          port: PORT,
          username: "jad",
          authMethods: ["password"],
        },
        { password: "jadtest" },
      );
      serverId = saved.id;
    });

    afterAll(async () => {
      await modules.dispose();
      service.dispose();
      await rm(home, { recursive: true, force: true });
    });

    it("detects the environment when the server connects and keeps it in servers.json", async () => {
      const lease = await service.acquireClient(serverId);
      lease.release();

      await vi.waitFor(() => expect(modules.environment.get(serverId)).not.toBeNull(), {
        timeout: 20_000,
        interval: 100,
      });
      const environment = modules.environment.get(serverId);
      expect(environment?.os.kernelName).toBe("Linux");
      expect(environment?.os.distroId).toBe("alpine");
      expect(environment?.docker?.socketAccessible).toBe(true);

      await service.storage.flush();
      const saved = JSON.parse(await readFile(path.join(home, "ssh", "servers.json"), "utf8"));
      const record = (Array.isArray(saved) ? saved : saved.servers).find(
        (server: { id: string }) => server.id === serverId,
      );
      expect(record.environment.serverId).toBe(serverId);
    });

    it("answers ssh.environment.detect through the session module handlers", async () => {
      const out: SessionOutboundMessage[] = [];
      const message = {
        type: "ssh.environment.detect.request",
        requestId: "req_env",
        serverId,
      } satisfies Extract<SessionInboundMessage, { type: "ssh.environment.detect.request" }>;
      for (const handler of modules.handlers) {
        if (await handler(message, (msg) => out.push(msg))) break;
      }
      expect(out).toHaveLength(1);
      const response = out[0];
      if (response.type !== "ssh.environment.detect.response") throw new Error(response.type);
      expect(response.payload).toMatchObject({ requestId: "req_env", serverId, error: null });
      expect(response.payload.environment?.os.distroId).toBe("alpine");
    });

    it("a server chat's docker_ps lists the server's containers without an explicit serverId", async () => {
      const tools = modules.createAgentTools("agent_server_chat");
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "ssh_run",
          "ssh_read_file",
          "ssh_list_dir",
          "docker_ps",
          "docker_logs",
        ]),
      );
      const dockerPs = tools.find((tool) => tool.name === "docker_ps");
      if (!dockerPs) throw new Error("docker_ps missing");

      const result = await dockerPs.handler({ allContainers: true }, {});
      const text = result.content.map((part) => part.text ?? "").join("\n");
      expect({ isError: result.isError ?? false, text }).toMatchObject({ isError: false });

      // The server's socket is this machine's Docker, so the ids must match a local `docker ps -a`.
      const local = await execCommand("docker", ["ps", "--all", "--format", "{{.ID}}"]);
      const ids = local.stdout.split("\n").filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(text).toContain(id);

      const sshRun = tools.find((tool) => tool.name === "ssh_run");
      const run = await sshRun?.handler({ command: "uname -s" }, {});
      expect(run?.content.map((part) => part.text ?? "").join("")).toContain("Linux");
    });

    it("records the SSH terminal's output once logging is on for the server", async () => {
      await modules.logs.setEnabled(serverId, true);
      const terminalId = service.createSession(serverId, { cols: 100, rows: 30 });
      const session = service.getSshTerminalSession(terminalId);
      if (!session) throw new Error("no session");
      await vi.waitFor(() => expect(session.hasShell()).toBe(true), { timeout: 20_000 });
      session.typeInput("echo wired-$((20+3))\n");
      await vi.waitFor(
        async () => {
          const window = await modules.logs.read({ kind: "recent", serverId });
          expect(window.text).toContain("wired-23");
        },
        { timeout: 10_000, interval: 200 },
      );
      session.end();
    });

    it("ssh_forward_start opens a local forward through the server after the permission card", async () => {
      const tools = modules.createAgentTools("agent_server_chat");
      const start = tools.find((tool) => tool.name === "ssh_forward_start");
      const stop = tools.find((tool) => tool.name === "ssh_forward_stop");
      if (!start || !stop) throw new Error("forward tools missing");
      expect([start.requiresPermission, stop.requiresPermission]).toEqual([true, true]);

      const free = net.createServer();
      await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
      const freePort = (free.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => free.close(() => resolve()));
      const started = await start.handler(
        { kind: "local", bindPort: freePort, destHost: "127.0.0.1", destPort: 2222 },
        {},
      );
      const { forwardId, description } = JSON.parse(started.content[0]?.text ?? "{}");
      expect(permissionRequests).toContain("ssh_forward_start");
      expect(description).toBe(`local 127.0.0.1:${freePort} → 127.0.0.1:2222`);
      const port = freePort;

      const banner = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("data", (chunk) => {
          socket.destroy();
          resolve(chunk.toString("utf8"));
        });
        socket.once("error", reject);
      });
      expect(banner).toMatch(/^SSH-2\.0-OpenSSH/);

      await stop.handler({ forwardId }, {});
      expect(modules.forwarding.list().rules.map((rule) => rule.id)).not.toContain(forwardId);
    });

    it("skips detection on connect for a server with detectEnvironment off", async () => {
      const quiet = await service.saveServer(
        {
          id: "",
          label: "no detect",
          address: "127.0.0.1",
          port: PORT,
          username: "jad",
          authMethods: ["password"],
          detectEnvironment: false,
        },
        { password: "jadtest" },
      );
      expect(await modules.environment.onConnected(quiet.id)).toBeNull();
      expect(service.storage.getServer(quiet.id)?.detectEnvironment).toBe(false);
    });
  },
);
