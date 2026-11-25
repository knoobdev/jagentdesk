import { staticHostSupport } from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import type {
  BuiltinCoreServices,
  BuiltinServerHost,
  BuiltinSessionContribution,
  BuiltinSessionServices,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { registerSimulatorTools } from "./agent-tools.js";
import { clearGrantsWhenSessionsEnd } from "./devices/agent-grants.js";
import { PhysicalDeviceHub } from "./devices/hub.js";
import { createSideloadDeviceSigner } from "./devices/sideload-signer.js";
import { createSideloadAgentTools } from "./sideload/agent-tools.js";
import { SideloadService } from "./sideload/sideload-service.js";
import { SideloadSession } from "./sideload-session.js";
import { DevicesSession } from "./session.js";
import { SimulatorService } from "./simulator/simulator-service.js";

// The 26.12.4 acceptance run shortens the Sideload refresh cycle with these; not user settings.
function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
function positiveEnvNumber(name: string): number | undefined {
  const value = envNumber(name);
  return value !== undefined && value > 0 ? value : undefined;
}

/**
 * Spec 27 / ADR-0033: one owner for physical phones and tablets, shared by every client session
 * and every agent's sim_* tools. Prepare device signs WebDriverAgent with a Sideload Apple
 * account (spec 26). Sideload (ADR-0032) owns accounts, signing, installs and the hourly refresh
 * job; its secrets stay in <home>/sideload, and prompts, progress and notices fan out to every
 * client.
 */
class DevicesDaemon {
  readonly physicalDevices: PhysicalDeviceHub;
  readonly sideload: SideloadService;
  constructor(core: BuiltinCoreServices) {
    this.physicalDevices = new PhysicalDeviceHub({
      jagentdeskHome: core.home,
      logger: core.logger,
      signer: createSideloadDeviceSigner(() => this.sideload),
    });
    // An agent's device grants end with its provider session (spec 27.6).
    if (core.daemonHooks.subscribeAgentEvents)
      clearGrantsWhenSessionsEnd(core.daemonHooks.subscribeAgentEvents, this.physicalDevices);
    this.sideload = new SideloadService({
      jagentdeskHome: core.home,
      logger: core.logger,
      broadcast: (message) => core.daemonHooks.broadcast?.(message),
      pushNotification: (notice) => core.daemonHooks.pushNotification?.(notice),
      refreshIntervalMs: positiveEnvNumber("JAGENTDESK_SIDELOAD_REFRESH_INTERVAL_MS"),
      clockOffsetMs: envNumber("JAGENTDESK_SIDELOAD_CLOCK_OFFSET_MS"),
    });
  }
  start() {
    return this.sideload.initialize();
  }
  stop() {
    this.sideload.dispose();
    this.physicalDevices.dispose();
  }
}

const SIMULATOR_REQUESTS = [
  "simulator/action",
  "simulator/button",
  "simulator/catalog",
  "simulator/create",
  "simulator/describe-ui",
  "simulator/input-text",
  "simulator/install-app",
  "simulator/install-batch",
  "simulator/launch-app",
  "simulator/list",
  "simulator/logs/subscribe",
  "simulator/logs/unsubscribe",
  "simulator/open-url",
  "simulator/physical/disable",
  "simulator/physical/enable",
  "simulator/physical/prepare",
  "simulator/screen/subscribe",
  "simulator/screen/unsubscribe",
  "simulator/screenshot",
  "simulator/slim",
  "simulator/subscribe",
  "simulator/swipe",
  "simulator/tap",
  "simulator/terminate-app",
  "simulator/unslim",
  "simulator/unsubscribe",
] as const;
const SIDELOAD_REQUESTS = [
  "sideload.accounts.add.request",
  "sideload.accounts.list.request",
  "sideload.accounts.remove.request",
  "sideload.accounts.set_anisette.request",
  "sideload.accounts.set_keep_signed_in.request",
  "sideload.app_ids.list.request",
  "sideload.apps.forget.request",
  "sideload.apps.list.request",
  "sideload.apps.refresh.request",
  "sideload.apps.refresh_all.request",
  "sideload.apps.uninstall.request",
  "sideload.auth.respond.request",
  "sideload.certs.list.request",
  "sideload.certs.revoke.request",
  "sideload.devices.list.request",
  "sideload.export.start.request",
  "sideload.host.browse.request",
  "sideload.install.cancel.request",
  "sideload.install.start.request",
  "sideload.ipa.inspect.request",
  "sideload.ipa.upload.request",
] as const;

export function register(host: BuiltinServerHost) {
  const daemon = host.backgroundService((core) => new DevicesDaemon(core));
  host.rpc(
    "simulator/",
    SIMULATOR_REQUESTS,
    (services) => new DevicesSession(services, services.service(daemon)?.physicalDevices ?? null),
  );
  const sideloadSession = (services: BuiltinSessionServices): BuiltinSessionContribution => {
    const sideload = services.service(daemon)?.sideload;
    if (!sideload)
      return {
        handle() {
          throw new Error("Sideload is not running on this daemon");
        },
        stop() {},
      };
    const session = new SideloadSession({
      emit: (message) => services.push(message),
      service: sideload,
      logger: services.logger,
    });
    return { handle: (message) => session.handle(message), stop() {} };
  };
  host.rpc("sideload.", SIDELOAD_REQUESTS, sideloadSession);
  host.rpc("android.", ["android.install.start.request"], sideloadSession);
  // Installs raise a permission card (spec 26.10).
  host.agentTools(
    (registerTool, context) => {
      const sideload = context.service(daemon)?.sideload;
      if (!sideload) return;
      for (const tool of createSideloadAgentTools({
        service: sideload,
        callerAgentId: context.callerAgentId,
        requestPermission: context.requestPermission,
      }))
        registerTool(
          tool.name,
          { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
          tool.handler,
        );
    },
    { slot: "accounts" },
  );
  host.agentTools(
    (registerTool, context) => {
      const hub = context.service(daemon)?.physicalDevices ?? null;
      // Spec 24.5: tools a host cannot run are not offered. Spec 27.6: physical devices
      // (adb/go-ios run on every host OS) keep sim_* registered off macOS.
      const support = staticHostSupport(process.platform, process.arch);
      if (!support.iosSimulators && !hub) return;
      registerSimulatorTools({
        registerTool,
        iosSimulators: support.iosSimulators,
        access: {
          hub,
          callerAgentId: context.callerAgentId ?? undefined,
          agentTitle: () => context.callerAgentTitle() ?? "this agent",
          requestPermission: context.requestPermission,
        },
      });
    },
    { slot: "late" },
  );
  // Workbench's sim_install_batch installs through the same simulator control plane.
  const simulatorInstaller = new SimulatorService();
  host.provide("devices.simulator-installer", () => simulatorInstaller);
}
