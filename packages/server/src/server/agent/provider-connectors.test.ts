import { describe, expect, test } from "vitest";
import {
  ATLASSIAN_CONNECTOR_FAMILY,
  claudeDeniedConnectorServers,
  claudeDisallowedConnectorTools,
  codexHiddenConnectorArgs,
  isAtlassianMcpServer,
  readCodexMcpServerTables,
} from "./provider-connectors.js";

const atlassian = [ATLASSIAN_CONNECTOR_FAMILY];

describe("provider connectors JAgentDesk Jira replaces (spec 29.4)", () => {
  test("Claude: the claude.ai Atlassian connector and Atlassian's MCP URL are denied", () => {
    expect(claudeDeniedConnectorServers(atlassian)).toEqual([
      { serverName: "claude.ai Atlassian" },
      { serverName: "claude.ai Atlassian MCP" },
      { serverUrl: "https://mcp.atlassian.com/*" },
    ]);
    expect(claudeDisallowedConnectorTools(atlassian)).toEqual([
      "mcp__claude_ai_Atlassian",
      "mcp__claude_ai_Atlassian_MCP",
    ]);
  });

  test("nothing is hidden without a replaced family", () => {
    expect(claudeDeniedConnectorServers([])).toEqual([]);
    expect(claudeDisallowedConnectorTools([])).toEqual([]);
    expect(codexHiddenConnectorArgs([], { atlassian: {} })).toEqual([]);
  });

  test("Codex: only the user's Atlassian/Jira servers are turned off", () => {
    const servers = readCodexMcpServerTables(
      [
        "[mcp_servers.node_repl]",
        'command = "node"',
        "[mcp_servers.node_repl.env]",
        'X = "1"',
        "[mcp_servers.work-tracker]",
        'url = "https://mcp.atlassian.com/v1/sse"',
        '[mcp_servers."jira"]',
        'command = "npx"',
        "[profiles.fast]",
        'url = "https://mcp.atlassian.com/ignored"',
      ].join("\n"),
    );
    expect(servers).toEqual({
      node_repl: {},
      "work-tracker": { url: "https://mcp.atlassian.com/v1/sse" },
      jira: {},
    });
    expect(codexHiddenConnectorArgs(atlassian, servers)).toEqual([
      "-c",
      "mcp_servers.work-tracker.enabled=false",
      "-c",
      "mcp_servers.jira.enabled=false",
    ]);
  });

  test("recognizes Atlassian servers by name or host", () => {
    expect(isAtlassianMcpServer("Atlassian", null)).toBe(true);
    expect(isAtlassianMcpServer("tracker", "https://acme.atlassian.net/rest")).toBe(true);
    expect(isAtlassianMcpServer("github", "https://api.githubcopilot.com/mcp")).toBe(false);
  });
});
