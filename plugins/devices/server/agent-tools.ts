import { z } from "zod";
import { SimButtonSchema, type SimButton } from "@jagentdesk/protocol/simulator/rpc-schemas";
import type {
  JAgentDeskToolResult,
  RegisterBuiltinTool,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { DeviceError } from "./devices/errors.js";
import { isPhysicalUdid } from "./devices/hub.js";
import { resolveDeviceTarget, type PhysicalDeviceAccess } from "./sim-device-target.js";
import { SimulatorService } from "./simulator/simulator-service.js";
import { fleetSnapshot } from "./simulator/simulator-streams.js";

// SimFleet — iOS Simulator control for agents. Lets an agent list/boot/drive MANY simulators
// concurrently (tap/swipe/type via idb, inspect the accessibility tree, screenshot, launch apps,
// deep-link) and slim them for density, all through the daemon's SimulatorService — the same
// control plane the human SimFleet UI uses. macOS-only; tools surface a clear error otherwise.
const simulatorToolService = new SimulatorService();

function textResult(text: string): JAgentDeskToolResult {
  return { content: [{ type: "text", text: text || "(ok)" }] };
}
function simErrorResult(err: unknown): JAgentDeskToolResult {
  if (err instanceof DeviceError) {
    return { content: [{ type: "text", text: `${err.code}: ${err.message}` }], isError: true };
  }
  const e = err as { stderr?: string; message?: string };
  return {
    content: [
      { type: "text", text: `simulator failed: ${(e.stderr || e.message || String(err)).trim()}` },
    ],
    isError: true,
  };
}

export function registerSimulatorTools(params: {
  registerTool: RegisterBuiltinTool;
  access: PhysicalDeviceAccess;
  iosSimulators: boolean;
}): void {
  const { registerTool, access } = params;
  const target = (udid: string, toolName: string) =>
    resolveDeviceTarget({ udid, toolName, simulators: simulatorToolService, access });
  // Catalog, lifecycle and density tools exist only for iOS simulators (spec 27.5); hosts without
  // Xcode do not get them.
  const registerSimulatorOnly: typeof registerTool = (name, config, handler) => {
    if (params.iosSimulators) registerTool(name, config, handler);
  };
  const refusePhysical = (udid: string, what: string) => {
    if (isPhysicalUdid(udid)) {
      throw new DeviceError(
        "unsupported_on_platform",
        `${what} is not available on physical devices`,
      );
    }
  };

  registerTool(
    "sim_list",
    {
      title: "Device list",
      description:
        "List iOS simulators and physical iPhones/iPads/Android devices on this host (udid, name, kind, runtime, state). Physical devices show connection, control (on/off) and readiness; a device with control off answers control_disabled until the user enables it in Sims. An iPhone with readiness needs_wda/wda_expired already gives screenshots; its first touch tool sets up WebDriverAgent with the Apple account saved in Sideload (apple_account_required when none is saved: ask the user to add one). bootedOnly=true limits to running/connected ones. Auto-approved (read-only).",
      inputSchema: { bootedOnly: z.boolean().optional() },
    },
    async (input: { bootedOnly?: boolean }) => {
      try {
        const { availability, devices } = await fleetSnapshot(simulatorToolService, access.hub);
        const rows = devices
          .filter((d) => !input.bootedOnly || d.isBooted)
          .map((d) => {
            const kind = d.kind ?? "simulator";
            const physical =
              kind === "simulator"
                ? ""
                : `  ${d.connection ?? "local"}  control ${d.controlEnabled ? "on" : "off"}  ${d.readiness ?? "ready"}`;
            return `${d.isBooted ? "●" : "○"} ${d.name}  (${d.deviceType})  [${d.runtime}]  ${kind}  ${d.state}${physical}  ${d.udid}`;
          });
        const notes: string[] = [];
        if (!availability.simctl) notes.push("(no Xcode/simctl on this host — no iOS simulators)");
        else if (!availability.idb && !availability.maestro) {
          notes.push("(no idb or Maestro — simulator tap/swipe/type disabled)");
        }
        return textResult([rows.join("\n") || "(no devices)", ...notes].join("\n"));
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerSimulatorOnly(
    "sim_device_types",
    {
      title: "Simulator device types",
      description:
        "List the iOS runtimes installed on this Mac and, for each, the device types that can be created on it (name + identifier). Use before sim_create. family filters to iPhone | iPad | iPod.",
      inputSchema: { family: z.enum(["iPhone", "iPad", "iPod"]).optional() },
    },
    async (input: { family?: "iPhone" | "iPad" | "iPod" }) => {
      try {
        const runtimes = await simulatorToolService.catalog();
        if (runtimes.length === 0) return textResult("(no iOS simulator runtimes installed)");
        const blocks = runtimes.map((r) => {
          const types = r.deviceTypes
            .filter((t) => !input.family || t.productFamily === input.family)
            .map((t) => `  ${t.name}  ${t.identifier}`);
          return `${r.name}  ${r.identifier}\n${types.join("\n")}`;
        });
        return textResult(blocks.join("\n\n"));
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerSimulatorOnly(
    "sim_create",
    {
      title: "Create simulator",
      description:
        "Create a new iOS simulator. deviceType and runtime accept a display name ('iPhone 15 Pro', 'iOS 17.4') or an identifier from sim_device_types; runtime defaults to the newest installed. boot=true boots it headless and waits until ready. Returns the new udid.",
      inputSchema: {
        deviceType: z.string().min(1),
        runtime: z.string().optional(),
        name: z.string().optional(),
        boot: z.boolean().optional(),
      },
    },
    async (input: { deviceType: string; runtime?: string; name?: string; boot?: boolean }) => {
      try {
        const runtimes = await simulatorToolService.catalog();
        const want = input.runtime?.trim().toLowerCase();
        const runtime = want
          ? runtimes.find(
              (r) => r.identifier.toLowerCase() === want || r.name.toLowerCase() === want,
            )
          : runtimes[0];
        if (!runtime) {
          return textResult(
            `Unknown runtime "${input.runtime ?? ""}". Installed: ${runtimes.map((r) => r.name).join(", ") || "none"}`,
          );
        }
        const wantType = input.deviceType.trim().toLowerCase();
        const type = runtime.deviceTypes.find(
          (t) => t.identifier.toLowerCase() === wantType || t.name.toLowerCase() === wantType,
        );
        if (!type) {
          return textResult(
            `"${input.deviceType}" is not available on ${runtime.name}. Call sim_device_types for the valid names.`,
          );
        }
        const name = input.name?.trim() || type.name;
        const udid = await simulatorToolService.create(
          name,
          type.identifier,
          runtime.identifier,
          input.boot ?? false,
        );
        return textResult(
          `created ${name} (${type.name}, ${runtime.name}) ${udid}${input.boot ? " — booted" : ""}`,
        );
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  const actionTool = (
    name: string,
    action: "boot" | "shutdown" | "erase" | "delete",
    description: string,
  ) =>
    registerSimulatorOnly(
      name,
      { title: name, description, inputSchema: { udid: z.string().min(1) } },
      async (input: { udid: string }) => {
        try {
          refusePhysical(input.udid, action);
          await simulatorToolService.action(input.udid, action);
          return textResult(`${action} ${input.udid} ok`);
        } catch (err) {
          return simErrorResult(err);
        }
      },
    );
  actionTool("sim_boot", "boot", "Boot an iOS simulator and wait until ready.");
  actionTool("sim_shutdown", "shutdown", "Shut down a booted iOS simulator.");
  actionTool("sim_erase", "erase", "Erase a simulator's data + settings (factory reset).");
  actionTool("sim_delete", "delete", "Delete a simulator permanently.");

  registerTool(
    "sim_tap",
    {
      title: "Simulator tap",
      description: "Tap at (x, y) in points on a simulator (needs idb or Maestro).",
      inputSchema: { udid: z.string().min(1), x: z.number(), y: z.number() },
    },
    async (input: { udid: string; x: number; y: number }) => {
      try {
        await (await target(input.udid, "sim_tap")).tap(input.x, input.y);
        return textResult(`tapped ${input.x},${input.y}`);
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_swipe",
    {
      title: "Simulator swipe",
      description:
        "Swipe from (x1,y1) to (x2,y2) in points; optional durationMs (needs idb or Maestro).",
      inputSchema: {
        udid: z.string().min(1),
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
        durationMs: z.number().int().nonnegative().optional(),
      },
    },
    async (input: {
      udid: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      durationMs?: number;
    }) => {
      try {
        await (
          await target(input.udid, "sim_swipe")
        ).swipe(input.x1, input.y1, input.x2, input.y2, input.durationMs);
        return textResult("swiped");
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_type",
    {
      title: "Simulator type text",
      description: "Type text into the focused field on a simulator (needs idb or Maestro).",
      inputSchema: { udid: z.string().min(1), text: z.string() },
    },
    async (input: { udid: string; text: string }) => {
      try {
        await (await target(input.udid, "sim_type")).inputText(input.text);
        return textResult("typed");
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_button",
    {
      title: "Simulator hardware button",
      description: "Press a hardware button: home, lock, side-button, siri, apple-pay (needs idb).",
      inputSchema: {
        udid: z.string().min(1),
        button: z.enum(["home", "lock", "side-button", "siri", "apple-pay"]),
      },
    },
    async (input: { udid: string; button: SimButton }) => {
      try {
        await (await target(input.udid, "sim_button")).button(input.button);
        return textResult(`pressed ${input.button}`);
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_describe_ui",
    {
      title: "Simulator accessibility tree",
      description:
        "Dump the on-screen accessibility elements (role, label, identifier, frame). Prefer this over screenshots to locate a control, then tap its frame center — faster and deterministic. Needs idb or Maestro. Auto-approved (read-only).",
      inputSchema: { udid: z.string().min(1) },
    },
    async (input: { udid: string }) => {
      try {
        const elements = await (await target(input.udid, "sim_describe_ui")).describeUi();
        const lines = elements.map(
          (e) =>
            `${e.role}${e.label ? ` "${e.label}"` : ""}${e.identifier ? ` #${e.identifier}` : ""} @ ${Math.round(e.x + e.width / 2)},${Math.round(e.y + e.height / 2)} [${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.width)}x${Math.round(e.height)}]${e.enabled ? "" : " (disabled)"}`,
        );
        return textResult(lines.join("\n") || "(no elements)");
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_screenshot",
    {
      title: "Simulator screenshot",
      description: "Capture the simulator screen as an image. Auto-approved (read-only).",
      inputSchema: { udid: z.string().min(1) },
    },
    async (input: { udid: string }) => {
      try {
        const shot = await (await target(input.udid, "sim_screenshot")).screenshot();
        return {
          content: [
            { type: "image", data: shot.base64, mimeType: shot.mimeType },
            { type: "text", text: "screenshot captured" },
          ],
        };
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_install_app",
    {
      title: "Simulator install app",
      description: "Install a .app bundle (absolute path) onto a booted simulator.",
      inputSchema: { udid: z.string().min(1), appPath: z.string().min(1) },
    },
    async (input: { udid: string; appPath: string }) => {
      try {
        await (await target(input.udid, "sim_install_app")).installApp(input.appPath);
        return textResult("installed");
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_launch_app",
    {
      title: "Simulator launch app",
      description: "Launch an installed app by bundle id; terminateExisting relaunches it.",
      inputSchema: {
        udid: z.string().min(1),
        bundleId: z.string().min(1),
        terminateExisting: z.boolean().optional(),
      },
    },
    async (input: { udid: string; bundleId: string; terminateExisting?: boolean }) => {
      try {
        await (
          await target(input.udid, "sim_launch_app")
        ).launchApp(input.bundleId, input.terminateExisting ?? false);
        return textResult(`launched ${input.bundleId}`);
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_terminate_app",
    {
      title: "Simulator terminate app",
      description: "Terminate a running app by bundle id.",
      inputSchema: { udid: z.string().min(1), bundleId: z.string().min(1) },
    },
    async (input: { udid: string; bundleId: string }) => {
      try {
        await (await target(input.udid, "sim_terminate_app")).terminateApp(input.bundleId);
        return textResult(`terminated ${input.bundleId}`);
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_open_url",
    {
      title: "Simulator open URL",
      description: "Open a URL / deep link on a simulator (https:// or a custom scheme).",
      inputSchema: { udid: z.string().min(1), url: z.string().min(1) },
    },
    async (input: { udid: string; url: string }) => {
      try {
        await (await target(input.udid, "sim_open_url")).openUrl(input.url);
        return textResult(`opened ${input.url}`);
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerSimulatorOnly(
    "sim_slim",
    {
      title: "Simulator slim",
      description:
        "Disable background daemons on a simulator to free RAM so more simulators fit on this Mac. reboot=true reapplies from a clean boot. Returns the new slim state.",
      inputSchema: { udid: z.string().min(1), reboot: z.boolean().optional() },
    },
    async (input: { udid: string; reboot?: boolean }) => {
      try {
        refusePhysical(input.udid, "Slim");
        const slimState = await simulatorToolService.slim(input.udid, input.reboot ?? false);
        return textResult(`slimmed → ${slimState}`);
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerSimulatorOnly(
    "sim_unslim",
    {
      title: "Simulator unslim",
      description: "Re-enable the background daemons a previous slim disabled (restore stock).",
      inputSchema: { udid: z.string().min(1) },
    },
    async (input: { udid: string }) => {
      try {
        refusePhysical(input.udid, "Unslim");
        const slimState = await simulatorToolService.unslim(input.udid);
        return textResult(`unslimmed → ${slimState}`);
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_press_button",
    {
      title: "Device hardware button",
      description:
        "Press a hardware button on a simulator or physical device. iOS: home, lock, volume-up, volume-down (simulators also side-button, siri, apple-pay). Android: home, back, app-switch, volume-up, volume-down, power, lock, rotate. A button the device lacks returns unsupported_on_platform.",
      inputSchema: { udid: z.string().min(1), button: SimButtonSchema },
    },
    async (input: { udid: string; button: SimButton }) => {
      try {
        await (await target(input.udid, "sim_press_button")).button(input.button);
        return textResult(`pressed ${input.button}`);
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "sim_logs",
    {
      title: "Device logs",
      description:
        "Read the most recent log lines of a simulator (unified log), Android device (logcat) or iPhone/iPad (syslog). lines defaults to 200 (max 2000).",
      inputSchema: {
        udid: z.string().min(1),
        lines: z.number().int().positive().max(2000).optional(),
      },
    },
    async (input: { udid: string; lines?: number }) => {
      try {
        const logs = await (await target(input.udid, "sim_logs")).recentLogs(input.lines ?? 200);
        return textResult(logs || "(no log lines)");
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );
}
