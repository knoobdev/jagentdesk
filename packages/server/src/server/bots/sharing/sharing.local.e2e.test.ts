// A37.13.1–A37.13.8 live: packages/relay on `wrangler dev --local` (its simulated R2 bucket) and two
// isolated daemons with their relay pointed at it. The sharer's daemon publishes over its relay
// control socket; the recipient's daemon opens the link and creates the bot, all through the daemons'
// WebSocket RPCs. The provider is the deterministic test client: sharing runs no model turn.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import pino from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import { createTestJAgentDeskDaemon } from "../../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";

const relayRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../../../relay");
const wranglerCli = createRequire(join(relayRoot, "package.json")).resolve(
  "wrangler/bin/wrangler.js",
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

let relay: ChildProcess | null = null;
let relayPort = 0;
let persist = "";
let relayLog = "";

beforeAll(async () => {
  relayPort = await freePort();
  persist = mkdtempSync(join(tmpdir(), "jad-share-live-r2-"));
  relay = spawn(
    process.execPath,
    [
      wranglerCli,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(relayPort),
      "--persist-to",
      persist,
      "--live-reload=false",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: relayRoot,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  relay.stdout?.on("data", (data: Buffer) => (relayLog += data.toString()));
  relay.stderr?.on("data", (data: Buffer) => (relayLog += data.toString()));
  const deadline = Date.now() + 80_000;
  while (Date.now() < deadline) {
    if (relay.exitCode !== null) throw new Error(`wrangler exited: ${relayLog}`);
    const ok = await fetch(`http://127.0.0.1:${relayPort}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`wrangler dev did not start: ${relayLog}`);
}, 90_000);

afterAll(async () => {
  relay?.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (relay && relay.exitCode === null) relay.kill("SIGKILL");
  rmSync(persist, { recursive: true, force: true });
});

async function startDaemon(listenPort: number) {
  const logger = pino({ level: "silent" });
  const daemon = await createTestJAgentDeskDaemon({
    listenPort,
    relay: { endpoint: `127.0.0.1:${relayPort}`, useTls: false },
    agentClients: { claude: createTestAgentClient("claude") },
    logger,
    botsTriggerSource: { poll: async () => [] },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.12.0",
  });
  await client.connect();
  return { daemon, client };
}

// The daemon allocates the folder from the name (bots contract): no slug, no modeId.
const botInput = (name: string) => ({
  name,
  provider: "claude" as const,
  model: "sonnet",
});

test(
  "A37.13.1–8: publish on one daemon, receive on another, update, stop, the 21st link",
  { timeout: 180_000 },
  async () => {
    const sharer = await startDaemon(6973);
    const recipient = await startDaemon(await freePort());
    try {
      const bot = (
        await sharer.client.botsRequest("bots.create.request", {
          bot: botInput("Release Pal"),
        })
      ).bot;
      // bt1 allocates the folder from the name: "release-pal".
      const home = join(sharer.daemon.jagentdeskHome, "bots", "release-pal");
      expect(bot.home).toBe(home);
      writeFileSync(join(home, "SOUL.md"), "# Release Pal\n\nShips releases and reviews PRs.\n");
      for (const skill of ["pr-review-checklist", "release-notes"]) {
        mkdirSync(join(home, "skills", skill), { recursive: true });
        writeFileSync(
          join(home, "skills", skill, "SKILL.md"),
          `---\nname: ${skill}\ndescription: ${skill} steps\n---\n# ${skill}\n`,
        );
      }
      writeFileSync(join(home, "memory", "repo-facts.md"), "Fact: tests run with vitest\n");
      await sharer.client.botsRequest("bots.schedules.save.request", {
        botId: bot.id,
        schedule: {
          name: "Weekday PRs",
          cron: "0 9 * * 1-5",
          prompt: "List open PRs",
          enabled: true,
        },
      });
      await expect
        .poll(
          async () =>
            (await sharer.client.botsRequest("bots.share.status.request", { botId: bot.id })).status
              .relayConnected,
          { timeout: 30_000 },
        )
        .toBe(true);

      // A37.13.3
      const skillPath = join(home, "skills", "release-notes", "SKILL.md");
      const skillText = readFileSync(skillPath, "utf8");
      writeFileSync(skillPath, `${skillText}token ghp_${"x".repeat(36)}\n`);
      const blocked = await sharer.client.botsRequest("bots.share.prepare.request", {
        botId: bot.id,
        selection: {},
      });
      expect(blocked.candidate.blocked).toBe(true);
      expect(blocked.candidate.flags.filter((f) => f.kind === "secret")).toHaveLength(1);
      await expect(
        sharer.client.botsRequest("bots.share.publish.request", {
          botId: bot.id,
          previewId: blocked.candidate.previewId,
        }),
      ).rejects.toThrow("bot_share_secret_found");
      writeFileSync(skillPath, skillText);

      // A37.13.1
      const prepared = await sharer.client.botsRequest("bots.share.prepare.request", {
        botId: bot.id,
        selection: {},
      });
      const published = await sharer.client.botsRequest("bots.share.publish.request", {
        botId: bot.id,
        previewId: prepared.candidate.previewId,
      });
      const link = published.status.link ?? "";
      expect(link).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:${relayPort}/s/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43}$`),
      );
      const plain = link.replace(/#.*/, "");
      const sealed = Buffer.from(await (await fetch(plain)).arrayBuffer());
      expect(() => gunzipSync(sealed)).toThrow();
      expect(sealed.includes(Buffer.from("Release Pal"))).toBe(false);

      // A37.13.4
      const opened = await recipient.client.botsRequest("bots.share.open.request", { link });
      const review = opened.review;
      if (!review) throw new Error("expected a review");
      expect(review.files.map((file) => file.path)).toEqual([
        "MEMORY.md",
        "SOUL.md",
        "skills/pr-review-checklist/SKILL.md",
        "skills/release-notes/SKILL.md",
      ]);
      expect(review.bot.schedules.map((s) => s.name)).toEqual(["Weekday PRs"]);
      const made = (
        await recipient.client.botsRequest("bots.share.create.request", {
          reviewId: review.reviewId,
          bot: botInput("Release Pal"),
        })
      ).bot;
      const madeSchedules = await recipient.client.botsRequest("bots.schedules.list.request", {
        botId: made.id,
      });
      expect(madeSchedules.schedules.map((s) => s.enabled)).toEqual([false]);
      const madeHome = join(recipient.daemon.jagentdeskHome, "bots", "release-pal");
      expect(readFileSync(join(madeHome, "SOUL.md"), "utf8")).toContain("Ships releases");
      expect(existsSync(join(madeHome, "memory", "repo-facts.md"))).toBe(false);
      expect(readFileSync(join(madeHome, "MEMORY.md"), "utf8")).toBe("# Memory\n");

      // A copy from the same link is found before anything is downloaded.
      expect(await recipient.client.botsRequest("bots.share.open.request", { link })).toMatchObject(
        {
          existing: { botId: made.id },
        },
      );

      // A37.13.6: Update link keeps the link; a review opened before asks to review again.
      const third = await startDaemon(await freePort());
      try {
        // A37.13.5: a wrong key creates nothing.
        await expect(
          third.client.botsRequest("bots.share.open.request", {
            link: link.replace(/#k=.*/, `#k=${Buffer.alloc(32, 7).toString("base64url")}`),
          }),
        ).rejects.toThrow("bot_share_invalid");
        expect((await third.client.botsRequest("bots.list.request", {})).bots).toHaveLength(0);
        expect(existsSync(join(third.daemon.jagentdeskHome, "bots", "release-pal"))).toBe(false);
        const pending = await third.client.botsRequest("bots.share.open.request", { link });
        writeFileSync(join(home, "SOUL.md"), "# Release Pal\n\nShips releases.\n");
        const again = await sharer.client.botsRequest("bots.share.prepare.request", {
          botId: bot.id,
          selection: {},
          last: true,
        });
        const updated = await sharer.client.botsRequest("bots.share.publish.request", {
          botId: bot.id,
          previewId: again.candidate.previewId,
        });
        expect(updated.status.link).toBe(link);
        await expect(
          third.client.botsRequest("bots.share.create.request", {
            reviewId: pending.review?.reviewId ?? "",
            bot: botInput("Release Pal"),
          }),
        ).rejects.toThrow("bot_share_updated");

        // A37.13.7
        await sharer.client.botsRequest("bots.share.stop.request", { botId: bot.id });
        expect((await fetch(plain)).status).toBe(410);
        await expect(third.client.botsRequest("bots.share.open.request", { link })).rejects.toThrow(
          "bot_share_stopped",
        );
      } finally {
        await third.client.close().catch(() => {});
        await third.daemon.close();
      }

      // A37.13.8: 20 live links, then the 21st is refused and nothing is written.
      const links = new Set<string>();
      for (let index = 0; index < 21; index++) {
        const many = (
          await sharer.client.botsRequest("bots.create.request", {
            bot: botInput(`Many ${index}`),
          })
        ).bot;
        const candidate = await sharer.client.botsRequest("bots.share.prepare.request", {
          botId: many.id,
          selection: {},
        });
        const publish = sharer.client.botsRequest("bots.share.publish.request", {
          botId: many.id,
          previewId: candidate.candidate.previewId,
        });
        if (index < 20) links.add((await publish).status.link ?? "");
        else await expect(publish).rejects.toThrow("bot_share_limit");
      }
      expect(links.size).toBe(20);
      // A37.13.2: nothing the Worker printed carries a key.
      expect(relayLog).not.toMatch(/#k=|k=[A-Za-z0-9_-]{43}/);
    } finally {
      await sharer.client.close().catch(() => {});
      await recipient.client.close().catch(() => {});
      await sharer.daemon.close();
      await recipient.daemon.close();
    }
  },
);
