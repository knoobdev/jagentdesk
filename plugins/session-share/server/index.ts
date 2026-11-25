import type {
  BuiltinServerHost,
  SessionInboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { SessionShareService } from "./service.js";
import { SessionShareSession } from "./session.js";

export function register(host: BuiltinServerHost) {
  // Session sharing stays off by default (ADR-0018). Construction is inert; its lifecycle owns
  // Cloudflare quick tunnels and scoped per-share servers.
  const shares = host.daemonService((context) => {
    const service = new SessionShareService({
      logger: context.logger,
      agentManager: context.agentManager,
      agentStorage: context.agentStorage,
      tunnelManager: context.sessionShare.tunnelManager,
      isEnabled: () => context.isEnabled("session-share"),
      appDistDir: context.sessionShare.appDistDir,
      onUpdate: (share) => context.broadcast({ type: "session.share.stream", payload: { share } }),
    });
    // Validated guest sockets become agent-confined daemon sessions; a live capability toggle
    // re-scopes connected guests (ADR-0019). Both stay core-owned.
    service.setGuestAttacher((ws, params) => context.sessionShare.attachGuestSocket(ws, params));
    service.setGuestScopeUpdater((agentId, scopes) =>
      context.sessionShare.updateGuestScopes(agentId, scopes),
    );
    return service;
  });
  // Turning sharing off stops every share and disconnects its guests.
  host.backgroundService((_services, daemon) => ({
    start() {},
    stop: () => shares.get(daemon)?.stop(),
  }));
  host.rpc(
    "session.share.",
    [
      "session.share.create.request",
      "session.share.stop.request",
      "session.share.kick.request",
      "session.share.respond.request",
      "session.share.set_options.request",
      "session.share.list.request",
    ],
    (services) => {
      const service = shares.get(services.daemon);
      const share = service
        ? new SessionShareSession({
            host: { emit: services.push },
            sessionShareService: service,
            logger: services.logger,
          })
        : null;
      return {
        handle(msg: SessionInboundMessage) {
          if (!share) return undefined;
          switch (msg.type) {
            case "session.share.create.request":
              return share.handleCreateRequest(msg);
            case "session.share.stop.request":
              return share.handleStopRequest(msg);
            case "session.share.kick.request":
              return share.handleKickRequest(msg);
            case "session.share.respond.request":
              return share.handleRespondRequest(msg);
            case "session.share.set_options.request":
              return share.handleSetOptionsRequest(msg);
            case "session.share.list.request":
              return share.handleListRequest(msg);
            default:
              return undefined;
          }
        },
        stop() {},
      };
    },
  );
}
