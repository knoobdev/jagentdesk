import { describe, expect, it } from "vitest";

import { getJAgentDeskToolLeafName, isJAgentDeskToolName } from "@jagentdesk/protocol/tool-name-normalization";

describe("isJAgentDeskToolName", () => {
  it("detects Claude Code format", () => {
    expect(isJAgentDeskToolName("mcp__jagentdesk__create_agent")).toBe(true);
    expect(isJAgentDeskToolName("mcp__jagentdesk__list_agents")).toBe(true);
  });

  it("detects jagentdesk_voice variant", () => {
    expect(isJAgentDeskToolName("mcp__jagentdesk_voice__create_agent")).toBe(true);
    expect(isJAgentDeskToolName("jagentdesk_voice.create_agent")).toBe(true);
  });

  it("excludes speak tools", () => {
    expect(isJAgentDeskToolName("mcp__jagentdesk_voice__speak")).toBe(false);
    expect(isJAgentDeskToolName("mcp__jagentdesk__speak")).toBe(false);
    expect(isJAgentDeskToolName("jagentdesk.speak")).toBe(false);
  });

  it("detects Codex dot format", () => {
    expect(isJAgentDeskToolName("jagentdesk.create_agent")).toBe(true);
  });

  it("rejects non-jagentdesk tools", () => {
    expect(isJAgentDeskToolName("Bash")).toBe(false);
    expect(isJAgentDeskToolName("Read")).toBe(false);
    expect(isJAgentDeskToolName("mcp__other_server__some_tool")).toBe(false);
  });
});

describe("getJAgentDeskToolLeafName", () => {
  it("extracts leaf from Claude Code format", () => {
    expect(getJAgentDeskToolLeafName("mcp__jagentdesk__create_agent")).toBe("create_agent");
  });

  it("extracts leaf from Codex format", () => {
    expect(getJAgentDeskToolLeafName("jagentdesk.create_agent")).toBe("create_agent");
    expect(getJAgentDeskToolLeafName("jagentdesk.list_agents")).toBe("list_agents");
  });

  it("returns null for non-jagentdesk tools", () => {
    expect(getJAgentDeskToolLeafName("Bash")).toBeNull();
  });
});
