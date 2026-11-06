import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginFigmaOAuthLoopback,
  canUseLoopback,
  completeFigmaOAuthPasted,
  finishWithLoopback,
  FIGMA_APPS_URL,
  FIGMA_CALLBACK_URL,
  FIGMA_OAUTH_SCOPES,
  type FigmaCompleteCall,
} from "./oauth-flow";

// The connect guide (spec 32.2) shows the user this scope list to tick in the Figma developer
// console, while the daemon composes the authorize URL from its own copy in
// packages/server/src/server/figma/oauth.ts. Both copies are pinned to the canonical list from
// the spec — same list here, same list in the server's oauth.test.ts — so guide and request
// cannot drift apart silently.

const SPEC_32_2_SCOPES = [
  "current_user:read",
  "file_content:read",
  "file_metadata:read",
  "file_versions:read",
  "file_comments:read",
  "file_comments:write",
  "library_content:read",
  "file_dev_resources:read",
  "projects:read",
];

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/constants/platform", () => ({
  isWeb: false,
  isNative: true,
  getIsElectron: () => false,
}));
vi.mock("@/desktop/electron/invoke", () => ({ invokeDesktopCommand: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
});

describe("connect guide constants", () => {
  it("lists exactly the scopes spec 32.2 requires — the same list the daemon requests", () => {
    expect(FIGMA_OAUTH_SCOPES).toEqual(SPEC_32_2_SCOPES);
    expect(FIGMA_OAUTH_SCOPES).not.toContain("file_variables:read");
  });

  it("shows the callback the daemon registers and the console the guide links to", () => {
    expect(FIGMA_CALLBACK_URL).toBe("http://127.0.0.1:8766/figma/callback");
    expect(FIGMA_APPS_URL).toBe("https://www.figma.com/developers/apps");
  });

  it("does not claim the loopback off Electron", () => {
    expect(canUseLoopback()).toBe(false);
  });
});

describe("sign-in completion paths", () => {
  function completeCall(connection: unknown | null): { fn: FigmaCompleteCall; calls: unknown[] } {
    const calls: unknown[] = [];
    const fn: FigmaCompleteCall = async (params) => {
      calls.push(params);
      return { connection };
    };
    return { fn, calls };
  }

  it("hands the loopback code to the daemon and reports connected", async () => {
    invokeMock.mockResolvedValue({ kind: "code", code: "c_1", state: "s_1" });
    const { fn, calls } = completeCall({ id: "fgc_1" });
    const outcome = await finishWithLoopback(fn, {
      attemptId: "atp_1",
      authorizeUrl: "https://www.figma.com/oauth?x=1",
      redirectUri: FIGMA_CALLBACK_URL,
    });
    expect(outcome).toEqual({ kind: "connected" });
    expect(calls).toEqual([{ attemptId: "atp_1", code: "c_1", state: "s_1" }]);
    expect(invokeMock).toHaveBeenCalledWith("figma_oauth_loopback", {
      authorizeUrl: "https://www.figma.com/oauth?x=1",
      redirectUri: FIGMA_CALLBACK_URL,
    });
  });

  it("surfaces a loopback error without calling complete", async () => {
    invokeMock.mockResolvedValue({ kind: "error", message: "Port 8766 is in use." });
    const { fn, calls } = completeCall({ id: "fgc_1" });
    const outcome = await finishWithLoopback(fn, {
      attemptId: "atp_1",
      authorizeUrl: "https://www.figma.com/oauth",
      redirectUri: FIGMA_CALLBACK_URL,
    });
    expect(outcome).toEqual({ kind: "error", message: "Port 8766 is in use." });
    expect(calls).toEqual([]);
  });

  it("completes a pasted URL with the code and state it carries", async () => {
    const { fn, calls } = completeCall({ id: "fgc_1" });
    const outcome = await completeFigmaOAuthPasted(
      fn,
      "atp_1",
      `${FIGMA_CALLBACK_URL}?code=c_9&state=s_9`,
    );
    expect(outcome).toEqual({ kind: "connected" });
    expect(calls).toEqual([{ attemptId: "atp_1", code: "c_9", state: "s_9" }]);
  });

  it("rejects a pasted URL without code and state before calling the daemon", async () => {
    const { fn, calls } = completeCall(null);
    const outcome = await completeFigmaOAuthPasted(
      fn,
      "atp_1",
      "http://127.0.0.1:8766/figma/callback",
    );
    expect(outcome.kind).toBe("error");
    expect(calls).toEqual([]);
  });

  it("reports a null connection from the daemon as an error", async () => {
    const { fn } = completeCall(null);
    const outcome = await completeFigmaOAuthPasted(
      fn,
      "atp_1",
      `${FIGMA_CALLBACK_URL}?code=c&state=s`,
    );
    expect(outcome).toEqual({ kind: "error", message: "Figma rejected the sign-in." });
  });

  it("beginFigmaOAuthLoopback goes through the desktop invoke channel", async () => {
    invokeMock.mockResolvedValue({ kind: "error", message: "nope" });
    const result = await beginFigmaOAuthLoopback({
      authorizeUrl: "https://www.figma.com/oauth",
      redirectUri: FIGMA_CALLBACK_URL,
    });
    expect(result).toEqual({ kind: "error", message: "nope" });
    expect(invokeMock).toHaveBeenCalledWith("figma_oauth_loopback", {
      authorizeUrl: "https://www.figma.com/oauth",
      redirectUri: FIGMA_CALLBACK_URL,
    });
  });
});
