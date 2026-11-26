// Spec 29.4: while JAgentDesk has a Jira connection, agents use its `jira_*` tools, and the
// host setting "Hide the provider's own Jira/Atlassian connectors from agents" removes the
// provider's duplicate connectors from launches where the provider's CLI supports it.

export const ATLASSIAN_CONNECTOR_FAMILY = "atlassian";

/** Atlassian's hosted MCP server; claude.ai's Atlassian connector proxies to it. */
const ATLASSIAN_MCP_URL_PATTERN = "https://mcp.atlassian.com/*";

/**
 * Claude Code `deniedMcpServers` entries (settings; merged from every settings source, flag
 * settings included). A `serverName` of `claude.ai <name>` blocks that claude.ai connector, and a
 * `serverUrl` entry also matches the `mcp_url` a claude.ai connector proxies to.
 */
export function claudeDeniedConnectorServers(
  families: readonly string[],
): Array<{ serverName: string } | { serverUrl: string }> {
  if (!families.includes(ATLASSIAN_CONNECTOR_FAMILY)) return [];
  return [
    { serverName: "claude.ai Atlassian" },
    { serverName: "claude.ai Atlassian MCP" },
    { serverUrl: ATLASSIAN_MCP_URL_PATTERN },
  ];
}

/** Server-level `disallowedTools` rules for the same connectors, for Claude Code builds that ignore the setting. */
export function claudeDisallowedConnectorTools(families: readonly string[]): string[] {
  if (!families.includes(ATLASSIAN_CONNECTOR_FAMILY)) return [];
  return ["mcp__claude_ai_Atlassian", "mcp__claude_ai_Atlassian_MCP"];
}

export function isAtlassianMcpServer(name: string, url: string | null): boolean {
  if (/atlassian|jira/i.test(name)) return true;
  if (!url) return false;
  try {
    const host = new URL(url).host.toLowerCase();
    return host === "mcp.atlassian.com" || host.endsWith(".atlassian.net");
  } catch {
    return false;
  }
}

/**
 * Codex `-c` overrides that turn off the user's own Atlassian/Jira MCP servers for this launch.
 * `servers` is the user's `mcp_servers` table from config.toml; JAgentDesk's own servers are
 * never in it.
 */
export function codexHiddenConnectorArgs(
  families: readonly string[],
  servers: Record<string, { url?: unknown }>,
): string[] {
  if (!families.includes(ATLASSIAN_CONNECTOR_FAMILY)) return [];
  // `-c` splits its key on dots, so only plain table names can be addressed.
  return Object.entries(servers)
    .filter(
      ([name, server]) =>
        /^[A-Za-z0-9_-]+$/.test(name) &&
        isAtlassianMcpServer(name, typeof server.url === "string" ? server.url : null),
    )
    .flatMap(([name]) => ["-c", `mcp_servers.${name}.enabled=false`]);
}

/**
 * The `[mcp_servers.<name>]` tables of a Codex config.toml with their `url`, read line by line:
 * enough to find Atlassian servers without a TOML parser.
 */
export function readCodexMcpServerTables(toml: string): Record<string, { url?: string }> {
  const servers: Record<string, { url?: string }> = {};
  let current: string | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const table = line.match(/^\[\s*mcp_servers\.("?)([A-Za-z0-9_-]+)\1\s*\]$/);
    if (table?.[2]) {
      current = table[2];
      servers[current] ??= {};
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    const url = current ? line.match(/^url\s*=\s*"([^"]*)"/) : null;
    if (current && url?.[1]) servers[current] = { url: url[1] };
  }
  return servers;
}
