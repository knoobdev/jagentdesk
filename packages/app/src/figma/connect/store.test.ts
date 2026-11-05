import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  configureFigmaConnect,
  getFigmaConnectState,
  requestFigmaDelegatedSignIn,
  resetFigmaConnect,
  setFigmaConnectDraft,
  startFigmaBrowserSignIn,
  startFigmaPasteSignIn,
  submitFigmaPastedUrl,
  subscribeFigmaConnect,
  type FigmaBeginResult,
} from "./store";

// The connect store (spec 32.2) decides sign-in outcomes from the daemon replies and the pasted
// URL alone — no browser, no daemon, no timers.

const BEGUN: FigmaBeginResult = {
  attemptId: "atp_1",
  authorizeUrl: "https://www.figma.com/oauth?client_id=x",
  redirectUri: "http://127.0.0.1:8766/figma/callback",
};

type Ops = NonNullable<Parameters<typeof configureFigmaConnect>[0]>;

let begin: Mock<Ops["begin"]>;
let complete: Mock<Ops["complete"]>;
let runLoopback: Mock<Ops["runLoopback"]>;
let delegate: Mock<Ops["delegate"]>;

beforeEach(() => {
  begin = vi.fn<Ops["begin"]>().mockResolvedValue(BEGUN);
  complete = vi.fn<Ops["complete"]>().mockResolvedValue({ connected: true });
  runLoopback = vi.fn<Ops["runLoopback"]>().mockResolvedValue({ kind: "connected" });
  delegate = vi
    .fn<Ops["delegate"]>()
    .mockResolvedValue({ attemptId: "atp_1", desktopAvailable: true });
  configureFigmaConnect({ begin, complete, runLoopback, delegate });
});

afterEach(() => {
  configureFigmaConnect(null);
  resetFigmaConnect("srv");
  setFigmaConnectDraft("srv", { clientId: "", clientSecret: "" });
});

describe("connect store", () => {
  it("keeps the draft and clears errors when it changes", () => {
    setFigmaConnectDraft("srv", { clientId: "cid", clientSecret: "sec" });
    const state = getFigmaConnectState("srv");
    expect(state.clientId).toBe("cid");
    expect(state.phase.kind).toBe("idle");
  });

  it("notifies subscribers on change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFigmaConnect(listener);
    setFigmaConnectDraft("srv", { clientId: "cid" });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("rejects a browser sign-in without credentials", async () => {
    await startFigmaBrowserSignIn("srv");
    expect(getFigmaConnectState("srv").phase.kind).toBe("error");
    expect(begin).not.toHaveBeenCalled();
  });

  it("runs the desktop loopback and ends idle once connected", async () => {
    setFigmaConnectDraft("srv", { clientId: "cid", clientSecret: "sec" });
    await startFigmaBrowserSignIn("srv");
    expect(begin).toHaveBeenCalledWith({
      clientId: "cid",
      clientSecret: "sec",
      redirect: "loopback",
    });
    expect(runLoopback).toHaveBeenCalledWith(BEGUN);
    expect(getFigmaConnectState("srv").phase).toEqual({ kind: "idle" });
  });

  it("surfaces a loopback error", async () => {
    runLoopback.mockResolvedValue({ kind: "error", message: "Port 8766 is in use." });
    setFigmaConnectDraft("srv", { clientId: "cid", clientSecret: "sec" });
    await startFigmaBrowserSignIn("srv");
    expect(getFigmaConnectState("srv").phase).toEqual({
      kind: "error",
      message: "Port 8766 is in use.",
    });
  });

  it("waits for a pasted URL after a paste sign-in and completes with its code", async () => {
    setFigmaConnectDraft("srv", { clientId: "cid", clientSecret: "sec" });
    await startFigmaPasteSignIn("srv");
    expect(begin).toHaveBeenCalledWith({ clientId: "cid", clientSecret: "sec", redirect: "paste" });
    expect(getFigmaConnectState("srv").phase).toEqual({ kind: "browser-opened", ...BEGUN });
    await submitFigmaPastedUrl("srv", "http://127.0.0.1:8766/figma/callback?code=c&state=s");
    expect(complete).toHaveBeenCalledWith({ attemptId: "atp_1", code: "c", state: "s" });
  });

  it("rejects a pasted URL without code or state before calling the daemon", async () => {
    setFigmaConnectDraft("srv", { clientId: "cid", clientSecret: "sec" });
    await startFigmaPasteSignIn("srv");
    await submitFigmaPastedUrl("srv", "http://127.0.0.1:8766/figma/callback");
    expect(getFigmaConnectState("srv").phase.kind).toBe("error");
    expect(complete).not.toHaveBeenCalled();
  });

  it("reports a missing desktop for a delegated sign-in", async () => {
    setFigmaConnectDraft("srv", { clientId: "cid", clientSecret: "sec" });
    delegate.mockResolvedValue({ attemptId: null, desktopAvailable: false });
    await expect(requestFigmaDelegatedSignIn("srv")).resolves.toBe("no-desktop");
  });

  it("asks for credentials before delegating", async () => {
    await expect(requestFigmaDelegatedSignIn("srv")).resolves.toBe("missing");
    expect(delegate).not.toHaveBeenCalled();
  });
});
