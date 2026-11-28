import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";

// ADR-0064 / A4.27c.8 through a daemon and its client. The fake Codex provider runs each
// "Start background shell" command for real and lists it like Codex's background terminals,
// so the daemon sees a real-shaped item: its command and folder, no output of its own.
describe("background work output files, script and the agent's last read", () => {
  let ctx: DaemonTestContext;
  let cwd: string;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "bg-sources-e2e-")));
  }, 30_000);

  afterEach(async () => {
    await ctx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }, 30_000);

  async function startBackground(command: string) {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "bg" });
    await ctx.client.sendMessage(agent.id, `Start background shell: ${command}`);
    await ctx.client.waitForFinish(agent.id, 15_000);
    const items = await ctx.client.listAgentBackgroundWork(agent.id);
    expect(items).toHaveLength(1);
    return { agentId: agent.id, itemId: items[0].id };
  }

  test("a redirect file streams as it grows and the agent's tail shows as its last read", async () => {
    const log = join(cwd, "t.log");
    const { agentId, itemId } = await startBackground(
      `sh -c "for i in 1 2 3 4 5 6; do echo line-\\$i; sleep 0.5; done > ${log} 2>&1"`,
    );
    const pushes: string[] = [];
    const release = await ctx.client.subscribeAgentBackgroundWorkOutput({
      agentId,
      itemId,
      sourceId: "redirect:0",
      onOutput: (push) => pushes.push(push.chunk),
    });
    try {
      await expect.poll(() => pushes.join(""), { timeout: 5000 }).toContain("line-2\n");
      const startedAt = Date.now();
      const before = pushes.join("").split("\n").length;
      await expect
        .poll(() => pushes.join("").split("\n").length, { timeout: 2000 })
        .toBeGreaterThan(before);
      // A4.27c.8: new output within a second.
      expect(Date.now() - startedAt).toBeLessThan(1500);
    } finally {
      release();
    }

    await ctx.client.sendMessage(agentId, `Run shell: tail -n 2 t.log`);
    await ctx.client.waitForFinish(agentId, 15_000);
    const detail = await ctx.client.getAgentBackgroundWorkDetail(agentId, itemId);
    const redirect = detail.sources?.find((source) => source.kind === "redirect");
    expect(redirect).toMatchObject({ id: "redirect:0", label: "t.log", path: log });
    expect(redirect?.lastRead?.content).toMatch(/^line-\d\nline-\d\n$/);
  }, 30_000);

  test("the script a waiting command runs is shown", async () => {
    const script = join(cwd, "wait.sh");
    writeFileSync(script, "#!/bin/zsh\nwhile [ ! -f done ]; do\n  sleep 0.2\ndone\n");
    const { agentId, itemId } = await startBackground(`zsh ${script}`);
    try {
      const detail = await ctx.client.getAgentBackgroundWorkDetail(agentId, itemId);
      expect(detail.outputAvailable).toBe(false);
      expect(detail.sources).toEqual([
        { id: "provider", kind: "provider", label: "", available: false },
        {
          id: "script",
          kind: "script",
          label: "wait.sh",
          path: script,
          available: true,
          script: {
            content: "#!/bin/zsh\nwhile [ ! -f done ]; do\n  sleep 0.2\ndone\n",
            truncated: false,
            lineCount: 4,
          },
        },
      ]);
    } finally {
      writeFileSync(join(cwd, "done"), "");
    }
  }, 30_000);

  test("targets outside the allowed folders get no source and are not read", async () => {
    // A symlink out of the allowed folders, to a file this test never reads.
    symlinkSync("/etc/hosts", join(cwd, "l"));
    // The redirects sit behind `false &&` / `true ||`: the shell never opens them.
    const { agentId, itemId } = await startBackground(
      "sleep 3; false && echo x > ~/.ssh/jagentdesk-never 2>/dev/null; true || echo x > l",
    );
    const detail = await ctx.client.getAgentBackgroundWorkDetail(agentId, itemId);
    expect(detail.sources).toEqual([
      { id: "provider", kind: "provider", label: "", available: false },
    ]);
    for (const sourceId of ["redirect:0", "redirect:1", "redirect:2"]) {
      await expect(
        ctx.client.subscribeAgentBackgroundWorkOutput({
          agentId,
          itemId,
          sourceId,
          onOutput: () => undefined,
        }),
      ).rejects.toThrow();
    }
  }, 30_000);
});
