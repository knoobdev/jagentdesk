import type { SimButton, SimUiElement } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { DeviceError } from "../../devices/errors.js";
import { isPhysicalUdid, type PhysicalDeviceHub } from "../../devices/hub.js";
import type { SimScreenshot, SimulatorService } from "../../simulator/simulator-service.js";
import type { AgentPermissionResponse } from "../agent-sdk-types.js";

// One sim_* tool surface over simulators and physical devices (spec 24.5, 27.6). A physical device
// is reachable only while its control is on, and only after the user allowed this agent once.

export interface DeviceTarget {
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  inputText(text: string): Promise<void>;
  button(button: SimButton): Promise<void>;
  describeUi(): Promise<SimUiElement[]>;
  screenshot(): Promise<SimScreenshot>;
  installApp(path: string): Promise<void>;
  launchApp(bundleId: string, terminateExisting: boolean): Promise<void>;
  terminateApp(bundleId: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  recentLogs(lines: number): Promise<string>;
}

// The model downsamples anything larger; 1568 keeps the detail it can use.
const AGENT_SCREENSHOT_MAX_DIM = 1568;

function simulatorTarget(service: SimulatorService, udid: string): DeviceTarget {
  return {
    tap: (x, y) => service.tap(udid, x, y),
    swipe: (x1, y1, x2, y2, durationMs) => service.swipe(udid, x1, y1, x2, y2, durationMs),
    inputText: (text) => service.inputText(udid, text),
    button: (button) => service.button(udid, button),
    describeUi: () => service.describeUi(udid),
    screenshot: () =>
      service.screenshot(udid, { format: "jpeg", maxDim: AGENT_SCREENSHOT_MAX_DIM }),
    installApp: (path) => service.installApp(udid, path),
    launchApp: (bundleId, terminateExisting) =>
      service.launchApp(udid, bundleId, terminateExisting),
    terminateApp: (bundleId) => service.terminateApp(udid, bundleId),
    openUrl: (url) => service.openUrl(udid, url),
    recentLogs: (lines) => service.recentLogs(udid, lines),
  };
}

// Spec 27.4: touch tools on an iPhone without WebDriverAgent prepare it with the Apple account
// saved in Sideload ("agent" caller); with none saved they answer apple_account_required.
// Screenshots, logs and apps never need WDA.
function physicalTarget(hub: PhysicalDeviceHub, udid: string): DeviceTarget {
  return {
    tap: (x, y) => hub.tap(udid, x, y, "device", "agent"),
    swipe: (x1, y1, x2, y2, durationMs) =>
      hub.swipe(udid, { x: x1, y: y1 }, { x: x2, y: y2 }, durationMs, "device", "agent"),
    inputText: (text) => hub.inputText(udid, text, "agent"),
    button: (button) => hub.button(udid, button, "agent"),
    describeUi: () => hub.describeUi(udid, "agent"),
    screenshot: () => hub.screenshot(udid, { format: "jpeg", maxDim: AGENT_SCREENSHOT_MAX_DIM }),
    installApp: (path) => hub.installApp(udid, path),
    launchApp: (bundleId, terminateExisting) => hub.launchApp(udid, bundleId, terminateExisting),
    terminateApp: (bundleId) => hub.terminateApp(udid, bundleId),
    openUrl: (url) => hub.openUrl(udid, url, "agent"),
    recentLogs: (lines) => hub.recentLogs(udid, lines),
  };
}

export type RequestDevicePermission = (
  agentId: string,
  request: {
    name: string;
    kind: string;
    title?: string;
    description?: string;
    input?: Record<string, unknown>;
  },
) => Promise<AgentPermissionResponse>;

export interface PhysicalDeviceAccess {
  hub: PhysicalDeviceHub | null;
  callerAgentId: string | undefined;
  agentTitle: () => string;
  requestPermission: RequestDevicePermission | undefined;
}

// The part of the hub that decides access.
export type DeviceAccessGate = Pick<
  PhysicalDeviceHub,
  "requireControl" | "agentDecision" | "recordAgentDecision"
>;

// Two tool calls racing on the same device share one permission card.
const pendingDecisions = new Map<string, Promise<"allow" | "deny">>();

function denied(deviceName: string): DeviceError {
  return new DeviceError(
    "denied",
    `The user did not allow this agent to control ${deviceName} in this session.`,
  );
}

// Spec 27.6: control must be on (else control_disabled); the first tool call of an agent session
// on a device raises "Allow <agent> to view and control <device>"; the answer holds for the session.
export async function authorizePhysicalDevice(
  gate: DeviceAccessGate,
  access: Omit<PhysicalDeviceAccess, "hub">,
  udid: string,
  toolName: string,
): Promise<void> {
  const { callerAgentId, requestPermission } = access;
  const device = await gate.requireControl(udid);
  // Emulators keep simulator behaviour: no card (spec 27.6 is about physical devices).
  if (device.kind !== "physical") return;
  if (!callerAgentId || !requestPermission) throw denied(device.name);
  const existing = gate.agentDecision(callerAgentId, udid);
  if (existing === "allow") return;
  if (existing === "deny") throw denied(device.name);
  const key = `${callerAgentId}\u0000${udid}`;
  let pending = pendingDecisions.get(key);
  if (!pending) {
    const agent = access.agentTitle();
    pending = requestPermission(callerAgentId, {
      name: toolName,
      kind: "tool",
      title: `Allow ${agent} to view and control ${device.name}`,
      description: `${agent} will see the screen of ${device.name}, tap, type, read its logs and manage its apps until this agent session ends. Deny blocks every device tool on it for this session.`,
      input: { udid, device: device.name, tool: toolName },
    })
      .then((response) => (response.behavior === "allow" ? ("allow" as const) : ("deny" as const)))
      .finally(() => pendingDecisions.delete(key));
    pendingDecisions.set(key, pending);
  }
  const decision = await pending;
  gate.recordAgentDecision(callerAgentId, udid, decision);
  if (decision === "deny") throw denied(device.name);
}

export async function resolveDeviceTarget(params: {
  udid: string;
  toolName: string;
  simulators: SimulatorService;
  access: PhysicalDeviceAccess;
}): Promise<DeviceTarget> {
  const { udid, toolName, simulators, access } = params;
  if (!isPhysicalUdid(udid)) return simulatorTarget(simulators, udid);
  const { hub } = access;
  if (!hub) throw new DeviceError("device_not_found", `No connected device ${udid}`);
  await authorizePhysicalDevice(hub, access, udid, toolName);
  return physicalTarget(hub, udid);
}
