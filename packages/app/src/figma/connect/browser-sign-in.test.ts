import { describe, expect, it } from "vitest";
import { finishFigmaBrowserSignIn, type FigmaBrowserReply } from "./browser-sign-in";

const BEGIN = {
  attemptId: "atp_1",
  authorizeUrl: "https://www.figma.com/oauth?state=st_1",
  redirectUri: "http://127.0.0.1:8766/figma/callback",
};

function harness() {
  let reply!: (reply: FigmaBrowserReply) => void;
  const pending = new Promise<FigmaBrowserReply>((resolve) => {
    reply = resolve;
  });
  const cancelled: string[] = [];
  const completed: unknown[] = [];
  let opens = 0;
  const ports = {
    open: async () => {
      opens++;
      return pending;
    },
    cancel: async (state: string) => {
      cancelled.push(state);
    },
    complete: async (input: { attemptId: string; code: string; state: string }) => {
      completed.push(input);
      return { connection: { id: "fgc_1" } };
    },
  };
  return { ports, reply, cancelled, completed, opens: () => opens };
}

describe("browser OAuth recovery", () => {
  it("cancels the matching listener and never exchanges a late code", async () => {
    const h = harness();
    const controller = new AbortController();
    let codes = 0;
    const result = finishFigmaBrowserSignIn(h.ports, BEGIN, {
      signal: controller.signal,
      onCode: () => {
        codes++;
      },
    });
    controller.abort();
    h.reply({ kind: "code", code: "late", state: "st_1" });
    await expect(result).resolves.toEqual({ kind: "error", message: "Sign-in cancelled." });
    expect(h.cancelled).toEqual(["st_1"]);
    expect(h.completed).toEqual([]);
    expect(codes).toBe(0);
  });

  it("does not open the browser for a cancelled attempt", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      finishFigmaBrowserSignIn(h.ports, BEGIN, {
        signal: controller.signal,
        onCode: () => {},
      }),
    ).resolves.toEqual({ kind: "error", message: "Sign-in cancelled." });
    expect(h.opens()).toBe(0);
    expect(h.cancelled).toEqual([]);
    expect(h.completed).toEqual([]);
  });

  it("switches out of waiting before exchanging the code, then removes cancellation", async () => {
    const h = harness();
    const controller = new AbortController();
    let received = false;
    const result = finishFigmaBrowserSignIn(
      {
        ...h.ports,
        complete: async (input) => {
          expect(received).toBe(true);
          controller.abort();
          return h.ports.complete(input);
        },
      },
      BEGIN,
      {
        signal: controller.signal,
        onCode: () => {
          received = true;
        },
      },
    );
    h.reply({ kind: "code", code: "c_1", state: "st_1" });
    await expect(result).resolves.toEqual({ kind: "connected" });
    expect(h.cancelled).toEqual([]);
    expect(h.completed).toEqual([{ attemptId: "atp_1", code: "c_1", state: "st_1" }]);
  });

  it("surfaces a failure to cancel instead of leaving the attempt waiting forever", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = finishFigmaBrowserSignIn(
      {
        ...h.ports,
        cancel: async () => {
          throw new Error("Desktop disconnected.");
        },
      },
      BEGIN,
      { signal: controller.signal, onCode: () => {} },
    );
    controller.abort();
    await expect(result).rejects.toThrow("Desktop disconnected.");
    expect(h.completed).toEqual([]);
  });
});
