import { describe, expect, it } from "vitest";
import type { SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { DeviceError } from "../../devices/errors.js";
import type { AgentDecision } from "../../devices/hub.js";
import type { AgentPermissionResponse } from "../agent-sdk-types.js";
import {
  authorizePhysicalDevice,
  type DeviceAccessGate,
  type RequestDevicePermission,
} from "./sim-device-target.js";

const UDID = "ios:00008110-001A2B3C4D5E6F70";
const DEVICE: SimDevice = {
  udid: UDID,
  name: "<device name>",
  state: "Connected",
  isBooted: true,
  runtime: "iOS 17.4",
  deviceType: "iPhone14,2",
  slimState: "unknown",
  platform: "ios",
  kind: "physical",
  connection: "usb",
  controlEnabled: true,
  readiness: "ready",
  osVersion: "17.4",
  model: "iPhone14,2",
};

const EMULATOR: SimDevice = {
  ...DEVICE,
  udid: "android:serial:emulator-5554",
  platform: "android",
  kind: "emulator",
  connection: null,
};

// The three hub calls authorization uses, backed by plain state (no devices involved).
function gateHub(controlEnabled: boolean, device: SimDevice = DEVICE): DeviceAccessGate {
  const decisions = new Map<string, AgentDecision>();
  return {
    requireControl: async (udid: string) => {
      if (!controlEnabled) throw new DeviceError("control_disabled", `control of ${udid} is off`);
      return device;
    },
    agentDecision: (agentId: string, udid: string) => decisions.get(`${agentId}/${udid}`) ?? null,
    recordAgentDecision: (agentId: string, udid: string, decision: AgentDecision) => {
      decisions.set(`${agentId}/${udid}`, decision);
    },
  };
}

function recordingPermission(answer: AgentPermissionResponse) {
  const requests: Parameters<RequestDevicePermission>[1][] = [];
  const request: RequestDevicePermission = async (_agentId, req) => {
    requests.push(req);
    return answer;
  };
  return { requests, request };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof DeviceError ? error.code : String(error);
  }
}

describe("physical device authorization for agents (spec 27.6)", () => {
  it("answers control_disabled without asking while control is off", async () => {
    const permission = recordingPermission({ behavior: "allow" });
    const gate = gateHub(false);
    const access = {
      callerAgentId: "agent-a1b2c3",
      agentTitle: () => "Sims agent",
      requestPermission: permission.request,
    };
    expect(await codeOf(authorizePhysicalDevice(gate, access, UDID, "sim_tap"))).toBe(
      "control_disabled",
    );
    expect(permission.requests).toHaveLength(0);
  });

  it("asks once per agent session; a denial blocks every later tool on that device", async () => {
    const permission = recordingPermission({ behavior: "deny" });
    const gate = gateHub(true);
    const access = {
      callerAgentId: "agent-a1b2c3",
      agentTitle: () => "Sims agent",
      requestPermission: permission.request,
    };
    expect(await codeOf(authorizePhysicalDevice(gate, access, UDID, "sim_tap"))).toBe("denied");
    expect(await codeOf(authorizePhysicalDevice(gate, access, UDID, "sim_screenshot"))).toBe(
      "denied",
    );
    expect(permission.requests).toEqual([
      {
        name: "sim_tap",
        kind: "tool",
        title: "Allow Sims agent to view and control <device name>",
        description:
          "Sims agent will see the screen of <device name>, tap, type, read its logs and manage its apps until this agent session ends. Deny blocks every device tool on it for this session.",
        input: { udid: UDID, device: "<device name>", tool: "sim_tap" },
      },
    ]);
  });

  it("keeps an approval for the rest of the session", async () => {
    const permission = recordingPermission({ behavior: "allow" });
    const gate = gateHub(true);
    const access = {
      callerAgentId: "agent-a1b2c3",
      agentTitle: () => "Sims agent",
      requestPermission: permission.request,
    };
    expect(await codeOf(authorizePhysicalDevice(gate, access, UDID, "sim_tap"))).toBe("ok");
    expect(await codeOf(authorizePhysicalDevice(gate, access, UDID, "sim_type"))).toBe("ok");
    expect(permission.requests).toHaveLength(1);
  });

  it("refuses physical devices outside an agent session (no card can be shown)", async () => {
    const gate = gateHub(true);
    const access = {
      callerAgentId: undefined,
      agentTitle: () => "this agent",
      requestPermission: undefined,
    };
    expect(await codeOf(authorizePhysicalDevice(gate, access, UDID, "sim_tap"))).toBe("denied");
  });

  it("never shows a card for an emulator (simulator behaviour)", async () => {
    const permission = recordingPermission({ behavior: "deny" });
    const gate = gateHub(true, EMULATOR);
    const access = {
      callerAgentId: "agent-a1b2c3",
      agentTitle: () => "Sims agent",
      requestPermission: permission.request,
    };
    expect(await codeOf(authorizePhysicalDevice(gate, access, EMULATOR.udid, "sim_tap"))).toBe(
      "ok",
    );
    expect(permission.requests).toHaveLength(0);
  });
});
