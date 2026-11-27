import { describe, expect, test } from "vitest";
import { backgroundWorkRowStatus, backgroundWorkText, showsDismissAll } from "./presentation";

test("shows descriptions and commands once, with useful fallbacks", () => {
  expect(
    backgroundWorkText({ description: "Watch build", command: "tail -f build.log" }, "Monitor"),
  ).toEqual({ title: "Watch build", command: "tail -f build.log" });
  expect(backgroundWorkText({ description: null, command: "sleep 10" }, "Shell")).toEqual({
    title: "sleep 10",
    command: null,
  });
  expect(backgroundWorkText({ description: "sleep 10", command: "sleep 10" }, "Shell")).toEqual({
    title: "sleep 10",
    command: null,
  });
  expect(backgroundWorkText({ description: null }, "Shell")).toEqual({
    title: "Shell",
    command: null,
  });
});

describe("backgroundWorkRowStatus", () => {
  test("live work shows its running time", () => {
    expect(backgroundWorkRowStatus({ state: "live" })).toEqual({ kind: "elapsed" });
  });

  test("finished work names its outcome and exit code on one line", () => {
    expect(
      backgroundWorkRowStatus({ state: "finished", outcome: { status: "finished", exitCode: 0 } }),
    ).toEqual({
      kind: "text",
      tone: "success",
      key: "message.backgroundWork.detail.statusValue.finished",
      exitCode: 0,
    });
    expect(
      backgroundWorkRowStatus({ state: "finished", outcome: { status: "failed", exitCode: 2 } }),
    ).toEqual({
      kind: "text",
      tone: "danger",
      key: "message.backgroundWork.detail.statusValue.failed",
      exitCode: 2,
    });
    expect(
      backgroundWorkRowStatus({ state: "finished", outcome: { status: "stopped", exitCode: 143 } }),
    ).toEqual({
      kind: "text",
      tone: "muted",
      key: "message.backgroundWork.detail.statusValue.stopped",
      exitCode: null,
    });
  });

  test("ended work whose outcome is not known yet says Ended, not the old two-line notice", () => {
    expect(backgroundWorkRowStatus({ state: "finished", outcome: null })).toEqual({
      kind: "text",
      tone: "muted",
      key: "message.backgroundWork.ended",
      exitCode: null,
    });
  });

  test("an unknown provider status reads as finished, as in the detail", () => {
    expect(
      backgroundWorkRowStatus({ state: "finished", outcome: { status: "done", exitCode: null } }),
    ).toMatchObject({ tone: "success", key: "message.backgroundWork.detail.statusValue.finished" });
  });

  test("a stop in flight or unconfirmed keeps its own wording", () => {
    expect(backgroundWorkRowStatus({ state: "stopping", failed: false })).toMatchObject({
      key: "message.backgroundWork.stopping",
    });
    expect(backgroundWorkRowStatus({ state: "stopping", failed: true })).toMatchObject({
      tone: "danger",
      key: "message.backgroundWork.stopError",
    });
  });
});

test("offers Dismiss all from two ended tasks", () => {
  expect(showsDismissAll(1)).toBe(false);
  expect(showsDismissAll(2)).toBe(true);
});
