import { WebSocket } from "ws";
import {
  DaemonClient as SharedDaemonClient,
  type DaemonClientConfig as SharedDaemonClientConfig,
  type CreateAgentRequestOptions,
  type DaemonEvent,
  type DaemonEventHandler,
  type SendMessageOptions,
  type WebSocketLike,
} from "@jagentdesk/client/internal/daemon-client";

export type DaemonClientConfig = Omit<
  SharedDaemonClientConfig,
  "webSocketFactory" | "transportFactory" | "clientId"
> & { clientId?: string; onWebSocket?: (socket: WebSocket) => void };
export type CreateAgentOptions = CreateAgentRequestOptions;
export { type SendMessageOptions, type DaemonEvent, type DaemonEventHandler };

let testClientCounter = 0;

function nextTestClientId(): string {
  testClientCounter += 1;
  return `clid_test_client_${testClientCounter}`;
}

export class DaemonClient extends SharedDaemonClient {
  constructor(config: DaemonClientConfig) {
    const { onWebSocket, ...clientConfig } = config;
    const clientId = config.clientId ?? nextTestClientId();
    super({
      ...clientConfig,
      clientId,
      webSocketFactory: (url, options) => {
        const socket = new WebSocket(url, options?.protocols, { headers: options?.headers });
        onWebSocket?.(socket);
        return socket as unknown as WebSocketLike;
      },
    });
  }
}
