import { pairHost, type HostCredential } from "./pair.js";
import type { Logger } from "pino";
import {
  importDevicePublicKey,
  importDeviceSecretKey,
  signNonce,
} from "../pairing/device-signature-crypto.js";
import type { HostDial } from "@jagentdesk/client/node";
export { DaemonLinkEndpoint, VirtualHostSocket } from "./link.js";
export { ConnectedHostSession } from "./session.js";
import { randomUUID, createHash } from "node:crypto";
import { chmod, stat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  createHostClient,
  createHostTransportFactory,
  createHostChannelTransport,
  parseHostTarget,
  HostTransportBudget,
} from "@jagentdesk/client/node";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import {
  HostSummarySchema,
  HostAddSchema,
  HostUpdateSchema,
  type HostDirectory,
  type HostSummary,
  type HostAdd,
  type HostUpdate,
} from "@jagentdesk/protocol/hosts";
import type { DaemonPermission, WSHelloMessage } from "@jagentdesk/protocol/messages";

export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly serverId?: string,
  ) {
    super(message);
  }
}
const SavedSchema = HostSummarySchema.extend({
  connection: z.string(),
  credential: z.object({ publicKey: z.string(), secretKey: z.string() }),
});
type Saved = z.infer<typeof SavedSchema>;
export interface HostActor {
  sourceId: string;
  manageSources: boolean;
}
interface Live {
  client: DaemonClient;
  accepted: boolean;
  stop(): void;
}
interface Route {
  registrationId: string;
  close(code?: string, message?: string): void;
}

/** Daemon-owned configuration, identity pinning, retry and routed session lifetime. */
export class ConnectedHosts {
  private rows: Saved[] = [];
  private readonly live = new Map<string, Live>();
  private readonly routes = new Set<Route>();
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private closed = false;
  private readonly pairings = new Map<
    string,
    {
      pair: Awaited<ReturnType<typeof pairHost>>;
      input: HostAdd;
      actor: HostActor;
      registrationId?: string;
      replaceIdentity?: boolean;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  async beginPairing(
    input: HostAdd,
    actor: HostActor,
    registrationId?: string,
    replaceIdentity?: boolean,
  ) {
    await this.ready;
    if (this.pairings.size >= 4) throw new HostError("resource_limit", "Too many pending pairings");
    if (!registrationId && this.rows.length >= 32)
      throw new HostError("resource_limit", "Saved host limit is 32");
    input = HostAddSchema.parse(input);
    const target = parseHostTarget(input.connection);
    if (registrationId) {
      const previous = this.require(registrationId);
      if (previous.serverId !== target.pairing.serverId && !replaceIdentity)
        throw new HostError(
          "server_id_mismatch",
          "Use --replace-identity after verifying the destination",
        );
    }
    const pair = await pairHost(input.connection, this.self.label, this.dial);
    const timer = setTimeout(() => {
      this.pairings.delete(pair.transactionId);
      pair.cancel();
    }, 120000);
    timer.unref();
    this.pairings.set(pair.transactionId, {
      pair,
      input,
      actor,
      registrationId,
      replaceIdentity,
      timer,
    });
    return { transactionId: pair.transactionId, code: pair.code, expiresAt: pair.expiresAt };
  }
  async confirmPairing(
    transactionId: string,
    accepted: boolean,
    actor: HostActor,
  ): Promise<HostSummary> {
    const pending = this.pairings.get(transactionId);
    if (!pending || pending.actor.sourceId !== actor.sourceId)
      throw new HostError("pairing_expired", "Pairing expired");
    this.pairings.delete(transactionId);
    clearTimeout(pending.timer);
    await pending.pair.confirm(accepted);
    return this.savePaired(pending.input, actor, pending.pair.credential, pending.registrationId);
  }

  constructor(
    private readonly home: string,
    private readonly self: HostDirectory["self"],
    private readonly dial?: HostDial,
    private readonly logger?: Logger,
  ) {
    this.ready = this.load();
    void this.ready.catch(() => {});
  }
  private async load(): Promise<void> {
    try {
      const file = join(this.home, "hosts.json");
      const info = await stat(file);
      if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
        await chmod(file, 0o600);
        this.logger?.info({ file: "hosts.json" }, "file_mode_repaired");
      }
      this.rows = z
        .array(SavedSchema)
        .parse(JSON.parse(await readFile(join(this.home, "hosts.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        // oxlint-disable-next-line preserve-caught-error -- Zod failures may retain credential values.
        throw new Error("Cannot read saved connected hosts");
    }
    if (this.closed) return;
    for (const row of this.rows) {
      row.status = row.enabled ? "connecting" : "disabled";
      row.nextRetryAt = null;
      this.start(row);
    }
  }
  async list(): Promise<HostDirectory> {
    await this.ready;
    return {
      self: { ...this.self },
      hosts: this.rows.map((row) => this.summary(row)),
    };
  }
  observe(changed: () => void): () => void {
    this.listeners.add(changed);
    return () => this.listeners.delete(changed);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private async persist(rows: Saved[]): Promise<void> {
    const destination = join(this.home, "hosts.json");
    const temp = join(this.home, `.hosts-${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(rows));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, destination);
      if (process.platform !== "win32") await chmod(destination, 0o600);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await this.ready;
      if (this.closed) throw new HostError("host_offline", "Daemon is stopping");
      return run();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private summary(row: Saved): HostSummary {
    const { connection: _secret, credential: _credential, ...summary } = row;
    return structuredClone(summary);
  }
  add(_input: HostAdd, _actor: HostActor): Promise<HostSummary> {
    throw new HostError(
      "pairing_required",
      "Use host pairing begin and confirm to compare the verification code on both devices",
    );
  }
  private savePaired(
    input: HostAdd,
    actor: HostActor,
    credential: HostCredential,
    registrationId?: string,
  ): Promise<HostSummary> {
    return this.mutate(async () => {
      input = HostAddSchema.parse(input);
      const target = parseHostTarget(input.connection);
      if (registrationId) {
        const previous = this.require(registrationId);
        const row: Saved = {
          ...previous,
          connection: input.connection,
          credential,
          serverId: target.pairing.serverId,
          targetDescription: target.description,
          status: "connecting",
          error: null,
          enabled: true,
        };
        await this.persist(this.rows.map((r) => (r === previous ? row : r)));
        this.stop(registrationId);
        this.rows = this.rows.map((r) => (r === previous ? row : r));
        this.start(row);
        this.changed();
        return this.summary(row);
      }
      const source = { id: actor.sourceId, key: input.sourceKey ?? randomUUID() };
      const existing = this.rows.find(
        (row) => row.source.id === source.id && row.source.key === source.key,
      );
      if (existing) {
        if (
          existing.connection === input.connection &&
          existing.label === (input.label ?? null) &&
          JSON.stringify(Object.entries(existing.metadata).sort()) ===
            JSON.stringify(Object.entries(input.metadata ?? {}).sort())
        )
          return this.summary(existing);
        throw new HostError(
          "source_conflict",
          "This source key already exists. Update its registration explicitly.",
        );
      }
      if (this.rows.length >= 32)
        throw new HostError("resource_limit", "Remove a host before adding another (limit 32)");
      const row: Saved = {
        registrationId: `hst_${randomUUID()}`,
        serverId: target.pairing.serverId,
        credential,
        connection: input.connection,
        label: input.label ?? null,
        metadata: input.metadata ?? {},
        source,
        enabled: true,
        status: "connecting",
        targetDescription: target.description,
        lastOnlineAt: null,
        nextRetryAt: null,
        error: null,
      };
      await this.persist([...this.rows, row]);
      this.rows.push(row);
      this.start(row);
      this.changed();
      return this.summary(row);
    });
  }
  update(id: string, patch: HostUpdate, _actor: HostActor): Promise<HostSummary> {
    return this.mutate(async () => {
      patch = HostUpdateSchema.parse(patch);
      if (patch.connection !== undefined)
        throw new HostError("pairing_required", "Changing a connection requires two-sided pairing");
      const previous = this.require(id);
      if (patch.replaceIdentity)
        throw new HostError("pairing_required", "Identity replacement requires two-sided pairing");
      const row: Saved = {
        ...previous,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      };
      const restart =
        patch.enabled !== undefined ||
        previous.status === "error" ||
        previous.status === "outdated";
      if (restart) {
        row.status = row.enabled ? "connecting" : "disabled";
        row.error = null;
        row.nextRetryAt = null;
      }
      const rows = this.rows.map((entry) => (entry === previous ? row : entry));
      await this.persist(rows);
      if (restart) this.stop(id, row.enabled ? "host_offline" : "host_disabled");
      Object.assign(previous, row);
      this.rows = rows.map((entry) => (entry === row ? previous : entry));
      if (restart) this.start(previous);
      this.changed();
      return this.summary(previous);
    });
  }
  remove(id: string, actor: HostActor): Promise<void> {
    return this.mutate(async () => {
      const row = this.require(id);
      if (actor.sourceId !== row.source.id && !actor.manageSources)
        throw new HostError(
          "permission_denied",
          "Only the source or access manager can remove this host. Disable it to stop access.",
        );
      const rows = this.rows.filter((entry) => entry !== row);
      await this.persist(rows);
      this.stop(id, "host_unknown");
      this.rows = rows;
      this.changed();
    });
  }
  private require(id: string): Saved {
    const row = this.rows.find((entry) => entry.registrationId === id);
    if (!row) throw new HostError("host_unknown", "Unknown host registration");
    return row;
  }
  private stop(id: string, code = "host_offline"): void {
    this.live.get(id)?.stop();
    this.live.delete(id);
    for (const route of this.routes)
      if (route.registrationId === id)
        route.close(code, "Host access was disabled, replaced or removed");
  }
  private start(row: Saved): void {
    if (!row.enabled || this.closed) return;
    let stopped = false;
    const factory =
      createHostTransportFactory(
        row.connection,
        new HostTransportBudget(32 * 1024 * 1024),
        this.dial,
      );
    const client = createHostClient(
      row.connection,
      {
        clientId: `host-link-${this.self.serverId}-${row.registrationId}`,
        connectTimeoutMs: 10000,
        transportFactory: factory,
        expectChallenge: true,
        deviceSigning: {
          devicePublicKeyB64: row.credential.publicKey,
          signNonce: (nonce) =>
            signNonce(
              {
                publicKey: importDevicePublicKey(row.credential.publicKey),
                secretKey: importDeviceSecretKey(row.credential.secretKey),
              },
              nonce,
            ),
        },
      },
      new HostTransportBudget(32 * 1024 * 1024),
      this.dial,
    );
    const live: Live = {
      client,
      accepted: false,
      stop: () => {
        stopped = true;
        void client.close();
      },
    };
    this.live.set(row.registrationId, live);
    const accept = async () => {
      try {
        const info = client.getLastServerInfoMessage();
        if (!info) throw new HostError("host_offline", "No daemon identity received");
        if (row.serverId && info.serverId !== row.serverId)
          throw new HostError(
            "server_id_mismatch",
            "Daemon identity changed. Verify the destination and explicitly replace its identity.",
          );
        if (!row.serverId)
          await this.mutate(async () => {
            if (stopped) return;
            const discovered = { ...row, serverId: info.serverId };
            await this.persist(this.rows.map((entry) => (entry === row ? discovered : entry)));
            row.serverId = info.serverId;
          });
        if (info.serverId === this.self.serverId)
          throw new HostError(
            "self_host",
            "This connection reaches this daemon. Remove it or replace the connection.",
          );
        if (this.rows.find((entry) => entry.serverId === info.serverId) !== row)
          throw new HostError(
            "duplicate_host",
            "Another registration already owns this daemon. Remove the duplicate registration.",
          );
        if (info.features?.connectedHosts !== true || info.features?.hostMultiplexing !== true)
          throw new HostError(
            "unsupported_capability",
            "Update the destination daemon to use connected hosts.",
          );
        // Pin and persist under the same writer as management to prevent discovery races.
        await this.mutate(async () => {
          if (stopped) return;
          if (this.rows.find((entry) => entry.serverId === info.serverId) !== row)
            throw new HostError("duplicate_host", "Another registration already owns this daemon");
          const next = {
            ...row,
            serverId: info.serverId,
            status: "connected" as const,
            lastOnlineAt: new Date().toISOString(),
            error: null,
            nextRetryAt: null,
          };
          await this.persist(this.rows.map((entry) => (entry === row ? next : entry)));
          if (stopped || client.getLastServerInfoMessage() !== info || !client.isConnected) return;
          Object.assign(row, next);
          live.accepted = true;
          this.changed();
        });
      } catch (error) {
        if (stopped) return;
        row.error = connectionFailure(error, false) ?? {
          code: "host_offline",
          message: "Host connection failed",
        };
        row.status = "error";
        row.nextRetryAt = null;
        this.changed();
        await client.close();
      }
    };
    client.subscribeConnectionStatus((state) => {
      if (stopped || row.status === "error") return;
      live.accepted = false;
      if (state.status === "connected") {
        void accept();
        return;
      }
      for (const route of this.routes)
        if (route.registrationId === row.registrationId) route.close();
      row.status = "connecting";
      row.nextRetryAt = state.status === "disconnected" ? (state.nextRetryAt ?? null) : null;
      row.error =
        state.status === "disconnected"
          ? (connectionFailure(
              Object.assign(new Error("Check the paired device on the destination"), {
                code: state.failureCode,
              }),
              false,
            ) ?? {
              code: "host_offline",
              message: "Cannot reach host. Check the connection; retrying automatically.",
            })
          : null;
      if (row.error?.code === "authentication_failed") {
        row.status = "error";
        row.nextRetryAt = null;
        client.setReconnectEnabled(false);
        void client.close();
      }
      this.changed();
    });
    void client.connect().catch(() => {});
  }
  async openRoute(input: {
    serverId: string;
    scopeId: string;
    sourceId: string;
    originSessionId: string;
    permissions: readonly DaemonPermission[];
    signal: AbortSignal;
    frame(data: string | Uint8Array): void | Promise<void>;
    ended(code: string, message: string): void;
  }): Promise<{ send(data: string | Uint8Array): void; close(): void }> {
    await this.ready;
    const row = this.rows.find((entry) => entry.serverId === input.serverId);
    if (!row) throw new HostError("host_unknown", `Unknown host ${input.serverId}`, input.serverId);
    if (!row.enabled)
      throw new HostError(
        "host_disabled",
        `Enable host ${input.serverId} before using it`,
        input.serverId,
      );
    if (row.status !== "connected")
      throw new HostError(
        row.error?.code ?? "host_offline",
        row.error?.message ?? `Host ${input.serverId} is offline`,
        input.serverId,
      );
    if (
      [...this.routes].filter((route) => route.registrationId === row.registrationId).length >= 64
    )
      throw new HostError("resource_limit", "Too many routed sessions");
    const live = this.live.get(row.registrationId);
    const client = live?.client;
    if (!live?.accepted || !client?.isConnected)
      throw new HostError("host_offline", "Host is offline", input.serverId);
    const transport = createHostChannelTransport(
      client,
      input.serverId,
      randomUUID(),
      null,
      true,
    )({ url: "ws://host-link/ws" });
    let closed = false;
    let verified = false;
    let helloSent = false;
    const timer = setTimeout(() => route.close("host_offline", "Host handshake timed out"), 15000);
    timer.unref();
    const route: Route = {
      registrationId: row.registrationId,
      close: (code = "host_offline", message = `Host ${input.serverId} disconnected`) => {
        if (closed) return;
        closed = true;
        input.signal.removeEventListener("abort", abort);
        clearTimeout(timer);
        this.routes.delete(route);
        try {
          transport.close();
        } finally {
          failed(new HostError(code, message, input.serverId));
          input.ended(code, message);
        }
      },
    };
    this.routes.add(route);
    const abort = () =>
      route.close("host_offline", "Origin session closed or its authority changed");
    input.signal.addEventListener("abort", abort, { once: true });
    let opened!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      opened = resolve;
      failed = reject;
    });
    if (input.signal.aborted) {
      route.close();
    }
    transport.onOpen(opened);
    transport.onError((error) => {
      const authenticationFailed =
        error instanceof Error && "code" in error && error.code === "authentication_failed";
      const code = authenticationFailed ? "authentication_failed" : "host_offline";
      const message = authenticationFailed
        ? "Host authentication failed. Check the paired device on the destination."
        : "Host transport failed";
      failed(new HostError(code, message, input.serverId));
      route.close(code, message);
    });
    transport.onClose(() => {
      failed(new HostError("host_offline", "Host transport closed"));
      route.close();
    });
    transport.onMessage((data, binary) => {
      if (closed) return;
      if (!verified) {
        if (binary) {
          route.close();
          return;
        }
        try {
          const envelope = JSON.parse(String(data));
          if (envelope.type === "hello.rejected") {
            route.close("authentication_failed", "Replace the host credentials");
            return;
          }
          const info =
            envelope.type === "session" && envelope.message.type === "status"
              ? envelope.message.payload
              : null;
          if (info?.status !== "server_info") return;
          if (info.serverId !== row.serverId) {
            route.close(
              "server_id_mismatch",
              "Host identity changed; explicit replacement required",
            );
            return;
          }
          if (info.features?.connectedHosts !== true) {
            route.close("unsupported_capability", "Update the destination daemon");
            return;
          }
          verified = true;
          clearTimeout(timer);
        } catch {
          route.close();
          return;
        }
      }
      return input.frame(binary ? (data as Uint8Array) : String(data));
    });
    await ready;
    if (closed) throw new HostError("host_offline", "Host closed during connection");
    return {
      close: () => route.close(),
      send: (data) => {
        const binary = typeof data !== "string";
        if (closed) throw new HostError("host_offline", "Host is offline");
        if (!helloSent) {
          if (binary) throw new HostError("invalid_message", "Expected hello");
          const hello = JSON.parse(data as string) as WSHelloMessage;
          if (hello.type !== "hello") throw new HostError("invalid_message", "Expected hello");
          const clientId = `route-${createHash("sha256")
            .update(
              JSON.stringify([
                this.self.serverId,
                input.sourceId,
                input.originSessionId,
                input.scopeId,
              ]),
            )
            .digest("hex")}`;
          void Promise.resolve(
            transport.send(
              JSON.stringify({
                ...hello,
                clientId,
                routed: true,
                producer: { serverId: this.self.serverId, sourceId: input.sourceId },
                sessionPermissions: input.permissions,
                auth: undefined,
              }),
            ),
          ).catch(() => route.close("host_offline", "Host transport unavailable"));
          helloSent = true;
          return;
        }
        if (!verified) throw new HostError("host_offline", "Host identity has not been verified");
        try {
          void Promise.resolve(transport.send(data)).catch(() =>
            route.close("host_offline", "Host transport unavailable"),
          );
        } catch {
          route.close("resource_limit", "Host buffer limit reached or transport unavailable");
        }
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.pairings.values()) {
      clearTimeout(pending.timer);
      pending.pair.cancel();
    }
    this.pairings.clear();
    await this.ready;
    await this.queue;
    for (const id of this.live.keys()) this.stop(id);
    for (const route of this.routes) route.close();
    this.listeners.clear();
  }
}

function connectionFailure(error: unknown, authenticationFailed: boolean): HostSummary["error"] {
  if (error instanceof HostError) return { code: error.code, message: error.message };
  if (error instanceof Error && "code" in error && error.code === "authentication_failed")
    return { code: "authentication_failed", message: error.message };
  if (authenticationFailed)
    return {
      code: "authentication_failed",
      message: "Host rejected the credentials. Replace the connection credentials.",
    };
  return null;
}
