import { describe, expect, it } from "vitest";
import { withSshDocker } from "./ssh-docker-client";

// A stand-in with the same method shapes the cockpit calls on DaemonClient.
class RecordingClient {
  readonly calls: unknown[][] = [];
  async dockerAction(options: { container: string; action: string; serverId?: string }) {
    this.calls.push(["dockerAction", options]);
    return { error: null };
  }
  async createTerminal(cwd: string, name: string, size: undefined, options: object) {
    this.calls.push(["createTerminal", cwd, name, size, options]);
    return { terminal: null, error: null };
  }
  async listAgents() {
    this.calls.push(["listAgents"]);
    return [];
  }
}

describe("withSshDocker", () => {
  it("adds the server to docker requests and points the exec terminal at the forwarded socket", async () => {
    const base = new RecordingClient();
    const client = withSshDocker(base, {
      serverId: "srv_a1b2c3",
      dockerHost: "unix:///home/user/.jagentdesk/ssh/run/docker-srv_a1b2c3.sock",
    });

    await client.dockerAction({ container: "web", action: "restart" });
    await client.createTerminal("/", "sh @ web", undefined, {
      command: "docker",
      args: ["exec", "-it", "web", "sh"],
    });
    await client.listAgents();

    expect(base.calls).toEqual([
      ["dockerAction", { container: "web", action: "restart", serverId: "srv_a1b2c3" }],
      [
        "createTerminal",
        "/",
        "sh @ web",
        undefined,
        {
          command: "docker",
          args: [
            "--host",
            "unix:///home/user/.jagentdesk/ssh/run/docker-srv_a1b2c3.sock",
            "exec",
            "-it",
            "web",
            "sh",
          ],
        },
      ],
      ["listAgents"],
    ]);
  });
});
