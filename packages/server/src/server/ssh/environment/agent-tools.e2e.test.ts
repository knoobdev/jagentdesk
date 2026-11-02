import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentPermissionResponse } from "../../agent/agent-sdk-types.js";
import {
  createSshAgentTools,
  type HostToolPermissionRequest,
  type SshAgentTool,
} from "./agent-tools.js";
import { createTestSshPool, type TestSshPool } from "./test-sshd.js";

interface PermissionLog {
  asked: HostToolPermissionRequest[];
  answer: AgentPermissionResponse;
}

function toolsFor(pool: TestSshPool, permissions: PermissionLog): Map<string, SshAgentTool> {
  const tools = createSshAgentTools({
    acquire: pool.acquire,
    callerAgentId: "agt_e2e",
    defaultServerId: "srv_e2e",
    async requestPermission(_agentId, request) {
      permissions.asked.push(request);
      return permissions.answer;
    },
    terminals: null,
    forwards: null,
    servers: null,
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function parse(result: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? "") as Record<string, unknown>;
}

describe("ssh_* agent tools against a real sshd", () => {
  let pool: TestSshPool;
  const scratch = `/tmp/jad-agent-tools-${process.pid}`;

  beforeAll(() => {
    pool = createTestSshPool();
  });

  afterAll(() => {
    pool.close();
  });

  it("ssh_run asks first, then returns stdout, stderr and the exit code", async () => {
    const permissions: PermissionLog = { asked: [], answer: { behavior: "allow" } };
    const tools = toolsFor(pool, permissions);

    const result = await tools
      .get("ssh_run")!
      .handler({ command: `mkdir -p ${scratch} && echo out && echo err >&2 && exit 3` }, {});

    expect(permissions.asked).toEqual([
      {
        kind: "tool",
        name: "ssh_run",
        title: "Run on srv_e2e",
        description: `mkdir -p ${scratch} && echo out && echo err >&2 && exit 3`,
        input: {
          serverId: "srv_e2e",
          command: `mkdir -p ${scratch} && echo out && echo err >&2 && exit 3`,
        },
      },
    ]);
    expect(parse(result)).toEqual({
      serverId: "srv_e2e",
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 3,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    });
  });

  it("ssh_run cuts each stream at 64 KB and stops at the timeout", async () => {
    const tools = toolsFor(pool, { asked: [], answer: { behavior: "allow" } });

    const big = parse(
      await tools.get("ssh_run")!.handler({ command: "head -c 200000 /dev/zero | tr '\\0' a" }, {}),
    );
    const slow = parse(
      await tools.get("ssh_run")!.handler({ command: "sleep 30", timeoutMs: 500 }, {}),
    );

    expect(big.stdoutTruncated).toBe(true);
    expect(String(big.stdout)).toHaveLength(64 * 1024);
    expect(slow.timedOut).toBe(true);
  });

  it("a denied ssh_run never reaches the server", async () => {
    const permissions: PermissionLog = { asked: [], answer: { behavior: "deny" } };
    const tools = toolsFor(pool, permissions);

    const result = await tools.get("ssh_run")!.handler({ command: `touch ${scratch}/denied` }, {});
    const check = await toolsFor(pool, { asked: [], answer: { behavior: "allow" } })
      .get("ssh_run")!
      .handler({ command: `test -e ${scratch}/denied && echo present || echo absent` }, {});

    expect(result).toEqual({ content: [{ type: "text", text: "Denied by user." }], isError: true });
    expect(parse(check).stdout).toBe("absent\n");
  });

  it("writes with approval, then reads and lists without asking", async () => {
    const permissions: PermissionLog = { asked: [], answer: { behavior: "allow" } };
    const tools = toolsFor(pool, permissions);
    const file = `${scratch}/notes.txt`;

    await tools
      .get("ssh_write_file")!
      .handler({ path: file, content: "hello from the agent\n" }, {});
    const read = parse(await tools.get("ssh_read_file")!.handler({ path: file }, {}));
    const listing = parse(await tools.get("ssh_list_dir")!.handler({ path: scratch }, {}));

    expect(permissions.asked.map((ask) => ask.name)).toEqual(["ssh_write_file"]);
    expect(read).toEqual({
      serverId: "srv_e2e",
      path: file,
      sizeBytes: 21,
      content: "hello from the agent\n",
      truncated: false,
    });
    expect(listing.entries).toEqual([
      expect.objectContaining({ name: "notes.txt", type: "file", sizeBytes: 21 }),
    ]);
  });

  it("ssh_read_file returns the first 1 MB of a larger file and flags binaries", async () => {
    const tools = toolsFor(pool, { asked: [], answer: { behavior: "allow" } });
    await tools.get("ssh_run")!.handler(
      {
        command: `head -c 1500000 /dev/zero | tr '\\0' b > ${scratch}/big.txt && head -c 64 /dev/zero > ${scratch}/zeros.bin`,
      },
      {},
    );

    const big = parse(
      await tools.get("ssh_read_file")!.handler({ path: `${scratch}/big.txt` }, {}),
    );
    const binary = parse(
      await tools.get("ssh_read_file")!.handler({ path: `${scratch}/zeros.bin` }, {}),
    );

    expect(big.sizeBytes).toBe(1_500_000);
    expect(String(big.content)).toHaveLength(1024 * 1024);
    expect(big.truncated).toBe(true);
    expect(binary).toEqual({
      serverId: "srv_e2e",
      path: `${scratch}/zeros.bin`,
      sizeBytes: 64,
      content: null,
      truncated: false,
    });
    await tools.get("ssh_run")!.handler({ command: `rm -rf ${scratch}` }, {});
  });
});
