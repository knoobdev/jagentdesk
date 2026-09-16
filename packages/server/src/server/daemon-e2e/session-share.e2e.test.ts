import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import pino from "pino";
import type { SessionShare } from "@jagentdesk/protocol/messages";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

// Real-daemon E2E for session sharing (spec §21 / ADR-0018): boots an actual daemon with the
// feature enabled and drives the host RPC surface through a real paired DaemonClient over a real
// WebSocket — exercising session.ts dispatch → SessionShareSession → SessionShareService,
// operation-permissions, capability gating, and a real cloudflared quick tunnel. The guest-side
// protocol (pairing, transcript, presence, model/mode gating) is covered by the ShareServer unit
// path; here we prove the daemon wiring + tunnel + option toggles + capability gate.
//
// Requires `cloudflared` on PATH (skipped gracefully otherwise).

const CODEX_MODEL = "gpt-5.4-mini";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function findPendingFrom(list: SessionShare[], label: string): SessionShare | undefined {
  return list.find((s) =>
    s.pendingRequests.some((r) => r.status === "pending" && r.label === label),
  );
}

async function makeAgent(ctx: DaemonTestContext): Promise<string> {
  const agent = await ctx.client.createAgent({
    provider: "codex",
    model: CODEX_MODEL,
    cwd: "/tmp",
    title: "Share E2E Agent",
  });
  return agent.id;
}

async function makeAgentWithCwd(ctx: DaemonTestContext, cwd: string): Promise<string> {
  const agent = await ctx.client.createAgent({
    provider: "codex",
    model: CODEX_MODEL,
    cwd,
    title: "Share Files Agent",
  });
  return agent.id;
}

// Pair a guest over the bespoke /guest channel and return a scoped-/ws DaemonClient (ADR-0019).
async function pairGuestClient(
  ctx: DaemonTestContext,
  sharePort: number,
  shareId: string,
  streamed: SessionShare[],
  label: string,
  capabilities?: Record<string, unknown>,
): Promise<DaemonClient> {
  const guestWs = new WebSocket(`ws://127.0.0.1:${sharePort}/guest`);
  const msgs: Record<string, unknown>[] = [];
  guestWs.on("message", (d) => {
    try {
      msgs.push(JSON.parse(d.toString()));
    } catch {
      /* ignore */
    }
  });
  await new Promise<void>((res, rej) => {
    guestWs.on("open", () => res());
    guestWs.on("error", rej);
  });
  guestWs.send(JSON.stringify({ t: "request", name: label }));
  let req: SessionShare["pendingRequests"][number] | undefined;
  for (let i = 0; i < 40 && !req; i++) {
    req = findPendingFrom(streamed, label)?.pendingRequests.find((r) => r.status === "pending");
    if (!req) await sleep(150);
  }
  if (!req) throw new Error("host never saw the join request");
  await ctx.client.sessionShareRespond(shareId, req.requestId, true);
  let code: string | undefined;
  for (let i = 0; i < 40 && !code; i++) {
    code = streamed[streamed.length - 1]?.pendingRequests.find(
      (r) => r.requestId === req!.requestId,
    )?.code;
    if (!code) await sleep(150);
  }
  guestWs.send(JSON.stringify({ t: "pair", code }));
  let guestToken: string | undefined;
  for (let i = 0; i < 40 && !guestToken; i++) {
    guestToken = msgs.find((m) => m.t === "pair_result" && m.ok === true)?.guestToken as
      | string
      | undefined;
    if (!guestToken) await sleep(100);
  }
  if (!guestToken) throw new Error("pairing did not return a guest token");
  const guest = new DaemonClient({
    url: `ws://127.0.0.1:${sharePort}/ws`,
    clientId: `guest-files-${label}`,
    password: guestToken,
    ...(capabilities ? { capabilities } : {}),
  });
  await guest.connect();
  guestWs.close();
  return guest;
}

describe("session sharing — real daemon", () => {
  let ctx: DaemonTestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  }, 30000);

  test("host RPCs: create → set_options → list → stop through a real tunnel", async () => {
    ctx = await createDaemonTestContext({ sessionSharingEnabled: true });
    const agentId = await makeAgent(ctx);

    // create → real cloudflared tunnel; safe defaults.
    const share = await ctx.client.sessionShareCreate(agentId);
    expect(share.shareId).toBeTruthy();
    expect(share.agentId).toBe(agentId);
    expect(share.status).toBe("active");
    expect(share.tunnelUrl).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
    expect(share.allowGuestModelMode).toBe(false);
    expect(share.requireHostApproval).toBe(true);
    expect(share.members).toEqual([]);
    expect(share.pendingRequests).toEqual([]);

    // list reflects it.
    const list = await ctx.client.sessionShareList();
    expect(list.some((s) => s.shareId === share.shareId)).toBe(true);

    // set_options grants the model/mode right live.
    const granted = await ctx.client.sessionShareSetOptions(share.shareId, {
      allowGuestModelMode: true,
    });
    expect(granted.allowGuestModelMode).toBe(true);

    // kick with no members is a safe no-op that returns the share.
    const afterKick = await ctx.client.sessionShareKick(share.shareId, "nobody");
    expect(afterKick.shareId).toBe(share.shareId);

    // stop → revoked + tunnel torn down.
    const stopped = await ctx.client.sessionShareStop(share.shareId);
    expect(stopped.status).toBe("revoked");
    expect(stopped.tunnelUrl).toBeNull();

    const afterStop = await ctx.client.sessionShareList();
    expect(afterStop.some((s) => s.shareId === share.shareId)).toBe(false);
  }, 90000);

  test("guest join reaches the host: request → session.share.stream with a pending request", async () => {
    // Capture the loopback ShareServer port from the daemon's own logs so we can connect a
    // guest WS directly (the public tunnel URL is unreachable from CI/localhost networks).
    let sharePort = 0;
    const logger = pino(
      { level: "info" },
      {
        write: (line: string) => {
          try {
            const o = JSON.parse(line);
            if (o.msg === "Share server listening" && typeof o.port === "number")
              sharePort = o.port;
          } catch {
            /* ignore non-JSON */
          }
        },
      },
    );

    ctx = await createDaemonTestContext({ sessionSharingEnabled: true, logger });
    const agentId = await makeAgent(ctx);

    // Host subscribes to the stream, exactly like the composer Share control does.
    const streamed: SessionShare[] = [];
    const unsub = ctx.client.subscribeSessionShareStream((s) => {
      if (s.agentId === agentId) streamed.push(s);
    });

    const share = await ctx.client.sessionShareCreate(agentId);
    expect(sharePort).toBeGreaterThan(0);

    // A real guest opens the WS and asks to join.
    const guest = new WebSocket(`ws://127.0.0.1:${sharePort}/guest`);
    await new Promise<void>((res, rej) => {
      guest.on("open", () => res());
      guest.on("error", rej);
    });
    guest.send(JSON.stringify({ t: "request", name: "Remote Guest" }));

    // The host must receive a session.share.stream carrying a PENDING join request — this is
    // what pops the auto Accept/Reject dialog in the app.
    const deadline = Date.now() + 8000;
    let pendingSeen: SessionShare | undefined;
    while (Date.now() < deadline) {
      pendingSeen = findPendingFrom(streamed, "Remote Guest");
      if (pendingSeen) break;
      await sleep(150);
    }
    expect(pendingSeen, "host received a pending join request via stream").toBeTruthy();

    // Host accepts → daemon mints the code and the stream now shows it approved with a code.
    const req = pendingSeen!.pendingRequests.find((r) => r.status === "pending")!;
    await ctx.client.sessionShareRespond(share.shareId, req.requestId, true);

    const deadline2 = Date.now() + 8000;
    let approved;
    while (Date.now() < deadline2) {
      const s = streamed[streamed.length - 1];
      approved = s?.pendingRequests.find(
        (r) => r.requestId === req.requestId && r.status === "approved",
      );
      if (approved?.code) break;
      await sleep(150);
    }
    expect(approved?.code, "approved request carries a 6-digit code").toMatch(/^\d{6}$/);

    unsub();
    guest.close();
    await ctx.client.sessionShareStop(share.shareId);
  }, 90000);

  test("capability gate: features.sessionSharing advertised only when enabled", async () => {
    // Enabled → advertised, so the app shows the Share button.
    ctx = await createDaemonTestContext({ sessionSharingEnabled: true });
    expect(ctx.client.getLastServerInfoMessage()?.features?.sessionSharing).toBe(true);
    await ctx.cleanup();

    // Disabled (default) → not advertised, so the app hides the Share button entirely and
    // never sends session.share.* (spec §21.11: no back-door when the gate is off).
    ctx = await createDaemonTestContext({ sessionSharingEnabled: false });
    expect(ctx.client.getLastServerInfoMessage()?.features?.sessionSharing).toBeFalsy();
  }, 30000);

  test("guest scoped real-protocol session: token → /ws → confined to the shared agent (ADR-0019)", async () => {
    let sharePort = 0;
    const logger = pino(
      { level: "info" },
      {
        write: (line: string) => {
          try {
            const o = JSON.parse(line);
            if (o.msg === "Share server listening" && typeof o.port === "number")
              sharePort = o.port;
          } catch {
            /* ignore */
          }
        },
      },
    );
    ctx = await createDaemonTestContext({ sessionSharingEnabled: true, logger });
    const agentId = await makeAgent(ctx);
    const otherAgentId = await makeAgent(ctx);

    const streamed: SessionShare[] = [];
    const unsub = ctx.client.subscribeSessionShareStream((s) => {
      if (s.agentId === agentId) streamed.push(s);
    });
    const share = await ctx.client.sessionShareCreate(agentId);
    expect(sharePort).toBeGreaterThan(0);

    // Pair over the bespoke /guest channel to obtain a guest token.
    const guestWs = new WebSocket(`ws://127.0.0.1:${sharePort}/guest`);
    const msgs: Record<string, unknown>[] = [];
    guestWs.on("message", (d) => {
      try {
        msgs.push(JSON.parse(d.toString()));
      } catch {
        /* ignore */
      }
    });
    await new Promise<void>((res, rej) => {
      guestWs.on("open", () => res());
      guestWs.on("error", rej);
    });
    guestWs.send(JSON.stringify({ t: "request", name: "Scoped Guest" }));
    // Host accepts → code appears in the stream.
    let req;
    for (let i = 0; i < 40 && !req; i++) {
      req = findPendingFrom(streamed, "Scoped Guest")?.pendingRequests.find(
        (r) => r.status === "pending",
      );
      if (!req) await sleep(150);
    }
    expect(req).toBeTruthy();
    await ctx.client.sessionShareRespond(share.shareId, req!.requestId, true);
    let code: string | undefined;
    for (let i = 0; i < 40 && !code; i++) {
      code = streamed[streamed.length - 1]?.pendingRequests.find(
        (r) => r.requestId === req!.requestId,
      )?.code;
      if (!code) await sleep(150);
    }
    expect(code).toMatch(/^\d{6}$/);
    guestWs.send(JSON.stringify({ t: "pair", code }));
    let guestToken: string | undefined;
    for (let i = 0; i < 40 && !guestToken; i++) {
      const pr = msgs.find((m) => m.t === "pair_result" && m.ok === true);
      guestToken = pr?.guestToken as string | undefined;
      if (!guestToken) await sleep(100);
    }
    expect(guestToken, "pairing returns a guest token").toBeTruthy();

    // Connect a REAL DaemonClient to the scoped /ws using the guest token as the bearer.
    const guest = new DaemonClient({
      url: `ws://127.0.0.1:${sharePort}/ws`,
      clientId: "guest-e2e",
      password: guestToken,
    });
    await guest.connect();

    // Allowed: read the shared agent's timeline.
    const tl = await guest.fetchAgentTimeline(agentId, { direction: "tail", limit: 5 });
    expect(tl).toBeTruthy();

    // Denied: a DIFFERENT agent (per-agent guest guard).
    await expect(
      guest.fetchAgentTimeline(otherAgentId, { direction: "tail", limit: 5 }),
    ).rejects.toThrow();

    // fetch_agents is allowed but FILTERED to the shared agent only (no cross-agent leak).
    const dir = await guest.fetchAgents({});
    const ids = (dir.entries ?? []).map((e) => e.agent.id);
    expect(ids).toContain(agentId);
    expect(ids).not.toContain(otherAgentId);

    unsub();
    await guest.close();
    guestWs.close();
    await ctx.client.sessionShareStop(share.shareId);
  }, 90000);

  test("guest files capability: reads inside the shared workspace, DENIED outside / on traversal (ADR-0019)", async () => {
    let sharePort = 0;
    const logger = pino(
      { level: "info" },
      {
        write: (line: string) => {
          try {
            const o = JSON.parse(line);
            if (o.msg === "Share server listening" && typeof o.port === "number")
              sharePort = o.port;
          } catch {
            /* ignore */
          }
        },
      },
    );
    ctx = await createDaemonTestContext({ sessionSharingEnabled: true, logger });

    // A real workspace with a marker file the guest is allowed to see.
    const workspace = await mkdtemp(path.join(tmpdir(), "jad-share-ws-"));
    await writeFile(path.join(workspace, "READY.md"), "# guest can read me\n");
    const agentId = await makeAgentWithCwd(ctx, workspace);

    const streamed: SessionShare[] = [];
    const unsub = ctx.client.subscribeSessionShareStream((s) => {
      if (s.agentId === agentId) streamed.push(s);
    });
    // Share WITH the files capability granted.
    const share = await ctx.client.sessionShareCreate(agentId, { capabilities: { files: true } });
    expect(share.capabilities.files).toBe(true);
    expect(sharePort).toBeGreaterThan(0);

    const guest = await pairGuestClient(ctx, sharePort, share.shareId, streamed, "Files Guest");

    // Allowed: list the shared workspace root — the marker file is visible.
    const dir = await guest.listDirectory(workspace, ".");
    const names = (dir.entries ?? []).map((e) => e.name);
    expect(names).toContain("READY.md");

    // Denied: a cwd OUTSIDE the shared workspace (arbitrary host path).
    await expect(guest.listDirectory("/etc", ".")).rejects.toThrow();

    // Denied: `..` traversal that resolves out of the workspace root.
    await expect(guest.listDirectory(workspace, "../../../../etc")).rejects.toThrow();

    unsub();
    await guest.close();
    await ctx.client.sessionShareStop(share.shareId);
  }, 90000);

  test("host sees guest activity: a guest's message lands in the share's recentActivity (ADR-0019)", async () => {
    let sharePort = 0;
    const logger = pino(
      { level: "info" },
      {
        write: (line: string) => {
          try {
            const o = JSON.parse(line);
            if (o.msg === "Share server listening" && typeof o.port === "number")
              sharePort = o.port;
          } catch {
            /* ignore */
          }
        },
      },
    );
    ctx = await createDaemonTestContext({ sessionSharingEnabled: true, logger });
    const agentId = await makeAgent(ctx);

    const streamed: SessionShare[] = [];
    const unsub = ctx.client.subscribeSessionShareStream((s) => {
      if (s.agentId === agentId) streamed.push(s);
    });
    const share = await ctx.client.sessionShareCreate(agentId);
    const guest = await pairGuestClient(ctx, sharePort, share.shareId, streamed, "Active Guest");

    // The guest sends a message over the scoped /ws (real protocol, not the bespoke channel).
    await guest.sendMessage(agentId, "hello from the guest activity test");

    // The host's share stream must surface it in recentActivity, attributed to the guest member.
    let activity: SessionShare["recentActivity"][number] | undefined;
    for (let i = 0; i < 50 && !activity; i++) {
      activity = streamed
        .flatMap((s) => s.recentActivity ?? [])
        .find((a) => a.text.includes("hello from the guest activity test"));
      if (!activity) await sleep(150);
    }
    expect(activity, "guest message surfaced in host recentActivity").toBeTruthy();
    expect(activity!.label).toBe("Active Guest");

    unsub();
    await guest.close();
    await ctx.client.sessionShareStop(share.shareId);
  }, 90000);

  test("read-only share: guest can view the timeline but CANNOT send (ADR-0019)", async () => {
    let sharePort = 0;
    const logger = pino(
      { level: "info" },
      {
        write: (line: string) => {
          try {
            const o = JSON.parse(line);
            if (o.msg === "Share server listening" && typeof o.port === "number")
              sharePort = o.port;
          } catch {
            /* ignore */
          }
        },
      },
    );
    ctx = await createDaemonTestContext({ sessionSharingEnabled: true, logger });
    const agentId = await makeAgent(ctx);

    const streamed: SessionShare[] = [];
    const unsub = ctx.client.subscribeSessionShareStream((s) => {
      if (s.agentId === agentId) streamed.push(s);
    });
    const share = await ctx.client.sessionShareCreate(agentId, {
      capabilities: { readOnly: true },
    });
    expect(share.capabilities.readOnly).toBe(true);
    const guest = await pairGuestClient(ctx, sharePort, share.shareId, streamed, "ReadOnly Guest");

    // Allowed: view the timeline.
    const tl = await guest.fetchAgentTimeline(agentId, { direction: "tail", limit: 5 });
    expect(tl).toBeTruthy();

    // Denied: sending is not in the read-only guest scope.
    await expect(guest.sendMessage(agentId, "should be rejected")).rejects.toThrow();

    unsub();
    await guest.close();
    await ctx.client.sessionShareStop(share.shareId);
  }, 90000);

  test("guest terminal capability: read-only, confined to the shared workspace (ADR-0019)", async () => {
    let sharePort = 0;
    const logger = pino(
      { level: "info" },
      {
        write: (line: string) => {
          try {
            const o = JSON.parse(line);
            if (o.msg === "Share server listening" && typeof o.port === "number")
              sharePort = o.port;
          } catch {
            /* ignore */
          }
        },
      },
    );
    ctx = await createDaemonTestContext({ sessionSharingEnabled: true, logger });

    const workspace = await mkdtemp(path.join(tmpdir(), "jad-share-term-"));
    const agentId = await makeAgentWithCwd(ctx, workspace);

    // The host opens a terminal in the shared workspace.
    const created = await ctx.client.createTerminal(workspace);
    const terminalId = created.terminal?.id ?? "";
    expect(terminalId).toBeTruthy();

    const streamed: SessionShare[] = [];
    const unsub = ctx.client.subscribeSessionShareStream((s) => {
      if (s.agentId === agentId) streamed.push(s);
    });
    const share = await ctx.client.sessionShareCreate(agentId, {
      capabilities: { terminal: true },
    });
    expect(share.capabilities.terminal).toBe(true);
    expect(sharePort).toBeGreaterThan(0);

    const guest = await pairGuestClient(ctx, sharePort, share.shareId, streamed, "Terminal Guest");

    // Allowed: list the shared workspace's terminals — the host's terminal is visible.
    const list = await guest.listTerminals(workspace);
    expect(list.terminals.some((tItem) => tItem.id === terminalId)).toBe(true);

    // Allowed: subscribe to that terminal (read-only view of its output).
    const sub = await guest.subscribeTerminal(terminalId);
    expect(sub.error).toBeNull();

    // Denied: listing terminals for a cwd OUTSIDE the shared workspace.
    await expect(guest.listTerminals("/etc")).rejects.toThrow();

    // Denied: subscribing to an unknown terminal id (cannot be resolved into the workspace).
    await expect(guest.subscribeTerminal("term_does_not_exist")).rejects.toThrow();

    // Denied (read-only): spawning a terminal is a WRITE the guest scope never grants.
    await expect(guest.createTerminal(workspace)).rejects.toThrow();

    unsub();
    await guest.close();
    await ctx.client.sessionShareStop(share.shareId);
  }, 90000);
});
