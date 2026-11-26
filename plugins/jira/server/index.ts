import { JIRA_REQUEST_TYPES } from "@jagentdesk/protocol/jira/rpc-schemas";
import type {
  BuiltinServerHost,
  BuiltinSessionContribution,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { createJiraAgentTools, jiraAgentInstruction } from "./agent-tools.js";
import { pollJiraBotTriggers } from "./bot-triggers.js";
import { atlassianEndpointsFromEnv } from "./credentials.js";
import { JiraService } from "./service.js";
import { JiraSession } from "./session.js";

/** The daemon-wide Jira service (spec 29 / ADR-0034 §4): one credential manager for every
 * session, view watch, agent tool and bot trigger. Secrets stay under <home>/jira. */
class JiraDaemon {
  readonly service: JiraService;
  readonly ready: Promise<void>;
  constructor(options: {
    home: string;
    logger: ConstructorParameters<typeof JiraService>[0]["logger"];
  }) {
    this.service = new JiraService({
      jagentdeskHome: options.home,
      endpoints: atlassianEndpointsFromEnv(process.env),
      logger: options.logger,
    });
    // Connections load once at boot, whether or not the plugin starts enabled.
    this.ready = this.service.initialize();
    this.ready.catch(() => undefined);
  }
  start() {
    return this.ready;
  }
  stop() {
    this.service.dispose();
  }
}

function unavailable(): BuiltinSessionContribution {
  return {
    handle() {
      throw new Error("Jira service is not running on this daemon");
    },
    stop() {},
  };
}

export function register(host: BuiltinServerHost) {
  const daemon = host.backgroundService(
    (core) => new JiraDaemon({ home: core.home, logger: core.logger }),
  );
  // Eager: desktop sign-in delegation listens for jira.oauth.delegation before any request.
  host.rpc(
    "jira.",
    JIRA_REQUEST_TYPES,
    (services) => {
      const jira = services.service(daemon);
      if (!jira) return unavailable();
      const session = new JiraSession({
        service: jira.service,
        emit: (message) => services.push(message),
        logger: services.logger,
      });
      return {
        handle: (message) => session.handle(message as Parameters<JiraSession["handle"]>[0]),
        start: () => session.start(),
        stop: () => session.stop(),
      };
    },
    { eager: true },
  );
  // Reads auto-run; writes raise the permission card (spec 29.4).
  host.agentTools(
    (registerTool, context) => {
      const jira = context.service(daemon);
      if (!jira) return;
      for (const tool of createJiraAgentTools({
        service: jira.service,
        callerAgentId: context.callerAgentId,
        requestPermission: (agentId, request) => context.requestPermission(agentId, request),
      }))
        registerTool(
          tool.name,
          { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
          tool.handler,
        );
    },
    { slot: "integrations" },
  );
  // Spec 29.4: agents prefer jira_* over the provider's own Jira/Atlassian connector.
  host.agentLaunchHints(({ service }) => {
    const jira = service(daemon);
    if (!jira) return null;
    const sites = jira.service
      .listConnections()
      .filter((connection) => connection.authState === "connected")
      .map((connection) => connection.siteUrl.replace(/\/+$/, ""));
    if (sites.length === 0) return null;
    return {
      instructions: [jiraAgentInstruction(sites)],
      replacesProviderConnectors: ["atlassian"],
    };
  });
  host.botTriggerSource({
    name: "jira",
    async poll(bot, context) {
      const jira = context.service(daemon);
      if (!jira) return [];
      await jira.ready;
      return pollJiraBotTriggers(bot, { ...context, service: jira.service });
    },
  });
}
