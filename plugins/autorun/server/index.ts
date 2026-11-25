import type {
  BuiltinServerHost,
  SessionInboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { AutorunService } from "./service.js";
import { AutorunSession } from "./session.js";

export function register(host: BuiltinServerHost) {
  // Autonomous run (spec §20). Default OFF (ADR-0017): construction is inert; the background
  // lifecycle resumes and stops runs.
  const autorun = host.daemonService((context) => {
    const service = new AutorunService({
      jagentdeskHome: context.home,
      logger: context.logger,
      agentManager: context.agentManager,
      onUpdate: (state) => context.broadcast({ type: "autorun.stream", payload: { state } }),
      // A terminal state reaches a phone that is not watching (§14).
      onStopped: (state) => {
        const reason = state.stopReason ?? "stopped";
        context.sendPush({
          title: "Autonomous mode stopped",
          body: `${reason}${state.lastNote ? `: ${state.lastNote}` : ""}`.slice(0, 140),
          data: { agentId: state.agentId, stopReason: reason },
        });
      },
    });
    // Spec mode and autonomous mode exclude each other (spec 28.4 step 6).
    service.setStartGuard(async (agentId) =>
      (await context.port("specMode")?.isEnabled(agentId))
        ? "Turn off Spec mode to use autonomous mode"
        : null,
    );
    return service;
  });
  host.backgroundService((_services, daemon) => ({
    start: () => autorun.get(daemon)?.initialize(),
    stop: () => autorun.get(daemon)?.stop(),
  }));
  host.provide("autorun", (daemon) => {
    const service = autorun.get(daemon);
    return service
      ? { isRunning: async (agentId) => (await service.get(agentId))?.status === "running" }
      : undefined;
  });
  host.rpc(
    "autorun.",
    [
      "autorun.start.request",
      "autorun.stop.request",
      "autorun.get.request",
      "autorun.list.request",
    ],
    (services) => {
      const service = autorun.get(services.daemon);
      const session = service
        ? new AutorunSession({
            host: { emit: services.push },
            autorunService: service,
            logger: services.logger,
          })
        : null;
      return {
        handle(message: SessionInboundMessage) {
          if (!session) return undefined;
          switch (message.type) {
            case "autorun.start.request":
              return session.handleStartRequest(message);
            case "autorun.stop.request":
              return session.handleStopRequest(message);
            case "autorun.get.request":
              return session.handleGetRequest(message);
            case "autorun.list.request":
              return session.handleListRequest(message);
            default:
              return undefined;
          }
        },
        stop() {},
      };
    },
  );
}
