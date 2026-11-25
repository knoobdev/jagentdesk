import type { BuiltinServerHost } from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { registerBrowserProfileTools } from "./profile-tools.js";
import { registerBrowserTools } from "./tools.js";

export function register(host: BuiltinServerHost) {
  // Agentic browser tools (browser_*) over the core browser broker, plus the anti-detect
  // fingerprint profile tools. The broker, its client registration and screenshots stay core.
  host.agentTools((registerTool, context) => {
    if (!context?.browser.enabled) return;
    const { broker, fingerprintProfiles } = context.browser;
    if (broker) {
      registerBrowserTools({
        registerTool,
        broker,
        callerAgentId: context.callerAgentId ?? undefined,
        resolveCallerAgent: context.resolveCallerAgent,
      });
    }
    if (fingerprintProfiles) registerBrowserProfileTools(registerTool, fingerprintProfiles);
  });
}
