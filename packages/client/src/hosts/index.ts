import {
  encodeHostRouteFrame,
  MAX_HOST_CHANNEL_FRAME_BYTES,
} from "@jagentdesk/protocol/binary-frames/host-route";
import { safeRandomId } from "../daemon-client-transport-utils.js";
import { DaemonClient } from "../daemon-client.js";
import type { DaemonTransportFactory } from "../daemon-client-transport-types.js";
import type { OwnedSubscription } from "../connection/owned.js";
import type { JAgentDeskApi, createJAgentDeskApi } from "../index.js";
import type { HostAdd, HostUpdate, HostSummary, HostDirectory } from "@jagentdesk/protocol/hosts";

type ConfirmPairing = (challenge: { code: string; expiresAt: number }) => Promise<boolean>;

export interface JAgentDeskHostActions {
  list(): Promise<HostDirectory>;
  observe(): OwnedSubscription<HostDirectory>;
  add(input: HostAdd, confirm: ConfirmPairing): Promise<HostSummary>;
  update(registrationId: string, patch: HostUpdate, confirm?: ConfirmPairing): Promise<HostSummary>;
  remove(registrationId: string): Promise<void>;
  client(serverId: string): Promise<JAgentDeskApi>;
}

export function createHostChannelTransport(
  origin: DaemonClient,
  serverId: string,
  scopeId: string,
  initialRouteId: string | null,
  link = false,
): DaemonTransportFactory {
  let first: string | null = initialRouteId;
  return () => {
    const opens = new Set<() => void>();
    const closes = new Set<(event?: unknown) => void>();
    const messages = new Set<(data: unknown, binary: boolean) => void | Promise<void>>();
    const errors = new Set<(error: unknown) => void>();
    let routeId: string | null = null;
    let closed = false;
    const cleanups: (() => void)[] = [];
    let queuedBytes = 0;
    let flowControl = false;
    let receivedFrames = 0;
    const close = (error?: unknown) => {
      if (closed) return;
      closed = true;
      if (error instanceof Error) Object.assign(error, { serverId });
      for (const cleanup of cleanups) cleanup();
      try {
        if (routeId) origin.closeHostRoute(routeId);
        else origin.cancelHostRoute(scopeId);
      } catch {
        /* Transport already closed. */
      }
      if (error) for (const handler of errors) handler(error);
      for (const handler of closes) handler(error);
    };
    const deliver = (data: unknown, binary: boolean) => {
      if (closed) return;
      const sequence = ++receivedFrames;
      try {
        const deliveries = [...messages].map(async (handler) => {
          await handler(data, binary);
        });
        void Promise.all(deliveries)
          .then(async () => {
            if (flowControl && !closed && routeId)
              await origin.acknowledgeHostLink(routeId, sequence);
            return undefined;
          })
          .catch(close);
      } catch (error) {
        close(error);
      }
    };
    cleanups.push(
      origin.subscribeRawMessages((message) => {
        if (message.type === "hosts.route.frame" && message.payload.subscriptionId === routeId) {
          deliver(message.payload.data, false);
        }
        if (message.type === "hosts.route.closed" && message.payload.subscriptionId === routeId)
          close(
            Object.assign(new Error(message.payload.message), {
              code: message.payload.code,
              serverId,
            }),
          );
      }),
    );
    cleanups.push(
      origin.subscribeHostFrames((frame) => {
        if (frame.routeId === routeId) deliver(frame.payload, true);
      }),
    );
    cleanups.push(
      origin.subscribeConnectionStatus((connectionState) => {
        if (connectionState.status !== "connected") close();
      }),
    );
    let opening: Promise<string>;
    if (first) opening = Promise.resolve(first);
    else if (link) {
      opening = origin.openHostLink(scopeId, { flowControl: true }).then((opened) => {
        // COMPAT(hostLinkFlowControl): added after v0.15.3 (#9109); remove after
        // 2027-05-08 once the daemon floor supports forwarding acknowledgments.
        // Older destinations omit flowControl and receive no acknowledgment messages.
        flowControl = opened.flowControl;
        return opened.routeId;
      });
    } else opening = origin.openHostRoute(serverId, scopeId);
    first = null;
    void opening
      .then((id) => {
        if (closed) {
          origin.closeHostRoute(id);
          return;
        }
        routeId = id;
        for (const handler of opens) handler();
        return undefined;
      })
      .catch(close);
    return {
      get supportsDrain() {
        return origin.supportsDrain;
      },
      maxFrameBytes: MAX_HOST_CHANNEL_FRAME_BYTES,
      send(data) {
        if (closed || !routeId)
          throw Object.assign(new Error(`Host ${serverId} is offline`), {
            code: "host_offline",
            serverId,
          });
        const payload =
          typeof data === "string" || data instanceof Uint8Array ? data : new Uint8Array(data);
        const bytes =
          typeof payload === "string"
            ? new TextEncoder().encode(
                JSON.stringify({
                  type: "session",
                  message: {
                    type: "hosts.route.frame.request",
                    routeId,
                    data: payload,
                    binary: false,
                  },
                }),
              ).byteLength
            : encodeHostRouteFrame(routeId, payload).byteLength;
        if (queuedBytes + bytes > 4 * 1024 * 1024) {
          const error = Object.assign(new Error("Host channel input limit reached"), {
            code: "resource_limit",
            serverId,
          });
          close(error);
          throw error;
        }
        let release: () => void;
        try {
          release = origin.reserveHostQueue(bytes);
        } catch (error) {
          close(error);
          throw error;
        }
        queuedBytes += bytes;
        return Promise.resolve()
          .then(() => origin.sendHostFrame(routeId!, payload))
          .catch((error: unknown) => {
            close(error);
            throw error;
          })
          .finally(() => {
            queuedBytes -= bytes;
            release();
          });
      },
      close: () => close(),
      onOpen(handler) {
        opens.add(handler);
        return () => opens.delete(handler);
      },
      onClose(handler) {
        closes.add(handler);
        return () => closes.delete(handler);
      },
      onError(handler) {
        errors.add(handler);
        return () => errors.delete(handler);
      },
      onMessage(handler) {
        messages.add(handler);
        return () => messages.delete(handler);
      },
    };
  };
}

export function createHostActions(
  origin: DaemonClient,
  owner: {
    own<T extends { release(): Promise<void> }>(create: () => T): T;
    signal: AbortSignal;
    api: typeof createJAgentDeskApi;
  },
): JAgentDeskHostActions {
  const assertActive = () => {
    if (owner.signal.aborted) throw new Error("JAgentDesk API is disposed");
  };
  return {
    list: () => {
      assertActive();
      return origin.listHosts();
    },
    observe: () => owner.own(() => origin.observeHosts()),
    add: async (input, confirm) => {
      assertActive();
      return pairHost(origin, input, confirm);
    },
    update: async (id, patch, confirm) => {
      assertActive();
      if (patch.connection === undefined) return origin.updateHost(id, patch);
      const { connection, replaceIdentity, ...settings } = patch;
      await pairHost(
        origin,
        { connection, metadata: settings.metadata, label: settings.label ?? undefined },
        confirm,
        id,
        replaceIdentity,
      );
      return origin.updateHost(id, settings);
    },
    remove: (id) => {
      assertActive();
      return origin.removeHost(id);
    },
    async client(serverId) {
      assertActive();
      origin.requireConnectedHosts();
      if (origin.getLastServerInfoMessage()?.serverId === serverId) {
        const api = owner.api(origin, { signal: owner.signal });
        const scope = owner.own(() => ({ release: () => api.dispose() }));
        return { ...api, dispose: () => scope.release() };
      }
      const scopeId = safeRandomId();
      const cancel = () => origin.cancelHostRoute(scopeId);
      owner.signal.addEventListener("abort", cancel, { once: true });
      let routeId: string;
      try {
        routeId = await origin.openHostRoute(serverId, scopeId);
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          serverId,
        });
      } finally {
        owner.signal.removeEventListener("abort", cancel);
      }
      if (owner.signal.aborted) {
        origin.closeHostRoute(routeId);
        assertActive();
      }
      const client = new DaemonClient({
        url: "ws://routed-host/ws",
        clientId: scopeId,
        transportFactory: createHostChannelTransport(origin, serverId, scopeId, routeId),
        // Initial acquisition has a deadline; established scopes restore demand on loss.
        reconnect: { enabled: false },
      });
      const api = owner.api(client, { signal: owner.signal });
      const scope = owner.own(() => ({
        release: async () => {
          try {
            await api.dispose();
          } finally {
            await client.close();
          }
        },
      }));
      try {
        await client.connect();
        client.setReconnectEnabled(true);
        assertActive();
        return { ...api, dispose: () => scope.release() };
      } catch (error) {
        const failure = Object.assign(
          error instanceof Error ? error : new Error("Host handshake failed"),
          {
            code: error instanceof Error && "code" in error ? error.code : "host_offline",
            serverId,
          },
        );
        await scope.release();
        throw failure;
      }
    },
  };
}

async function pairHost(
  origin: DaemonClient,
  input: HostAdd,
  confirm?: ConfirmPairing,
  registrationId?: string,
  replaceIdentity?: boolean,
): Promise<HostSummary> {
  if (!confirm) throw new Error("Host pairing requires a verification-code confirmation callback");
  const challenge = await origin.beginHostPairing(input, registrationId, replaceIdentity);
  let accepted = false;
  try {
    accepted = await confirm(challenge);
  } finally {
    if (!accepted) await origin.confirmHostPairing(challenge.transactionId, false).catch(() => {});
  }
  if (!accepted) throw new Error("Pairing cancelled");
  return origin.confirmHostPairing(challenge.transactionId, true);
}
