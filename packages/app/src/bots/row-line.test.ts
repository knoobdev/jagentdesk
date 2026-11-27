import { describe, expect, it } from "vitest";
import type { BotChatTree } from "@jagentdesk/protocol/bots/views";
import type { BotItem } from "@jagentdesk/protocol/bots/types";
import { botRowMark, selectBotRowLine } from "./row-line";

const NOW = Date.UTC(2026, 10, 27, 12);
function chat(overrides: Partial<BotChatTree["chats"][number]> = {}): BotChatTree["chats"][number] {
  return {
    id: "agent-side",
    kind: "side",
    title: "Release notes",
    live: "idle",
    lastActiveAt_ms: NOW,
    workers: [],
    runningTotal: 0,
    waitingTotal: 0,
    ...overrides,
  };
}
function waitingItem(text: string, at: number): BotItem {
  return {
    id: text,
    botId: "b",
    title: text,
    doneMeans: "done",
    status: "waiting",
    wait: { text, at_ms: at },
    workerAgentIds: [],
    comments: [],
    reviewRounds: 0,
    reviews: [],
    createdAt_ms: NOW,
    updatedAt_ms: NOW,
  };
}
const base = { paused: false, needsYou: 0, tree: undefined, items: [], now: NOW };

describe("selectBotRowLine (Orca bot-row-line.ts order)", () => {
  it("says Paused before anything else", () => {
    expect(selectBotRowLine({ ...base, paused: true, needsYou: 3 })).toEqual({ kind: "paused" });
  });
  it("puts what needs the owner before replying and working", () => {
    const tree = {
      home: chat({ id: "home", kind: "home", live: "replying" }),
      chats: [],
      workspaces: [],
    };
    const line = selectBotRowLine({ ...base, needsYou: 2, tree });
    expect(line).toEqual({ kind: "needYou", count: 2 });
    expect(botRowMark(line)).toBe("needs_input");
  });
  it("says Replying for Home Chat and names a side chat", () => {
    const home = {
      home: chat({ id: "home", kind: "home", live: "replying" }),
      chats: [],
      workspaces: [],
    };
    expect(selectBotRowLine({ ...base, tree: home })).toEqual({ kind: "replying", place: null });
    const side = { chats: [chat({ live: "replying" })], workspaces: [] };
    expect(selectBotRowLine({ ...base, tree: side })).toEqual({
      kind: "replying",
      place: { label: "Release notes", source: "chat" },
    });
  });
  it("counts running workers across chats", () => {
    const worker = (agentId: string, state: "running" | "done") => ({
      agentId,
      title: agentId,
      state,
      startedAt_ms: NOW,
    });
    const tree = {
      home: chat({
        id: "home",
        kind: "home",
        workers: [worker("w1", "running"), worker("w2", "done")],
      }),
      chats: [chat({ workers: [worker("w3", "running")] })],
      workspaces: [],
    };
    const line = selectBotRowLine({ ...base, tree });
    expect(line).toEqual({ kind: "working", count: 2 });
    expect(botRowMark(line)).toBe("running");
  });
  it("shows a wait only while its deadline is ahead, and counts several", () => {
    const one = selectBotRowLine({ ...base, items: [waitingItem("CI", NOW + 1000)] });
    expect(one).toEqual({ kind: "wait", label: "CI", by: NOW + 1000, more: 0 });
    expect(selectBotRowLine({ ...base, items: [waitingItem("CI", NOW - 1000)] })).toEqual({
      kind: "idle",
    });
    const two = selectBotRowLine({
      ...base,
      items: [waitingItem("CI", NOW + 1000), waitingItem("deploy", NOW + 2000)],
    });
    expect(two).toMatchObject({ kind: "wait", more: 1 });
  });
  it("falls back to Idle", () => {
    expect(selectBotRowLine(base)).toEqual({ kind: "idle" });
    expect(botRowMark({ kind: "idle" })).toBeNull();
  });
});
