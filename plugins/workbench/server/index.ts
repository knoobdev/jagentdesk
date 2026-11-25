import {
  staticHostSupport,
  type BuiltinServerHost,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { registerProxyTools } from "./agent-tools.js";
import { getSharedProxyService } from "./proxy/proxy-service.js";
import { WorkbenchSession } from "./session.js";

const PROXY_REQUESTS = [
  "proxy/ca/export",
  "proxy/capture/start",
  "proxy/capture/stop",
  "proxy/frida/install",
  "proxy/frida/status",
  "proxy/history/clear",
  "proxy/history/query",
  "proxy/intercept/decide",
  "proxy/intercept/set",
  "proxy/intruder/run",
  "proxy/repeater/send",
  "proxy/scope/get",
  "proxy/scope/set",
  "proxy/session/remove",
  "proxy/sessions/list",
  "proxy/subscribe",
  "proxy/transaction/annotate",
  "proxy/transaction/delete",
  "proxy/transaction/get",
  "proxy/unsubscribe",
] as const;

export function register(host: BuiltinServerHost) {
  // The capture store is daemon-wide (getSharedProxyService); disable stops every capture.
  host.backgroundService(() => ({
    start() {},
    stop: () => getSharedProxyService().disposeAll(),
  }));
  host.rpc("proxy/", PROXY_REQUESTS, (services) => new WorkbenchSession(services));
  // The agent drives the same capture sessions and store the human UI shows. Spec 24.5: only
  // capture modes this host can run are offered.
  host.agentTools(
    (registerTool, context) =>
      registerProxyTools({
        registerTool,
        support: staticHostSupport(process.platform, process.arch),
        simulatorInstaller: context.provided("devices.simulator-installer"),
      }),
    { slot: "late" },
  );
}
