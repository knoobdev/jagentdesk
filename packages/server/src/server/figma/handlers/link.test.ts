import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FigmaLinkStatus } from "@jagentdesk/protocol/figma/rpc-schemas";
import pino from "pino";
import type { FigmaContext, FigmaLinkBridge } from "../context.js";
import { FigmaServiceError } from "../context.js";
import { linkHandlers } from "./link.js";
import { describe, expect, it } from "vitest";

// The handlers are the thin RPC surface over the bridge contract (32.4). These
// tests use a scripted fake bridge — they assert the wire shape and the code
// the session turns into a `figma.error`.

function stoppedStatus(): FigmaLinkStatus {
  return {
    server: "listening",
    port: 1995,
    pluginInstalled: false,
    pluginVersion: null,
    manifestPath: null,
    runScriptEnabled: false,
    files: [],
    pendingPairing: null,
  };
}

function makeContext(link: Partial<FigmaLinkBridge>): FigmaContext {
  const fullLink: FigmaLinkBridge = {
    status: () => stoppedStatus(),
    isLinked: () => true,
    pair: async () => stoppedStatus(),
    revoke: async () => undefined,
    setRunScriptEnabled: async () => stoppedStatus(),
    callTool: async () => undefined,
    applyOps: async () => ({ createdIds: {}, results: [] }),
    getNodes: async () => ({}),
    exportNode: async () => ({ mimeType: "image/png", data: Buffer.alloc(0) }),
    onChange: () => () => undefined,
    close: async () => undefined,
    ...link,
  };
  return {
    jagentdeskHome: mkdtempSync(path.join(tmpdir(), "jad-figma-")),
    logger: pino({ level: "silent" }),
    now: () => 0,
    push: () => undefined,
    link: fullLink,
  } as unknown as FigmaContext;
}

const session = { sessionKey: "s", canRunLoopback: false };

describe("link handlers", () => {
  it("returns the bridge status verbatim", async () => {
    const status = stoppedStatus();
    const ctx = makeContext({ status: () => status });
    const response = await linkHandlers["figma.link.status.request"](
      { type: "figma.link.status.request", requestId: "r1" },
      ctx,
      session,
    );
    expect(response).toEqual({ status });
  });

  it("pairs and returns the post-pairing status", async () => {
    const paired: FigmaLinkStatus = {
      ...stoppedStatus(),
      files: [
        {
          fileKey: "fk-1",
          fileName: "Design file",
          pageName: null,
          paired: true,
          pluginVersion: "1.0.0",
          connectedAt_ms: 0,
        },
      ],
    };
    const link: Partial<FigmaLinkBridge> = {
      pair: async (code) => {
        if (code !== "123456") throw new FigmaServiceError("pairing_required", "expired");
        return paired;
      },
    };
    const response = await linkHandlers["figma.link.pair.request"](
      { type: "figma.link.pair.request", requestId: "r2", code: "123456" },
      makeContext(link),
      session,
    );
    expect(response).toEqual({ status: paired });
    await expect(
      linkHandlers["figma.link.pair.request"](
        { type: "figma.link.pair.request", requestId: "r3", code: "000000" },
        makeContext(link),
        session,
      ),
    ).rejects.toMatchObject({ code: "pairing_required" });
  });

  it("revokes a single pairing or every pairing", async () => {
    const revoked: string[] = [];
    const ctx = makeContext({
      revoke: async (pairingId) => {
        revoked.push(pairingId ?? "*");
      },
    });
    await linkHandlers["figma.link.revoke.request"](
      { type: "figma.link.revoke.request", requestId: "r4", pairingId: "p-1" },
      ctx,
      session,
    );
    await linkHandlers["figma.link.revoke.request"](
      { type: "figma.link.revoke.request", requestId: "r5" },
      ctx,
      session,
    );
    expect(revoked).toEqual(["p-1", "*"]);
  });

  it("persists the run_script setting and answers with the new status", async () => {
    let enabled = false;
    const link: Partial<FigmaLinkBridge> = {
      setRunScriptEnabled: async (value) => {
        enabled = value;
        return { ...stoppedStatus(), runScriptEnabled: value };
      },
    };
    const response = await linkHandlers["figma.link.settings.request"](
      { type: "figma.link.settings.request", requestId: "r6", runScriptEnabled: true },
      makeContext(link),
      session,
    );
    expect(response).toEqual({ status: expect.objectContaining({ runScriptEnabled: true }) });
    expect(enabled).toBe(true);
  });

  it("fails op requests with link_unavailable when no plugin is connected", async () => {
    const ctx = makeContext({
      isLinked: () => false,
      applyOps: async () => {
        throw new Error("must not run");
      },
    });
    await expect(
      linkHandlers["figma.link.op.request"](
        {
          type: "figma.link.op.request",
          requestId: "r7",
          fileKey: "fk-1",
          ops: [{ op: "delete", nodeId: "1:2" }],
        },
        ctx,
        session,
      ),
    ).rejects.toMatchObject({ code: "link_unavailable" });
  });

  it("maps op requests onto the bridge and returns createdIds plus per-op results", async () => {
    const ctx = makeContext({
      isLinked: () => true,
      applyOps: async (fileKey, ops) => {
        expect(fileKey).toBe("fk-1");
        expect(ops).toHaveLength(1);
        return { createdIds: { t1: "1:9" }, results: [{ ok: true }] };
      },
    });
    const response = await linkHandlers["figma.link.op.request"](
      {
        type: "figma.link.op.request",
        requestId: "r8",
        fileKey: "fk-1",
        ops: [{ op: "duplicate", nodeId: "1:2", tempId: "t1" }],
      },
      ctx,
      session,
    );
    expect(response).toEqual({ createdIds: { t1: "1:9" }, results: [{ ok: true }] });
  });
});
