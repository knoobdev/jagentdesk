/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return { ...actual, useIsCompactFormFactor: () => false };
});

vi.mock("./tool-call-sheet", () => ({
  useToolCallSheet: () => ({ openToolCall: vi.fn(), closeToolCall: vi.fn() }),
}));

// react-native-markdown-display and expo-clipboard ship JSX in .js files, which Vite
// cannot parse here; the ToolCall row itself never renders markdown or uses the clipboard.
vi.mock("react-native-markdown-display", () => ({ default: () => null }));
vi.mock("@/components/markdown/renderer", () => ({ MarkdownRenderer: () => null }));
// attachment-pill-content.tsx evaluates JSX icons at module scope with the classic runtime.
vi.mock("@/attachments/attachment-pill-content", () => ({
  getAgentAttachmentPillContent: () => null,
  getWorkspaceAttachmentPillContent: () => null,
}));
vi.mock("expo-clipboard", () => ({
  ClipboardPasteButton: () => null,
  setStringAsync: vi.fn(),
  setString: vi.fn(),
  getStringAsync: vi.fn(),
  hasStringAsync: vi.fn(),
}));
vi.mock("@/utils/rich-clipboard", () => ({
  writeMarkdownToRichClipboard: vi.fn(),
}));
vi.mock("@/utils/rich-clipboard-default-environment", () => ({
  getDefaultMarkdownClipboardEnvironment: () => null,
}));

import { ToolCall } from "./message";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
}

async function mountAsync(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const SERVER_ID = "srv_e4e910a0a4ab";

function sshRunResult(overrides: Record<string, unknown> = {}) {
  return {
    serverId: SERVER_ID,
    stdout: "Linux pc 6.1.0\n",
    stderr: "",
    exitCode: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

function sshRunDetail(
  output: unknown,
  input: unknown = { command: "uname -a", serverId: SERVER_ID },
): ToolCallDetail {
  return { type: "unknown", input, output };
}

function fakeClient(servers: Array<{ id: string; label: string }>): DaemonClient {
  return {
    sshServersList: async () => ({ servers, groups: [], identities: [], sessions: [] }),
  } as unknown as DaemonClient;
}

describe("ToolCall inline ssh_run card (spec 33.9)", () => {
  it("renders a completed ssh_run call as the card, replacing the collapsed badge row", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_ssh_run"
        status="completed"
        detail={sshRunDetail(sshRunResult())}
      />,
    );
    expect(document.querySelector('[data-testid="ssh-run-card"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="remote-job-output-box"]')).not.toBeNull();
    expect(document.body.textContent).toContain("uname -a");
    // Label falls back to the raw serverId when no server list is available (client null).
    expect(document.body.textContent).toContain(SERVER_ID);
    // The collapsed badge row is replaced, not stacked under the card.
    expect(document.querySelector('[data-testid="tool-call-badge"]')).toBeNull();
  });

  it("keeps the collapsed badge row for a pending ssh_run call", () => {
    mount(<ToolCall toolName="jagentdesk_ssh_run" status="running" />);
    expect(document.querySelector('[data-testid="tool-call-badge"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ssh-run-card"]')).toBeNull();
  });

  it("keeps the collapsed badge row for a malformed result", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_ssh_run"
        status="completed"
        detail={sshRunDetail("denied by user")}
      />,
    );
    expect(document.querySelector('[data-testid="tool-call-badge"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ssh-run-card"]')).toBeNull();
  });

  it("shows the exit code and no stderr box for a clean exit", () => {
    mount(
      <ToolCall
        toolName="mcp__jagentdesk__ssh_run"
        status="completed"
        detail={sshRunDetail(sshRunResult({ exitCode: 0 }))}
      />,
    );
    expect(document.body.textContent).toContain("ssh.remoteExec.job.exitCode");
    expect(document.body.textContent).not.toContain("ssh.remoteExec.sshRun.stderr");
    expect(document.body.textContent).not.toContain("ssh.remoteExec.sshRun.outputTruncated");
  });

  it("shows a separate labelled stderr box only when stderr is non-empty", () => {
    const stderr = "ls: cannot access '/x': No such file or directory";
    mount(
      <ToolCall
        toolName="jagentdesk.ssh_run"
        status="completed"
        detail={sshRunDetail(sshRunResult({ exitCode: 2, stderr }))}
      />,
    );
    expect(document.body.textContent).toContain("ssh.remoteExec.sshRun.stderr");
    expect(document.body.textContent).toContain(stderr);
    expect(document.querySelector('[data-testid="ssh-run-stderr-box"]')).not.toBeNull();
  });

  it("shows Timed out and no exit-code line when the command timed out", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_ssh_run"
        status="completed"
        detail={sshRunDetail(sshRunResult({ timedOut: true, exitCode: null }))}
      />,
    );
    expect(document.body.textContent).toContain("ssh.remoteExec.sshRun.timedOut");
    expect(document.body.textContent).not.toContain("ssh.remoteExec.job.exitCode");
  });

  it("shows the signal instead of an exit code when the command was killed", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_ssh_run"
        status="completed"
        detail={sshRunDetail(sshRunResult({ exitCode: null, signal: "SIGKILL" }))}
      />,
    );
    expect(document.body.textContent).toContain("ssh.remoteExec.sshRun.signal");
  });

  it("shows the Output truncated note when a stream was cut", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_ssh_run"
        status="completed"
        detail={sshRunDetail(sshRunResult({ stdoutTruncated: true }))}
      />,
    );
    expect(document.body.textContent).toContain("ssh.remoteExec.sshRun.outputTruncated");
  });

  it("looks the server label up by serverId and falls back to the id", async () => {
    await mountAsync(
      <ToolCall
        toolName="jagentdesk_ssh_run"
        status="completed"
        detail={sshRunDetail(sshRunResult())}
        client={fakeClient([
          { id: "srv_other", label: "Other" },
          { id: SERVER_ID, label: "PC WSL2" },
        ])}
      />,
    );
    await act(async () => {});
    expect(document.body.textContent).toContain("PC WSL2");
    expect(document.body.textContent).not.toContain(SERVER_ID);
  });

  it("falls back to the serverId when the list has no matching server", async () => {
    await mountAsync(
      <ToolCall
        toolName="jagentdesk_ssh_run"
        status="completed"
        detail={sshRunDetail(sshRunResult())}
        client={fakeClient([])}
      />,
    );
    await act(async () => {});
    expect(document.body.textContent).toContain(SERVER_ID);
  });

  it("caps the command at 3 lines and keeps the full text in the accessibility label", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_ssh_run"
        status="completed"
        detail={sshRunDetail(sshRunResult(), { command: "echo one && echo two && echo three" })}
      />,
    );
    const command = document.querySelector<HTMLElement>(
      '[data-testid="ssh-run-card"] [aria-label]',
    );
    expect(command).not.toBeNull();
    expect(command?.getAttribute("aria-label")).toBe("echo one && echo two && echo three");
    expect(command?.style.whiteSpace).toBe("pre-wrap");
    expect(command?.style.overflowWrap).toBe("anywhere");
  });
});
