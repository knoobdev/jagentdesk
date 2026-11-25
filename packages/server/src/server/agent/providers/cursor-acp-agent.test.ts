import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { CursorACPAgentClient } from "./cursor-acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

describe("CursorACPAgentClient usage session", () => {
  test("matches usage sources as cursor, with the agent's provider and launch env", async () => {
    await withFakeACPAgent(async (command, cwd) => {
      const client = new CursorACPAgentClient({
        logger: createTestLogger(),
        command,
        env: { XDG_CONFIG_HOME: "/profile/config" },
      });
      const session = await client.createSession(
        { provider: "acp", cwd },
        { agentId: "agent-1", env: { HOME: "/agent/home" } },
      );
      const usage = session.usageSession?.();
      expect(usage).toMatchObject({
        provider: "cursor",
        env: { XDG_CONFIG_HOME: "/profile/config", HOME: "/agent/home" },
      });
      expect(session.usageSession?.()?.sessionKey).toBe(usage?.sessionKey);
      await session.close();
      expect(session.usageSession?.()).toBeNull();
    });
  });

  test("leaves other ACP agents without a usage session", async () => {
    await withFakeACPAgent(async (command, cwd) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });
      const session = await client.createSession({ provider: "acp", cwd });
      try {
        expect(session.usageSession?.()).toBeNull();
      } finally {
        await session.close();
      }
    });
  });
});

async function withFakeACPAgent(
  run: (command: [string, ...string[]], cwd: string) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "jagentdesk-cursor-usage-"));
  try {
    const scriptPath = path.join(testDir, "fake-acp-agent.cjs");
    await writeFile(scriptPath, fakeACPAgentScript, "utf8");
    await run([process.execPath, scriptPath], testDir);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

const fakeACPAgentScript = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? 1, agentCapabilities: {} } });
  } else if (message.method === "session/new") {
    write({ id: message.id, result: { sessionId: "session-1" } });
  } else if (message.id !== undefined) {
    write({ id: message.id, result: {} });
  }
});
`;
