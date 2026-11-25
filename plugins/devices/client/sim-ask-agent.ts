import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@jagentdesk/protocol/agent-title-limits";
import type { SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";

const MAX_MESSAGE_PART_CHARS = 60;

/**
 * The hidden system prompt that binds an agent to this host's iOS simulator fleet: prefer the
 * dedicated sim_* tools, and ground it in the fleet as the user sees it right now (which device is
 * open in the panel). Mirrors buildDatabaseSystemPrompt.
 */
export function buildSimSystemPrompt(input: {
  devices: readonly SimDevice[];
  selected: SimDevice | null;
}): string {
  const { devices, selected } = input;
  const fleet =
    devices.length > 0
      ? devices
          .map(
            (d) =>
              `  • ${d.name} (${d.deviceType}, ${d.runtime}) — ${d.isBooted ? "booted" : d.state.toLowerCase()} — udid ${d.udid}`,
          )
          .join("\n")
      : "  (no simulators yet — create one with sim_create)";
  const focus = selected
    ? `The user has "${selected.name}" (udid ${selected.udid}) open; "this device" means that one.`
    : "No device is open in the panel; ask which device when it is ambiguous.";
  return [
    "You drive the iOS simulators on the user's Mac from the SimFleet screen.",
    "Current fleet:",
    fleet,
    focus,
    "PREFER the dedicated simulator tools from the 'jagentdesk' MCP server — they act on",
    "the same devices the user sees, headless, without touching the Mac's mouse:",
    "  • mcp__jagentdesk__sim_list / sim_device_types — inspect the fleet and what can be created",
    "  • mcp__jagentdesk__sim_create — add a simulator (deviceType + runtime, optional boot)",
    "  • mcp__jagentdesk__sim_boot / sim_shutdown / sim_erase / sim_delete — lifecycle",
    "  • mcp__jagentdesk__sim_describe_ui — the element tree; tap element centers from it",
    "  • mcp__jagentdesk__sim_tap / sim_swipe / sim_type — input",
    "  • mcp__jagentdesk__sim_screenshot — look at the screen",
    "  • mcp__jagentdesk__sim_install_app / sim_launch_app / sim_terminate_app / sim_open_url — apps",
    "If a tool is not already loaded, load it first with the ToolSearch tool using the exact",
    "query `select:mcp__jagentdesk__sim_list` (or the tool you need), then call it.",
    "Confirm with the user before erasing or deleting a simulator.",
    "Wait for the user's request before taking any action.",
  ].join("\n");
}

function firstContentLine(message: string): string | null {
  const line = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const normalized = line.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

/** Title for a fleet chat agent: "Simulators: <first message>". Undefined without content. */
export function simChatTitle(message: string): string | undefined {
  const body = firstContentLine(message);
  if (!body) return undefined;
  return `Simulators: ${body.slice(0, MAX_MESSAGE_PART_CHARS).trim()}`.slice(
    0,
    MAX_EXPLICIT_AGENT_TITLE_CHARS,
  );
}
