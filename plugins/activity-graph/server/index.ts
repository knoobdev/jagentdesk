import {
  ensureUnarchivedAgentLoaded,
  NO_SPEC_PLAN_SOURCE,
  type BuiltinServerHost,
  type SessionInboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { CLIENT_CAPS } from "@jagentdesk/protocol/client-capabilities";
import { ActivityGraphService } from "./service.js";
import { ActivityGraphSession } from "./session.js";

export function register(host: BuiltinServerHost) {
  const graphs = host.daemonService(
    (context) => {
      // Plan view with Spec mode on (spec 31.1): read through Spec mode's port per call.
      const specPlan = () => context.port("specPlan") ?? NO_SPEC_PLAN_SOURCE;
      return new ActivityGraphService({
        agents: context.agentManager,
        logger: context.logger.child({ module: "websocket-server" }),
        specPlanSource: {
          getPlan: (agentId) => specPlan().getPlan(agentId),
          subscribe: (agentId, onChange) => specPlan().subscribe(agentId, onChange),
        },
      });
    },
    (service) => service.dispose(),
  );
  host.rpc(
    "agent.activity_graph.",
    [
      "agent.activity_graph.get.request",
      "agent.activity_graph.subscribe.request",
      "agent.activity_graph.unsubscribe.request",
    ],
    (services) => {
      const service = graphs.get(services.daemon);
      const session = service
        ? new ActivityGraphSession({
            host: {
              emit: services.push,
              supportsActivityGraph: () => services.supports(CLIENT_CAPS.activityGraph),
              ensureAgentLoaded: async (agentId) => {
                await ensureUnarchivedAgentLoaded(agentId, {
                  agentManager: services.agentManager,
                  agentStorage: services.agentStorage,
                  logger: services.logger,
                });
              },
            },
            service,
            logger: services.logger,
          })
        : null;
      return {
        handle: (message: SessionInboundMessage) => session?.dispatch(message),
        // Disable and disconnect release this session's graph subscriptions.
        stop: () => session?.dispose(),
      };
    },
  );
}
