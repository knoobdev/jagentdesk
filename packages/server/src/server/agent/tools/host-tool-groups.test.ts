import { describe, expect, test } from "vitest";
import type { AgentPermissionResponse } from "../agent-sdk-types.js";
import {
  buildHostToolInstructions,
  JAGENTDESK_TOOLS_STAY_INSTRUCTION,
  registerHostToolGroupTools,
  TURN_ON_HOST_TOOLS_TOOL,
  type HostToolGroupState,
} from "./host-tool-groups.js";
import type { JAgentDeskToolResult } from "./types.js";

function group(overrides: Partial<HostToolGroupState> & { id: string }): HostToolGroupState {
  return {
    name: overrides.id === "browser-tools" ? "Browser tools" : overrides.id,
    launched: false,
    on: false,
    available: true,
    ...overrides,
  };
}

interface PermissionCall {
  agentId: string;
  request: Record<string, unknown>;
}

function setup(input: { groups: HostToolGroupState[]; response?: AgentPermissionResponse }) {
  const permissions: PermissionCall[] = [];
  const turnedOn: string[] = [];
  let handler: ((input: { toolGroup: string }) => Promise<JAgentDeskToolResult>) | undefined;
  let meta: Record<string, unknown> | undefined;
  registerHostToolGroupTools({
    callerAgentId: "agent-1",
    groups: {
      list: () => input.groups,
      turnOn: async (id) => {
        turnedOn.push(id);
      },
    },
    requestPermission: async (agentId, request) => {
      permissions.push({ agentId, request });
      return input.response ?? { behavior: "allow", selectedActionId: "turn_on" };
    },
    registerTool: (name, config, registered) => {
      expect(name).toBe(TURN_ON_HOST_TOOLS_TOOL);
      meta = config._meta;
      handler = (args) => registered(args, {});
    },
  });
  if (!handler) throw new Error("tool was not registered");
  const call = handler;
  const run = async (toolGroup: string) => {
    const result = await call({ toolGroup });
    return { text: result.content.map((part) => part.text).join(""), isError: result.isError };
  };
  return { run, permissions, turnedOn, meta };
}

describe("turn_on_host_tools (spec 04 §27b.2)", () => {
  test("stays loaded in Claude instead of hiding behind tool search", () => {
    expect(setup({ groups: [] }).meta).toEqual({ "anthropic/alwaysLoad": true });
  });

  test("shows the Turn on card even in an unattended mode, then turns the group on", async () => {
    const { run, permissions, turnedOn } = setup({ groups: [group({ id: "browser-tools" })] });
    const result = await run("browser-tools");

    expect(permissions).toEqual([
      {
        agentId: "agent-1",
        request: expect.objectContaining({
          title: "Turn on Browser tools for this host?",
          alwaysAsk: true,
          input: { toolGroup: "browser-tools" },
          actions: [
            expect.objectContaining({ id: "not_now", behavior: "deny" }),
            expect.objectContaining({ id: "turn_on", label: "Turn on", behavior: "allow" }),
          ],
        }),
      },
    ]);
    expect(turnedOn).toEqual(["browser-tools"]);
    expect(result.text).toContain("reach this same conversation with the user's next message");
  });

  test('the card names the group once, without a doubled "tools"', async () => {
    const browser = setup({ groups: [group({ id: "browser-tools" })] });
    await browser.run("browser-tools");
    expect(browser.permissions[0]?.request.description).toBe(
      "Agents on this host get the Browser tools. This conversation keeps its history.",
    );
    const docker = setup({ groups: [group({ id: "docker", name: "Docker" })] });
    await docker.run("docker");
    expect(docker.permissions[0]?.request.description).toBe(
      "Agents on this host get the Docker tools. This conversation keeps its history.",
    );
  });

  test("Not now keeps the group off", async () => {
    const { run, turnedOn } = setup({
      groups: [group({ id: "docker" })],
      response: { behavior: "deny", selectedActionId: "not_now" },
    });
    expect((await run("docker")).text).toContain("kept docker off");
    expect(turnedOn).toEqual([]);
  });

  test("a group the host already turned on needs no card", async () => {
    const { run, permissions } = setup({ groups: [group({ id: "browser-tools", on: true })] });
    expect((await run("browser-tools")).text).toContain("next message");
    expect(permissions).toEqual([]);
  });

  test("a group the conversation already has needs no card", async () => {
    const { run, permissions } = setup({
      groups: [group({ id: "browser-tools", on: true, launched: true })],
    });
    expect((await run("browser-tools")).text).toContain("already on");
    expect(permissions).toEqual([]);
  });

  test("an unavailable group explains why without a card", async () => {
    const { run, permissions } = setup({
      groups: [group({ id: "docker", available: false, unavailableReason: "Docker is missing" })],
    });
    const result = await run("docker");
    expect(result).toEqual({ text: expect.stringContaining("Docker is missing"), isError: true });
    expect(permissions).toEqual([]);
  });

  test("an unknown id lists the tool groups", async () => {
    const { run } = setup({ groups: [group({ id: "docker" })] });
    expect(await run("chrome")).toEqual({
      text: expect.stringContaining("`docker`"),
      isError: true,
    });
  });
});

describe("buildHostToolInstructions", () => {
  test("lists groups that are off, points at the tool and rules out a new session", () => {
    const [stay, off, ...rest] = buildHostToolInstructions([
      group({ id: "browser-tools" }),
      group({ id: "docker", launched: true }),
    ]);
    expect(stay).toBe(JAGENTDESK_TOOLS_STAY_INSTRUCTION);
    expect(off).toContain("Browser tools (`browser-tools`)");
    expect(off).not.toContain("`docker`");
    expect(off).toContain(TURN_ON_HOST_TOOLS_TOOL);
    expect(off).toContain("Never tell the user to open a new session");
    expect(off).toContain("do not open web pages, HTML or PDF files in the system browser");
    expect(rest).toEqual([]);
  });

  test("with browser tools on, forbids the system browser and provider browsers", () => {
    const instructions = buildHostToolInstructions([
      group({ id: "browser-tools", launched: true, on: true }),
    ]);
    expect(instructions).toHaveLength(2);
    expect(instructions[1]).toContain("`browser_*` tools");
    expect(instructions[1]).toContain("`open`, `xdg-open`, `start`, `Start-Process`");
    expect(instructions[1]).toContain("Playwright");
    expect(instructions[1]).toContain("never fall back to the system browser");
    // Spec 04 §27b item 3b: pages and local HTML/PDF files, not only URLs.
    expect(instructions[1]).toContain("an HTML file or a PDF");
    expect(instructions[1]).toContain("use `browser_new_tab`");
    expect(instructions[1]).toContain("No JAgentDesk browser is connected");
  });

  test("only the tools-stay rule when every group is on and browser tools are absent", () => {
    expect(buildHostToolInstructions([group({ id: "docker", launched: true })])).toEqual([
      JAGENTDESK_TOOLS_STAY_INSTRUCTION,
    ]);
  });

  test("the tools-stay rule answers Claude Code's removed-tools notice", () => {
    expect(JAGENTDESK_TOOLS_STAY_INSTRUCTION).toContain("only the tools it names changed");
    expect(JAGENTDESK_TOOLS_STAY_INSTRUCTION).toContain(
      "Never tell the user that the JAgentDesk tools are disconnected",
    );
  });
});
