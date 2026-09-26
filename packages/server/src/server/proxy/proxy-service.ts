import { randomUUID } from "node:crypto";
import { randomUUID as uuid } from "node:crypto";
import type {
  ProxyCaptureMode,
  ProxyCaptureSession,
  ProxyHeader,
  ProxyHeldRequest,
  ProxyWsMessage,
  ProxyIntruderResult,
  ProxyScopeRule,
  ProxyTransactionFull,
  ProxyTransactionRow,
} from "@jagentdesk/protocol/proxy/rpc-schemas";
import { WorkbenchCA } from "./ca.js";
import { CaptureStore, toFull, toRow, type HistoryQuery } from "./capture-store.js";
import { MitmProxy, type InterceptInput, type InterceptOutcome } from "./mitm-proxy.js";
import { executeRequest, type ExecuteRequestInput } from "./http-exec.js";
import { fridaAvailability, launchAndUnpin, type UnpinHandle } from "./frida-control.js";
import { execCommand } from "../../utils/spawn.js";
import {
  enableSystemProxy,
  primaryNetworkService,
  restoreSystemProxy,
  snapshotSystemProxy,
  type SystemProxyState,
} from "./system-proxy.js";

// The daemon-side control plane for the Workbench: owns the CA and the capture store, starts/stops
// MITM listeners (one per capture session), and fans completed transactions + session-state changes
// out to subscribers (the live UI stream and, later, the agent tools). One instance per session,
// mirroring SimulatorService/SimulatorStreams. P1 = manual/system capture; Frida attribution to a
// specific simulator arrives in a later phase.

interface SessionEntry {
  meta: ProxyCaptureSession;
  proxy: MitmProxy;
  unpin?: UnpinHandle;
  systemProxy?: SystemProxyState;
}

// Trust the Workbench CA on a booted simulator so its HTTPS is inspectable (Xcode 12.5+).
export async function installCaToSimulator(udid: string, caPath: string): Promise<void> {
  await execCommand("xcrun", ["simctl", "keychain", udid, "add-root-cert", caPath], {
    timeout: 30_000,
  });
}

interface Subscriber {
  onTransaction: (row: ProxyTransactionRow) => void;
  onSession: (session: ProxyCaptureSession) => void;
  onHeld: (held: ProxyHeldRequest) => void;
  onWsMessage: (message: ProxyWsMessage) => void;
}

interface HeldEntry {
  input: InterceptInput;
  sessionId: string;
  resolve: (outcome: InterceptOutcome) => void;
}

export interface CaptureStartInput {
  mode: ProxyCaptureMode;
  label?: string;
  udid?: string | null;
  bundleId?: string | null;
}

export class ProxyService {
  private readonly ca: WorkbenchCA;
  private readonly store = new CaptureStore();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly subscribers = new Map<string, Subscriber>();
  private scopeRules: ProxyScopeRule[] = [];
  private interceptEnabled = false;
  private readonly held = new Map<string, HeldEntry>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.ca = new WorkbenchCA(env);
  }

  // Burp Intercept. When on, each request is held until the tester forwards (optionally edited) or
  // drops it. Turning intercept off forwards everything currently held, unchanged.
  setIntercept(enabled: boolean): boolean {
    this.interceptEnabled = enabled;
    if (!enabled) {
      for (const [heldId, entry] of this.held) {
        entry.resolve({ ...entry.input, drop: false });
        this.held.delete(heldId);
      }
    }
    return this.interceptEnabled;
  }

  decideIntercept(input: {
    heldId: string;
    action: "forward" | "drop";
    method?: string;
    path?: string;
    headers?: ProxyHeader[];
    bodyB64?: string;
  }): void {
    const entry = this.held.get(input.heldId);
    if (!entry) return;
    this.held.delete(input.heldId);
    if (input.action === "drop") {
      entry.resolve({ ...entry.input, drop: true });
      return;
    }
    entry.resolve({
      drop: false,
      method: input.method ?? entry.input.method,
      path: input.path ?? entry.input.path,
      headers: input.headers ?? entry.input.headers,
      body: input.bodyB64 != null ? Buffer.from(input.bodyB64, "base64") : entry.input.body,
    });
  }

  // The hook handed to each MitmProxy. Passes traffic straight through unless intercept is on, in
  // which case it queues the request and pushes it to subscribers, resolving when a decision lands.
  private interceptHook(sessionId: string, input: InterceptInput): Promise<InterceptOutcome> {
    if (!this.interceptEnabled) return Promise.resolve({ ...input, drop: false });
    const heldId = `held_${uuid().slice(0, 8)}`;
    const meta = this.sessions.get(sessionId)?.meta;
    const held: ProxyHeldRequest = {
      heldId,
      sessionId,
      secure: input.secure,
      host: input.host,
      port: input.port,
      method: input.method,
      path: input.path,
      headers: input.headers,
      bodyB64: input.body.toString("base64"),
      udid: meta?.udid ?? null,
      bundleId: meta?.bundleId ?? null,
    };
    return new Promise<InterceptOutcome>((resolve) => {
      this.held.set(heldId, { input, sessionId, resolve });
      for (const sub of this.subscribers.values()) sub.onHeld(held);
    });
  }

  async repeaterSend(input: ExecuteRequestInput): Promise<ProxyTransactionFull> {
    const tx = await executeRequest(input);
    return toFull(tx);
  }

  // Burp Intruder — Sniper over a single payload set. Community Edition throttles each request and
  // caps the payload count; we mirror that (a 150ms delay, 200-payload cap) so behaviour matches CE.
  async intruderRun(input: {
    secure: boolean;
    host: string;
    port: number;
    template: string;
    payloads: string[];
  }): Promise<{ results: ProxyIntruderResult[]; throttled: boolean; truncated: boolean }> {
    const CE_CAP = 200;
    const CE_DELAY_MS = 150;
    const truncated = input.payloads.length > CE_CAP;
    const payloads = input.payloads.slice(0, CE_CAP);
    const results: ProxyIntruderResult[] = [];
    for (let i = 0; i < payloads.length; i++) {
      const payload = payloads[i]!;
      const substituted = input.template.replace(/§[^§]*§/g, payload);
      const parsed = parseRawRequest(substituted);
      const tx = await executeRequest({
        secure: input.secure,
        host: input.host,
        port: input.port,
        method: parsed.method,
        path: parsed.path,
        headers: parsed.headers,
        body: Buffer.from(parsed.body, "utf8"),
      });
      results.push({
        index: i,
        payload,
        status: tx.status,
        length: tx.responseBody.length,
        durationMs: tx.durationMs ?? 0,
        error: tx.status == null ? tx.responseBody.toString("utf8").slice(0, 200) : null,
      });
      if (i < payloads.length - 1) await delay(CE_DELAY_MS);
    }
    return { results, throttled: true, truncated };
  }

  getScope(): ProxyScopeRule[] {
    return this.scopeRules;
  }

  setScope(rules: ProxyScopeRule[]): ProxyScopeRule[] {
    this.scopeRules = rules;
    return this.scopeRules;
  }

  async captureStart(input: CaptureStartInput): Promise<ProxyCaptureSession> {
    const id = `wbcap_${randomUUID().slice(0, 8)}`;
    const meta: ProxyCaptureSession = {
      id,
      label: input.label?.trim() || defaultLabel(input),
      mode: input.mode,
      state: "starting",
      listenerHost: "127.0.0.1",
      listenerPort: 0,
      udid: input.udid ?? null,
      bundleId: input.bundleId ?? null,
      startedAt_ms: Date.now(),
      stoppedAt_ms: null,
      transactionCount: 0,
      error: null,
    };
    const proxy = new MitmProxy({
      ca: this.ca,
      sessionId: id,
      store: this.store,
      udid: meta.udid,
      bundleId: meta.bundleId,
      onTransaction: (tx) => {
        const entry = this.sessions.get(id);
        if (entry) entry.meta.transactionCount += 1;
        this.broadcastTransaction(toRow(tx));
      },
      intercept: (input) => this.interceptHook(id, input),
      onWsMessage: (msg) => {
        const wsMsg: ProxyWsMessage = {
          id: `ws_${uuid().slice(0, 8)}`,
          sessionId: id,
          ts_ms: Date.now(),
          host: msg.host,
          direction: msg.direction,
          opcode: msg.opcode,
          length: msg.payload.length,
          preview:
            msg.opcode === 1
              ? msg.payload.toString("utf8").slice(0, 2000)
              : `[${msg.payload.length} bytes binary]`,
        };
        for (const sub of this.subscribers.values()) sub.onWsMessage(wsMsg);
      },
    });
    const entry: SessionEntry = { meta, proxy };
    this.sessions.set(id, entry);
    try {
      const port = await proxy.start();
      meta.listenerPort = port;
      meta.state = "running";
    } catch (err) {
      meta.state = "error";
      meta.error = (err as Error).message;
    }
    // Frida mode: trust the CA on the simulator and inject the app to bypass TLS pinning. Failures
    // here are non-fatal — the listener still runs; the error is surfaced on the session.
    if (meta.state === "running" && input.mode === "frida" && input.udid && input.bundleId) {
      await this.setupFridaCapture(entry, input.udid, input.bundleId);
    }
    // System mode: route the whole machine's HTTP+HTTPS through the listener (the reliable way to
    // capture iOS Simulator traffic, since simulators honor the Mac system proxy — their per-app
    // proxy config is ignored). HTTPS is decrypted for the simulator because its trust store has the
    // CA (installed per udid); trust the CA on the given simulator too when one is targeted.
    if (meta.state === "running" && input.mode === "system") {
      await this.setupSystemCapture(entry, input.udid ?? null, meta.listenerPort);
    }
    this.broadcastSession(meta);
    return meta;
  }

  private async setupSystemCapture(
    entry: SessionEntry,
    udid: string | null,
    port: number,
  ): Promise<void> {
    if (udid) await installCaToSimulator(udid, this.ca.certFilePath()).catch(() => {});
    const service = await primaryNetworkService();
    if (!service) {
      entry.meta.error = "could not find an active network service to set the system proxy on.";
      return;
    }
    try {
      entry.systemProxy = await snapshotSystemProxy(service);
      await enableSystemProxy(service, "127.0.0.1", port, { https: true });
    } catch (err) {
      entry.meta.error = `could not set the system proxy: ${(err as Error).message}`;
    }
  }

  // Trust the CA on the sim and open the app. If Frida is present we also inject the generic unpin;
  // if not, capture still runs (CA-trusted TLS is inspectable for apps that do NOT pin), and the
  // session carries a note telling the user how to enable pinning bypass — never a hard failure.
  private async setupFridaCapture(
    entry: SessionEntry,
    udid: string,
    bundleId: string,
  ): Promise<void> {
    try {
      await installCaToSimulator(udid, this.ca.certFilePath());
    } catch (err) {
      entry.meta.error = `could not trust CA on the simulator: ${(err as Error).message}`;
      return;
    }
    const avail = await fridaAvailability();
    if (!avail.frida) {
      // No Frida: still launch the app so its traffic flows through the trusted-CA capture.
      await execCommand("xcrun", ["simctl", "launch", udid, bundleId], { timeout: 60_000 }).catch(
        () => {},
      );
      entry.meta.error = avail.installer
        ? "Capturing without pinning bypass — Frida is not installed. Install it (one click) to unpin apps that pin."
        : "Capturing without pinning bypass — Frida not found and no Python installer to auto-install it.";
      return;
    }
    try {
      entry.unpin = await launchAndUnpin({ udid, bundleId });
    } catch (err) {
      entry.meta.error = `capture running, CA trusted, but Frida unpin failed: ${(err as Error).message}`;
    }
  }

  async captureStop(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.unpin?.stop();
    if (entry.systemProxy) {
      await restoreSystemProxy(entry.systemProxy).catch(() => {});
      entry.systemProxy = undefined;
    }
    await entry.proxy.stop();
    entry.meta.state = "stopped";
    entry.meta.stoppedAt_ms = Date.now();
    this.broadcastSession(entry.meta);
  }

  sessionsList(): ProxyCaptureSession[] {
    return [...this.sessions.values()]
      .map((e) => ({ ...e.meta, transactionCount: this.store.countForSession(e.meta.id) }))
      .sort((a, b) => b.startedAt_ms - a.startedAt_ms);
  }

  historyQuery(q: HistoryQuery): ProxyTransactionRow[] {
    return this.store.query(q).map(toRow);
  }

  transactionGet(id: string): ProxyTransactionFull | null {
    const tx = this.store.get(id);
    return tx ? toFull(tx) : null;
  }

  caExportPem(): string {
    return this.ca.exportPem();
  }

  caCertFilePath(): string {
    return this.ca.certFilePath();
  }

  subscribe(subscriptionId: string, sub: Subscriber): void {
    this.subscribers.set(subscriptionId, sub);
  }

  unsubscribe(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId);
  }

  async disposeAll(): Promise<void> {
    this.subscribers.clear();
    for (const e of this.sessions.values()) {
      e.unpin?.stop();
      if (e.systemProxy) await restoreSystemProxy(e.systemProxy).catch(() => {});
    }
    await Promise.all([...this.sessions.values()].map((e) => e.proxy.stop().catch(() => {})));
    this.sessions.clear();
  }

  private broadcastTransaction(row: ProxyTransactionRow): void {
    for (const sub of this.subscribers.values()) sub.onTransaction(row);
  }

  private broadcastSession(session: ProxyCaptureSession): void {
    for (const sub of this.subscribers.values()) sub.onSession(session);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParsedRawRequest {
  method: string;
  path: string;
  headers: { name: string; value: string }[];
  body: string;
}

function parseRawRequest(raw: string): ParsedRawRequest {
  const normalized = raw.replace(/\r\n/g, "\n");
  const sep = normalized.indexOf("\n\n");
  const head = sep >= 0 ? normalized.slice(0, sep) : normalized;
  const body = sep >= 0 ? normalized.slice(sep + 2) : "";
  const lines = head.split("\n");
  const requestLine = lines.shift() ?? "";
  const parts = requestLine.split(/\s+/);
  const method = parts[0] || "GET";
  const path = parts[1] || "/";
  const headers: { name: string; value: string }[] = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0)
      headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
  }
  return { method, path, headers, body };
}

// A single daemon-wide ProxyService so the human UI (session dispatch) and the agent MCP tools
// share one set of capture sessions and one store — an agent-started capture shows up live in the
// UI, and the UI sees the same transactions the agent queries. Captures intentionally outlive any
// one client session (the user reconnects and finds their captures still running).
let shared: ProxyService | null = null;
export function getSharedProxyService(): ProxyService {
  if (!shared) shared = new ProxyService();
  return shared;
}

function defaultLabel(input: CaptureStartInput): string {
  if (input.bundleId) return input.bundleId;
  if (input.udid) return `Simulator ${input.udid.slice(0, 8)}`;
  return input.mode === "system" ? "System capture" : "Manual capture";
}
