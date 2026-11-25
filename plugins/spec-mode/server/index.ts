import { CLIENT_CAPS } from "@jagentdesk/protocol/client-capabilities";
import {
  sendPromptToAgent,
  type BuiltinDaemonContext,
  type BuiltinServerHost,
  type HostCapabilityService,
  type SessionInboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { SpecModeService } from "./service.js";
import { SpecModeSession } from "./session.js";

type SpecModeRequest = Parameters<SpecModeSession["handle"]>[0];

function hostCapabilities(context: BuiltinDaemonContext): HostCapabilityService {
  const service = context.hostCapabilities();
  if (!service) throw new Error("Host capabilities are not ready");
  return service;
}

function createSpecMode(context: BuiltinDaemonContext) {
  const { agentManager, agentStorage, logger } = context;
  const service = new SpecModeService({
    jagentdeskHome: context.home,
    logger,
    agentManager,
    hostCapabilities: {
      snapshot: () => hostCapabilities(context).snapshot(),
      refresh: () => hostCapabilities(context).refresh(),
    },
    isAutorunActive: async (agentId) =>
      (await context.port("autorun")?.isRunning(agentId)) ?? false,
    sendPrompt: async (agentId, text) => {
      await sendPromptToAgent({ agentManager, agentStorage, agentId, prompt: text, logger });
    },
    onState: (state) => {
      context.broadcast({
        type: "agent.spec_mode.state",
        payload: { agentId: state.agentId, state },
      });
    },
  });
  return { service };
}

export function register(host: BuiltinServerHost) {
  const specMode = host.daemonService(createSpecMode, ({ service }) => {
    service.stop();
  });
  // The service watches agents only while Spec mode is on.
  host.backgroundService((_services, daemon) => ({
    start: () => specMode.get(daemon)?.service.initialize(),
    stop: () => specMode.get(daemon)?.service.stop(),
  }));
  host.provide("specMode", (daemon) => specMode.get(daemon)?.service);
  host.rpc(
    "agent.spec_mode.",
    [
      "agent.spec_mode.get.request",
      "agent.spec_mode.setup.preview.request",
      "agent.spec_mode.set.request",
      "agent.spec_mode.review.request",
    ],
    (services) => {
      const service = specMode.get(services.daemon)?.service;
      const session = service
        ? new SpecModeSession({
            emit: services.push,
            specModeService: service,
            logger: services.logger,
          })
        : null;
      return {
        handle: (message: SessionInboundMessage, request) =>
          session?.handle(message as SpecModeRequest, request.supports(CLIENT_CAPS.specMode)),
        // Requests are one-shot; state reaches clients through the daemon broadcast.
        stop() {},
      };
    },
  );
}
