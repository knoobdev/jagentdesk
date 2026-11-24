import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { planBotContext, mentionedSlugs } from "./context.js";
import type { Bot } from "@jagentdesk/protocol/bots/types";
it("injects changed home files, caps memory, and masks quoted mentions", async () => {
  const home = await mkdtemp(join(tmpdir(), "bot-context-"));
  try {
    const bot: Bot = {
      id: "b",
      slug: "b",
      name: "B",
      identity: "Help",
      provider: "claude",
      model: "default",
      modeId: "default",
      unattended: false,
      paused: false,
      schedules: [],
      lookAround: { enabled: false, intervalMinutes: 60 },
      createdAt_ms: 0,
      updatedAt_ms: 0,
    };
    await writeFile(join(home, "SOUL.md"), "Be concise");
    await writeFile(
      join(home, "MEMORY.md"),
      Array.from({ length: 220 }, (_, i) => `fact ${i}`).join("\n"),
    );
    const first = await planBotContext(home, bot, []);
    expect(first.text).toContain("fact 199");
    expect(first.text).not.toContain("fact 200");
    const next = await planBotContext(home, bot, [], first.receipt);
    expect(next.text).not.toContain("SOUL.md (updated)");
    await writeFile(join(home, "SOUL.md"), "Be precise");
    expect((await planBotContext(home, bot, [], first.receipt)).text).toContain("Be precise");
    expect([...mentionedSlugs("@alice `@bob`\n> @charlie\n```\n@david\n```\n@eve")]).toEqual([
      "alice",
      "eve",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
