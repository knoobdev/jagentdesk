import { expect, it } from "vitest";
import type { BotItem } from "@jagentdesk/protocol/bots/types";
import { patchItem } from "./items.js";
const item: BotItem = {
  id: "i",
  botId: "b",
  title: "Fix",
  doneMeans: "Tests pass",
  status: "working",
  workerAgentIds: ["w"],
  comments: [],
  reviewRounds: 0,
  reviews: [],
  createdAt_ms: 0,
  updatedAt_ms: 0,
};
it("requires wake conditions, valid quick replies, and daemon review for worker completion", () => {
  expect(() => patchItem(item, { status: "waiting" })).toThrow("Waiting needs");
  expect(() => patchItem(item, { status: "done" })).toThrow("cross-review");
  expect(() =>
    patchItem(item, {
      status: "needs_you",
      questions: [{ text: "Which?", options: ["A"], recommended: 1 }],
    }),
  ).toThrow("out of range");
  const waiting = patchItem(item, {
    status: "waiting",
    waitFor: { condition: "CI", until_ms: 1000 },
  });
  expect(patchItem(waiting, { status: "working" }).waitFor).toBeUndefined();
  const done = patchItem(item, { status: "done" }, true);
  expect(() => patchItem(done, { status: "working" })).toThrow();
});
