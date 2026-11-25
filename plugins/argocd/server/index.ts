import { randomUUID } from "node:crypto";
import { CLIENT_CAPS } from "@jagentdesk/protocol/client-capabilities";
import { ARGOCD_INSTANCE_AGENT_LABEL } from "@jagentdesk/protocol/argocd/chat-prompt";
import type { BuiltinServerHost } from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { ArgoCdService } from "./service.js";
import { createArgoCdClusterAccess } from "./cluster-access.js";
import { createArgoCdAgentTools } from "./agent-tools.js";
import { ARGOCD_REQUEST_TYPES, ArgoCdSession } from "./argocd-session.js";

export function register(host: BuiltinServerHost) {
  // Registry + secrets under <home>/argocd, one SSE stream per instance while viewed (spec 30).
  const argocd = host.shared(
    (services) =>
      new ArgoCdService({
        jagentdeskHome: services.home,
        logger: services.logger.child({ module: "argocd" }),
        clusters: createArgoCdClusterAccess(services.clusters),
      }),
  );
  host.backgroundService((services) => {
    const service = argocd(services);
    return {
      start: () => service.initialize(),
      stop: () => service.dispose(),
    };
  });
  // Eager: instance pushes and the desktop SSO delegate must exist before the first request.
  host.rpc(
    "argocd.",
    ARGOCD_REQUEST_TYPES,
    (services) => {
      const session = new ArgoCdSession({
        host: { emit: (msg) => services.push(msg) },
        service: argocd(services),
        logger: services.logger,
        sessionKey: randomUUID(),
        canRunSsoLoopback: () => services.supportsClientCapability(CLIENT_CAPS.argocdSsoLoopback),
      });
      return {
        handle: (msg) => session.handle(msg),
        start: () => session.start(),
        stop: () => session.dispose(),
        capabilitiesChanged: () => session.syncDelegateRegistration(),
      };
    },
    { eager: true },
  );
  host.agentTools((registerTool, context) => {
    if (!context.services || !context.requestHostToolPermission) return;
    const tools = createArgoCdAgentTools({
      service: argocd(context.services),
      callerAgentId: context.callerAgentId,
      defaultInstanceId: context.callerLabels()?.[ARGOCD_INSTANCE_AGENT_LABEL] ?? null,
      requestPermission: context.requestHostToolPermission,
    });
    for (const tool of tools)
      registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
        tool.handler,
      );
  });
}
