export { createHostChannelTransport } from "../hosts/index.js";
export { HostTransportBudget } from "./buffering.js";
import { HostTransportBudget } from "./buffering.js";
import { WebSocket } from "ws";
import type { SecurityMode } from "@jagentdesk/relay/e2ee";
import type { Socket } from "node:net";
import { parseHostTarget, type HostTarget } from "@jagentdesk/protocol/host-target";
import { createWebSocketTransportFactory } from "../daemon-client-websocket-transport.js";
import { createRelayE2eeTransportFactory } from "../daemon-client-relay-e2ee-transport.js";
import type { DaemonTransportFactory, WebSocketLike } from "../daemon-client-transport-types.js";
import { DaemonClient, type DaemonClientConfig } from "../daemon-client.js";
export { parseHostTarget };
export type HostDial = (target: HostTarget) => Promise<Socket>;

/** Tailnet dialing must be injected by the daemon's tsnet owner; never use OS routing. */
export function createHostTransportFactory(
  connection: string,
  budget = new HostTransportBudget(),
  dial?: HostDial,
): DaemonTransportFactory {
  const target = parseHostTarget(connection);
  let securityFloor: SecurityMode | undefined;
  return (attempt) => {
    const opens = new Set<() => void>(),
      closes = new Set<(e?: unknown) => void>(),
      errors = new Set<(e?: unknown) => void>(),
      messages = new Set<(d: unknown, b: boolean) => void>();
    let transport: ReturnType<DaemonTransportFactory> | undefined;
    let closed = false;
    let connectionSocket: Socket | undefined;
    void (async () => {
      if (target.via === "tailnet") {
        if (!dial) throw new Error("tailnet_unavailable");
        connectionSocket = await dial(target);
        if (closed) {
          connectionSocket.destroy();
          return;
        }
      }
      let physical: WebSocket;
      const baseFactory = createWebSocketTransportFactory((url, options) => {
        const socket = new WebSocket(url, options?.protocols, {
          headers: options?.headers,
          maxPayload: 100 * 1024 * 1024,
          ...(connectionSocket ? { createConnection: () => connectionSocket! } : {}),
        });
        physical = socket;
        const pending = new Set<() => void>();
        const send = socket.send.bind(socket);
        socket.send = (data, ...args: unknown[]) => {
          const bytes =
            typeof data === "string"
              ? Buffer.byteLength(data)
              : Buffer.byteLength(data as Uint8Array);
          if (socket.bufferedAmount + bytes > 32 * 1024 * 1024)
            throw Object.assign(new Error("Host link buffer limit reached"), {
              code: "resource_limit",
            });
          const release = budget.reserve(bytes);
          pending.add(release);
          const callback = args.find((v): v is (error?: Error) => void => typeof v === "function");
          try {
            send(data, {}, (error) => {
              release();
              pending.delete(release);
              callback?.(error);
            });
          } catch (error) {
            release();
            pending.delete(release);
            throw error;
          }
        };
        socket.once("close", () => {
          for (const release of pending) release();
          pending.clear();
        });
        return socket as unknown as WebSocketLike;
      });
      let factory: DaemonTransportFactory = (request) => {
        const base = baseFactory(request);
        return {
          ...base,
          send(data) {
            return new Promise<void>((resolve, reject) =>
              physical.send(data, (error) => {
                if (error) reject(error);
                else resolve();
              }),
            );
          },
        };
      };
      if (target.via === "relay")
        factory = createRelayE2eeTransportFactory({
          baseFactory: factory,
          daemonPublicKeyB64: target.pairing.daemonPublicKeyB64!,
          logger: { warn() {} },
          minimumMode: securityFloor,
          onSecurityMode: (mode) => {
            if (mode === "protected") securityFloor = mode;
          },
          assertOutboundCapacity: (bytes) => budget.assertCapacity(bytes),
        });
      transport = factory({ ...attempt, url: target.url });
      transport.onOpen(() => {
        if (!closed) for (const h of opens) h();
      });
      transport.onMessage((d, b) => {
        if (!closed) for (const h of messages) h(d, b);
      });
      transport.onError((e) => {
        if (!closed) for (const h of errors) h(e);
      });
      transport.onClose((e) => {
        if (!closed) {
          closed = true;
          for (const h of closes) h(e);
        }
      });
    })().catch((e) => {
      if (!closed) {
        for (const h of errors) h(e);
        closed = true;
        for (const h of closes) h(e);
      }
    });
    return {
      supportsDrain: true,
      send(data) {
        if (closed || !transport) throw new Error("Host transport unavailable");
        return transport.send(data);
      },
      close(code, reason) {
        if (closed) return;
        closed = true;
        transport?.close(code, reason);
        connectionSocket?.destroy();
      },
      onOpen(h) {
        opens.add(h);
        return () => {
          opens.delete(h);
        };
      },
      onClose(h) {
        closes.add(h);
        return () => {
          closes.delete(h);
        };
      },
      onError(h) {
        errors.add(h);
        return () => {
          errors.delete(h);
        };
      },
      onMessage(h) {
        messages.add(h);
        return () => {
          messages.delete(h);
        };
      },
    };
  };
}
export function createHostClient(
  connection: string,
  config: Omit<DaemonClientConfig, "url">,
  budget?: HostTransportBudget,
  dial?: HostDial,
): DaemonClient {
  return new DaemonClient({
    ...config,
    url: parseHostTarget(connection).url,
    transportFactory:
      config.transportFactory ?? createHostTransportFactory(connection, budget, dial),
  });
}
