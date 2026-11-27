import { describe, expect, it } from "vitest";
import {
  botPermissionRequestText,
  botProjectName,
  readBotPermissionCard,
  type BotPermissionCard,
} from "./permission-cards.js";

const start: BotPermissionCard = {
  kind: "worker_start",
  botName: "Release helper",
  itemNumber: 4,
  itemTitle: "Fix the flaky login test",
  projectPath: "/Users/me/code/shop-web",
  projectName: "shop-web",
  task: "Find why login.spec.ts fails on CI and fix it.",
};

describe("bot permission cards (spec 37.3.2-37.3.3)", () => {
  it("words a worker start by its item, project, new worktree and task", () => {
    const text = botPermissionRequestText(start);
    expect(text.title).toBe("Start a worker for #4 Fix the flaky login test?");
    expect(text.description).toBe(
      "Release helper starts a worker in a new worktree of shop-web (/Users/me/code/shop-web). The worker reports back when it is done.",
    );
    expect(text.detail).toEqual({ type: "plain_text", label: "Task", text: start.task });
    expect(`${text.title} ${text.description}`).not.toMatch(/ORC|NEW worktree|end your turn|\{/);
  });

  it("words a hand-off by the bot it reaches", () => {
    const text = botPermissionRequestText({
      kind: "handoff",
      botName: "Release helper",
      toBotName: "Docs bot",
      type: "question",
      text: "Which page covers relay setup?",
    });
    expect(text.title).toBe("Ask Docs bot?");
    expect(text.description).toBe("Release helper sends Docs bot this message.");
  });

  it("reads its card back from the request metadata, and nothing else", () => {
    const { metadata } = botPermissionRequestText(start);
    expect(readBotPermissionCard(JSON.parse(JSON.stringify(metadata)))).toEqual(start);
    expect(readBotPermissionCard({ botCard: { kind: "worker_start", botName: "x" } })).toBeNull();
    expect(readBotPermissionCard({ planText: "…" })).toBeNull();
    expect(readBotPermissionCard(undefined)).toBeNull();
  });

  it("names a project by its folder", () => {
    expect(botProjectName("/Users/me/code/shop-web/")).toBe("shop-web");
    expect(botProjectName("C:\\code\\api")).toBe("api");
  });
});
