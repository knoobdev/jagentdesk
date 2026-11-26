import { z } from "zod";
import type { AgentPermissionAction, AgentPermissionResponse } from "../agent-sdk-types.js";
import type {
  JAgentDeskToolConfig,
  JAgentDeskToolExecutionContext,
  JAgentDeskToolResult,
} from "./types.js";

/**
 * Built-in tool groups (browser tools and the spec 36 built-ins that give agents tools) seen
 * from one agent. Spec 04 §27b.2–3, ADR-0057 §5–6.
 */
export interface HostToolGroupState {
  id: string;
  name: string;
  /** The caller's runtime was opened with this group's tools. */
  launched: boolean;
  /** The host has the group on now. */
  on: boolean;
  available: boolean;
  unavailableReason?: string;
}

export interface HostToolGroups {
  list(callerAgentId: string): HostToolGroupState[];
  turnOn(id: string): Promise<void>;
}

export const TURN_ON_HOST_TOOLS_TOOL = "turn_on_host_tools";
export const BROWSER_TOOLS_GROUP_ID = "browser-tools";

const TURN_ON_ACTION: AgentPermissionAction = {
  id: "turn_on",
  label: "Turn on",
  behavior: "allow",
  variant: "primary",
};
const NOT_NOW_ACTION: AgentPermissionAction = {
  id: "not_now",
  label: "Not now",
  behavior: "deny",
  variant: "secondary",
  intent: "dismiss",
};

/** The browser built-in is "Agentic browser" in Settings; agents and the card call it Browser tools. */
export function hostToolGroupName(id: string, manifestName: string): string {
  return id === BROWSER_TOOLS_GROUP_ID ? "Browser tools" : manifestName;
}

function listGroups(groups: HostToolGroupState[]): string {
  return groups.map((group) => `${group.name} (\`${group.id}\`)`).join(", ");
}

/**
 * System instructions for one launch. The off list is built from the tool groups the runtime
 * opens with, so it stays true until the next launch.
 */
export const JAGENTDESK_TOOLS_STAY_INSTRUCTION =
  "Your JAgentDesk tools (the `jagentdesk` MCP server, or tools named `jagentdesk_*`) stay connected for the whole conversation; JAgentDesk checks them before every message. A notice that some of them are no longer available means only the tools it names changed: search for the others again before deciding a tool is missing. If a JAgentDesk tool call fails, report its error. Never tell the user that the JAgentDesk tools are disconnected or gone from this session.";

export function buildHostToolInstructions(groups: HostToolGroupState[]): string[] {
  // Spec 04 §27b.0: after a resume, Claude Code summarises removed tools as
  // "mcp__jagentdesk__* (N) no longer available", which models read as every tool being gone.
  const instructions: string[] = [JAGENTDESK_TOOLS_STAY_INSTRUCTION];
  const off = groups.filter((group) => !group.launched);
  const browserOn = groups.some((group) => group.id === BROWSER_TOOLS_GROUP_ID && group.launched);
  if (off.length) {
    instructions.push(
      [
        `JAgentDesk tool groups that are off for this conversation: ${listGroups(off)}.`,
        `When the user asks for something one of them does (for example "use the browser", "open this page" or "browser agent" for Browser tools), call the JAgentDesk tool \`${TURN_ON_HOST_TOOLS_TOOL}\` with its id right away; if your tools are deferred, find it with tool search first. The user gets a card to turn the group on, and its tools reach this same conversation with the user's next message.`,
        "Do not just say the tools are unavailable or ask the user to turn them on in Settings; the card does that. Never tell the user to open a new session, chat or agent to get tools.",
        browserOn
          ? ""
          : "While Browser tools are off, do not open web pages, HTML or PDF files in the system browser instead (no `open`, `xdg-open`, `start` or `Start-Process` with a URL or such a file); tell the user the URL or path.",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  if (browserOn) {
    instructions.push(
      [
        "Browsing: open, read and drive web pages with the JAgentDesk `browser_*` tools. Their tabs open inside the JAgentDesk app, where the user watches them.",
        "Never open an http(s) URL, an HTML file or a PDF with `open`, `xdg-open`, `start`, `Start-Process`, `explorer`, `python -m webbrowser` or any other command that launches the system browser, and do not use your own browser or Playwright tools for work the `browser_*` tools can do. To show the user a page or a local HTML/PDF file, use `browser_new_tab`.",
        'In your shell, `open`, `xdg-open` and `$BROWSER` (which dev servers such as Vite use) already send web pages and local .html/.htm/.svg/.pdf files to the JAgentDesk browser; when one prints "No JAgentDesk browser is connected", tell the user the path or URL instead of trying another way to open it.',
        "If `browser_new_tab` fails or times out, call it again or report the error; never fall back to the system browser.",
      ].join(" "),
    );
  }
  return instructions;
}

type RegisterTool = (
  name: string,
  config: JAgentDeskToolConfig,
  handler: (
    input: { toolGroup: string },
    context: JAgentDeskToolExecutionContext,
  ) => Promise<JAgentDeskToolResult>,
) => void;

type RequestPermission = (
  agentId: string,
  request: {
    name: string;
    kind: string;
    title?: string;
    description?: string;
    input?: Record<string, unknown>;
    actions?: AgentPermissionAction[];
    alwaysAsk?: boolean;
  },
) => Promise<AgentPermissionResponse>;

function text(message: string, isError = false): JAgentDeskToolResult {
  return { content: [{ type: "text", text: message }], ...(isError ? { isError: true } : {}) };
}

const NEXT_MESSAGE =
  "Its tools reach this same conversation with the user's next message: tell the user it is on and end your turn. Do not tell them to open a new session.";

export function registerHostToolGroupTools(input: {
  registerTool: RegisterTool;
  groups: HostToolGroups;
  callerAgentId: string;
  requestPermission: RequestPermission;
}): void {
  const { registerTool, groups, callerAgentId, requestPermission } = input;
  registerTool(
    TURN_ON_HOST_TOOLS_TOOL,
    {
      title: "Turn on host tools",
      description:
        "Ask the user to turn on a JAgentDesk tool group that is off for this conversation (for example `browser-tools` for the in-app browser agent). Shows the user a card; when they turn it on, the tools arrive with their next message in this same conversation.",
      inputSchema: {
        toolGroup: z
          .string()
          .min(1)
          .describe("Tool group id from the system instructions, for example browser-tools."),
      },
      // Claude Code defers MCP tools behind tool search; a model that cannot see this tool
      // tells the user the tools are unavailable instead of offering the card.
      _meta: { "anthropic/alwaysLoad": true },
    },
    async ({ toolGroup }) => {
      const all = groups.list(callerAgentId);
      const group = all.find((candidate) => candidate.id === toolGroup);
      if (!group) {
        return text(`Unknown tool group "${toolGroup}". Tool groups: ${listGroups(all)}.`, true);
      }
      if (group.launched) {
        return text(`${group.name} is already on in this conversation; use its tools.`);
      }
      if (group.on) return text(`${group.name} is on for this host. ${NEXT_MESSAGE}`);
      if (!group.available) {
        return text(
          `${group.name} can't be turned on on this host: ${group.unavailableReason ?? "it is unavailable"}.`,
          true,
        );
      }
      const response = await requestPermission(callerAgentId, {
        name: TURN_ON_HOST_TOOLS_TOOL,
        kind: "tool",
        title: `Turn on ${group.name} for this host?`,
        description: `Agents on this host get the ${group.name} tools. This conversation keeps its history.`,
        input: { toolGroup: group.id },
        actions: [NOT_NOW_ACTION, TURN_ON_ACTION],
        alwaysAsk: true,
      });
      if (response.behavior !== "allow") {
        return text(`The user kept ${group.name} off. Continue without it.`);
      }
      try {
        await groups.turnOn(group.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return text(`Turning on ${group.name} failed: ${reason}`, true);
      }
      return text(`${group.name} is now on for this host. ${NEXT_MESSAGE}`);
    },
  );
}
