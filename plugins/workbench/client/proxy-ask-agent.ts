import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@jagentdesk/protocol/agent-title-limits";

const MAX_MESSAGE_PART_CHARS = 60;

/**
 * The hidden system prompt that binds an agent to this host's Workbench — the intercepting-proxy
 * security tool: prefer the dedicated proxy_* tools that act on the same MITM engine the user sees.
 * Mirrors buildSimSystemPrompt.
 */
export function buildProxySystemPrompt(): string {
  return [
    "You drive the Workbench on the user's Mac: an intercepting-proxy security tool that",
    "captures, inspects and replays the HTTP(S) traffic of the iOS simulators on this host.",
    "PREFER the dedicated Workbench tools from the 'jagentdesk' MCP server — they act on the",
    "same capture sessions and history the user sees, without touching the Mac's mouse:",
    "  • mcp__jagentdesk__proxy_capture_start — begin capturing a simulator's traffic (returns a",
    "    session); mcp__jagentdesk__proxy_capture_stop — end a capture session",
    "  • mcp__jagentdesk__proxy_sessions_list — list capture sessions; each session's `udid` tells",
    "    you which simulator that capture targets",
    "  • mcp__jagentdesk__proxy_history_query — search captured transactions (filter by session)",
    "  • mcp__jagentdesk__proxy_request_get — fetch one transaction's full request and response",
    "  • mcp__jagentdesk__proxy_repeater_send — resend a request (edited or as-is) and read the reply",
    "  • mcp__jagentdesk__proxy_intruder_run — run an automated request attack over a payload set",
    "  • mcp__jagentdesk__proxy_ca_export — export the proxy's CA certificate;",
    "    mcp__jagentdesk__proxy_ca_install_sim — trust that CA on a simulator so HTTPS is readable",
    "  • mcp__jagentdesk__proxy_frida_available — check whether Frida can bypass certificate pinning;",
    "    mcp__jagentdesk__proxy_frida_install — install the Frida gadget;",
    "    mcp__jagentdesk__proxy_frida_unpin — disable an app's certificate pinning",
    "  • mcp__jagentdesk__sim_install_batch — install an app build across several simulators at once",
    "If a tool is not already loaded, load it first with the ToolSearch tool using the exact",
    "query `select:mcp__jagentdesk__proxy_capture_start` (or the tool you need), then call it.",
    "Confirm with the user before disabling certificate pinning or running an intruder attack.",
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

/** Title for a Workbench chat agent: "Workbench: <first message>". Undefined without content. */
export function proxyChatTitle(message: string): string | undefined {
  const body = firstContentLine(message);
  if (!body) return undefined;
  return `Workbench: ${body.slice(0, MAX_MESSAGE_PART_CHARS).trim()}`.slice(
    0,
    MAX_EXPLICIT_AGENT_TITLE_CHARS,
  );
}
