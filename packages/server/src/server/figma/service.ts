import type pino from "pino";
import type {
  FigmaPush,
  FigmaRequest,
  FigmaRequestType,
  FigmaResponseData,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { SecretStore } from "../database/secret-store.js";
import type {
  FigmaCache,
  FigmaContext,
  FigmaLinkBridge,
  FigmaRestClient,
  FigmaStore,
  FigmaTokenProvider,
} from "./context.js";
import { FigmaServiceError } from "./context.js";
import { commentsHandlers } from "./handlers/comments.js";
import { connectionsHandlers } from "./handlers/connections.js";
import { contentHandlers } from "./handlers/content.js";
import { filesHandlers } from "./handlers/files.js";
import { linkHandlers } from "./handlers/link.js";
import { pendingHandlers } from "./handlers/pending.js";
import { playbackHandlers } from "./handlers/playback.js";
import { remoteHandlers } from "./handlers/remote.js";
import type { FigmaHandler, FigmaHandlerMap, FigmaSessionInfo } from "./handlers/types.js";
import { FigmaRemoteConnector } from "./remote/connector.js";

// The daemon-wide Figma service (spec 32): one instance shared by every session and the agent
// tools. It composes the handler groups, owns push fan-out, and closes Figma Link on dispose.

const HANDLERS: FigmaHandlerMap<FigmaRequestType> = {
  ...connectionsHandlers,
  ...filesHandlers,
  ...contentHandlers,
  ...commentsHandlers,
  ...linkHandlers,
  ...pendingHandlers,
  ...playbackHandlers,
  ...remoteHandlers,
};

export interface FigmaServiceParts {
  store: FigmaStore;
  tokens: FigmaTokenProvider;
  rest: FigmaRestClient;
  cache: FigmaCache;
  link: FigmaLinkBridge;
}

export class FigmaService {
  readonly ctx: FigmaContext;
  private readonly listeners = new Set<(event: FigmaPush) => void>();

  constructor(options: {
    jagentdeskHome: string;
    logger: pino.Logger;
    secrets: SecretStore;
    parts: FigmaServiceParts;
    now?: () => number;
  }) {
    this.ctx = {
      jagentdeskHome: options.jagentdeskHome,
      logger: options.logger.child({ module: "figma" }),
      secrets: options.secrets,
      ...options.parts,
      push: (event) => {
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch (error) {
            this.ctx.logger.warn({ err: error }, "figma push listener failed");
          }
        }
      },
      now: options.now ?? (() => Date.now()),
    };
    // One remote write connector per daemon (ADR-0040). Construction is inert: no file read,
    // no spawn; the dedicated app-server starts lazily on the first explicit connect.
    this.ctx.remote = new FigmaRemoteConnector({
      jagentdeskHome: options.jagentdeskHome,
      logger: options.logger,
    });
  }

  handles(type: string): type is FigmaRequestType {
    return Object.hasOwn(HANDLERS, type);
  }

  async handle<T extends FigmaRequestType>(
    request: Extract<FigmaRequest, { type: T }>,
    session: FigmaSessionInfo,
  ): Promise<FigmaResponseData<T>> {
    const handler = HANDLERS[request.type as T] as FigmaHandler<T> | undefined;
    if (!handler)
      throw new FigmaServiceError("unsupported", `Unknown Figma request ${request.type}`);
    return handler(request, this.ctx, session);
  }

  onPush(listener: (event: FigmaPush) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    await this.ctx.link.close();
    await this.ctx.remote?.dispose();
  }
}
