import { randomBytes } from "node:crypto";
import type {
  SshAuthPrompt,
  SshAuthPromptItem,
  SshAuthPromptKind,
  SshHostkeyPrompt,
  SshPromptResolved,
} from "@jagentdesk/protocol/ssh/rpc-schemas";

// Spec 25.3 steps 3–4. Prompts are broadcast to every connected client (any client
// may answer; the first answer wins) and expire after 120 s. When a prompt is
// answered, expires, or is abandoned, `ssh.prompt.resolved` tells every client to drop
// its bar. Host-key answers decide TOFU; auth answers cross the daemon once and are
// never stored — never log a prompt's answers.

export const HOSTKEY_PROMPT_TIMEOUT_MS = 120_000;
export const AUTH_PROMPT_TIMEOUT_MS = 120_000;

export type SshPromptPush = SshHostkeyPrompt | SshAuthPrompt | SshPromptResolved;

export interface HostKeyPromptInfo {
  serverId: string;
  terminalId?: string;
  address: string;
  port: number;
  keyType: string;
  fingerprintSha256: string;
  hopIndex?: number;
  hopCount?: number;
}

export type HostKeyDecision = "accept" | "reject" | "timeout" | "cancelled";

export interface AuthPromptInfo {
  serverId: string;
  terminalId?: string;
  kind: SshAuthPromptKind;
  instructions?: string;
  prompts: SshAuthPromptItem[];
}

interface Pending<T> {
  serverId: string;
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
  push: SshHostkeyPrompt | SshAuthPrompt;
}

export interface SshPromptBrokerOptions {
  hostKeyTimeoutMs?: number;
  authTimeoutMs?: number;
}

export class SshPromptBroker {
  private readonly pendingHostKeys = new Map<string, Pending<HostKeyDecision>>();
  private readonly pendingAuths = new Map<string, Pending<string[] | null>>();

  constructor(
    private readonly broadcast: (msg: SshPromptPush) => void,
    private readonly options: SshPromptBrokerOptions = {},
  ) {}

  requestHostKey(info: HostKeyPromptInfo): Promise<HostKeyDecision> {
    const promptId = `hk_${randomBytes(6).toString("hex")}`;
    const timeoutMs = this.options.hostKeyTimeoutMs ?? HOSTKEY_PROMPT_TIMEOUT_MS;
    const push: SshHostkeyPrompt = {
      type: "ssh.hostkey.prompt",
      promptId,
      serverId: info.serverId,
      ...(info.terminalId ? { terminalId: info.terminalId } : {}),
      address: info.address,
      port: info.port,
      keyType: info.keyType,
      fingerprintSha256: info.fingerprintSha256,
      ...(info.hopIndex !== undefined ? { hopIndex: info.hopIndex } : {}),
      ...(info.hopCount !== undefined ? { hopCount: info.hopCount } : {}),
      expiresAtMs: Date.now() + timeoutMs,
    };
    return new Promise<HostKeyDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(this.pendingHostKeys, promptId, "timeout");
      }, timeoutMs);
      this.pendingHostKeys.set(promptId, { serverId: info.serverId, resolve, timer, push });
      this.broadcast(push);
    });
  }

  respondHostKey(promptId: string, decision: "accept" | "reject"): boolean {
    return this.settle(this.pendingHostKeys, promptId, decision);
  }

  /** Resolves with one answer per prompt, or null when timed out / cancelled. */
  requestAuth(info: AuthPromptInfo): Promise<string[] | null> {
    const promptId = `ap_${randomBytes(6).toString("hex")}`;
    const timeoutMs = this.options.authTimeoutMs ?? AUTH_PROMPT_TIMEOUT_MS;
    const push: SshAuthPrompt = {
      type: "ssh.auth.prompt",
      promptId,
      serverId: info.serverId,
      ...(info.terminalId ? { terminalId: info.terminalId } : {}),
      kind: info.kind,
      ...(info.instructions ? { instructions: info.instructions } : {}),
      prompts: info.prompts,
      expiresAtMs: Date.now() + timeoutMs,
    };
    return new Promise<string[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(this.pendingAuths, promptId, null);
      }, timeoutMs);
      this.pendingAuths.set(promptId, { serverId: info.serverId, resolve, timer, push });
      this.broadcast(push);
    });
  }

  /** `answers: null` cancels the prompt (the connect treats it as declined). */
  respondAuth(promptId: string, answers: string[] | null): boolean {
    const pending = this.pendingAuths.get(promptId);
    if (!pending) return false;
    if (answers && answers.length !== (pending.push as SshAuthPrompt).prompts.length) {
      throw new Error("Answer count does not match the prompt.");
    }
    return this.settle(this.pendingAuths, promptId, answers);
  }

  /** Prompts still open — re-sent to a client that connects mid-prompt. */
  listPending(): Array<SshHostkeyPrompt | SshAuthPrompt> {
    return [
      ...Array.from(this.pendingHostKeys.values(), (pending) => pending.push),
      ...Array.from(this.pendingAuths.values(), (pending) => pending.push),
    ];
  }

  /** Abandon every prompt tied to a server (connection teardown / cancel). */
  cancelForServer(serverId: string): void {
    for (const [promptId, pending] of Array.from(this.pendingAuths.entries())) {
      if (pending.serverId === serverId) this.settle(this.pendingAuths, promptId, null);
    }
    for (const [promptId, pending] of Array.from(this.pendingHostKeys.entries())) {
      if (pending.serverId === serverId) this.settle(this.pendingHostKeys, promptId, "cancelled");
    }
  }

  cancelAll(): void {
    for (const promptId of Array.from(this.pendingAuths.keys())) {
      this.settle(this.pendingAuths, promptId, null);
    }
    for (const promptId of Array.from(this.pendingHostKeys.keys())) {
      this.settle(this.pendingHostKeys, promptId, "cancelled");
    }
  }

  hasPendingPrompts(): boolean {
    return this.pendingHostKeys.size > 0 || this.pendingAuths.size > 0;
  }

  private settle<T>(map: Map<string, Pending<T>>, promptId: string, value: T): boolean {
    const pending = map.get(promptId);
    if (!pending) return false;
    map.delete(promptId);
    clearTimeout(pending.timer);
    pending.resolve(value);
    this.broadcast({ type: "ssh.prompt.resolved", promptId });
    return true;
  }
}
