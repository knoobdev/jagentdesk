/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { act as rtlAct, fireEvent } from "@testing-library/react";
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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const jobResult = {
  job: {
    id: "rjb_e79658958a07",
    serverId: "srv_e4e910a0a4ab",
    serverLabel: "PC WSL2",
    workspacePath: "/tmp/ws-test",
    workspaceKey: "wsk_4ae6b3b2f45c",
    snapshotId: "snp_4a9210dd6af3",
    command: "for i in $(seq 1 20); do echo step $i; done",
    status: "running",
    exitCode: null,
    error: null,
    agentId: null,
    sync: null,
    outputBytes: 128,
    outputTruncated: false,
    createdAtMs: 0,
    startedAtMs: null,
    finishedAtMs: null,
    timeoutMs: 7_200_000,
  },
  output: "step 1\nstep 2\n",
  outputOffset: 0,
  outputTruncatedHead: false,
};

const remoteRunDetail: ToolCallDetail = {
  type: "unknown",
  input: { command: jobResult.job.command },
  output: JSON.stringify(jobResult),
};

const remoteJobWaitDetail: ToolCallDetail = {
  type: "unknown",
  input: {},
  output: {
    ...jobResult,
    job: { ...jobResult.job, status: "succeeded", exitCode: 0 },
  },
};

// A remote_job_wait can also surface while its job is still running; the compact card must
// still omit the stop button (the wait call itself cannot be stopped from here).
const remoteJobWaitRunningDetail: ToolCallDetail = {
  type: "unknown",
  input: {},
  output: jobResult,
};

const remoteStopDetail: ToolCallDetail = {
  type: "unknown",
  input: {},
  output: { ok: true },
};

describe("ToolCall inline remote job card (spec 33.9)", () => {
  it("renders a remote_run call with a job result as the job card, inline", () => {
    mount(
      <ToolCall toolName="jagentdesk_remote_run" status="completed" detail={remoteRunDetail} />,
    );
    const card = document.querySelector('[data-testid="remote-job-card"]');
    expect(card).not.toBeNull();
    expect(document.body.textContent).toContain("PC WSL2");
    expect(document.body.textContent).toContain(jobResult.job.command);
    // The collapsed badge row is replaced, not stacked under the card.
    expect(document.querySelector('[data-testid="tool-call-badge"]')).toBeNull();
  });

  it("renders an OpenCode-flavoured remote_job_wait result as the job card", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_remote_job_wait"
        status="completed"
        detail={remoteJobWaitDetail}
      />,
    );
    expect(document.querySelector('[data-testid="remote-job-card"]')).not.toBeNull();
    expect(document.body.textContent).toContain("succeeded");
  });

  it("keeps the collapsed badge row for a pending remote_run call", () => {
    mount(<ToolCall toolName="jagentdesk_remote_run" status="running" />);
    expect(document.querySelector('[data-testid="tool-call-badge"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="remote-job-card"]')).toBeNull();
  });

  it("keeps the collapsed badge row for other tools with results", () => {
    mount(<ToolCall toolName="remote_stop" status="completed" detail={remoteStopDetail} />);
    expect(document.querySelector('[data-testid="tool-call-badge"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="remote-job-card"]')).toBeNull();
  });
});

describe("ToolCall remote_job_wait compact card (spec 33.9 follow-up)", () => {
  it("collapses the output box and omits the stop button", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_remote_job_wait"
        status="completed"
        detail={remoteJobWaitRunningDetail}
      />,
    );
    // Collapsed by default: no output box until the toggle is pressed.
    expect(document.querySelector('[data-testid="remote-job-output-box"]')).toBeNull();
    expect(document.querySelector('[data-testid="remote-job-stop"]')).toBeNull();
    const toggle = document.querySelector('[data-testid="remote-job-output-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain("ssh.remoteExec.job.showOutput");
  });

  it("caps the command at 3 lines and keeps the full text in the accessibility label", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_remote_job_wait"
        status="completed"
        detail={remoteJobWaitRunningDetail}
      />,
    );
    const command = document.querySelector<HTMLElement>("[aria-label]");
    expect(command).not.toBeNull();
    // The full command stays accessible (and tooltip-able) while the visible text is capped.
    expect(command?.getAttribute("aria-label")).toBe(jobResult.job.command);
    // react-native-web's numberOfLines > 1 machinery: -webkit-box + ellipsis for the cap,
    // and our styles let the command wrap inside the card instead of overflowing.
    // (The -webkit-line-clamp: 3 value itself is set via style.setProperty, which jsdom drops.)
    expect(command?.className).toContain("r-WebkitBoxOrient");
    expect(command?.className).toContain("r-textOverflow");
    expect(command?.style.whiteSpace).toBe("pre-wrap");
    expect(command?.style.overflowWrap).toBe("anywhere");
  });

  it("expands the same output box when the toggle is pressed", () => {
    mount(
      <ToolCall
        toolName="jagentdesk_remote_job_wait"
        status="completed"
        detail={remoteJobWaitRunningDetail}
      />,
    );
    const toggle = document.querySelector('[data-testid="remote-job-output-toggle"]');
    expect(toggle).not.toBeNull();
    rtlAct(() => {
      fireEvent.click(toggle as HTMLElement);
    });
    expect(document.querySelector('[data-testid="remote-job-output-box"]')).not.toBeNull();
    expect(document.body.textContent).toContain("step 1");
    const toggleAfter = document.querySelector('[data-testid="remote-job-output-toggle"]');
    expect(toggleAfter?.textContent).toContain("ssh.remoteExec.job.hideOutput");
  });

  it("keeps the full card for remote_run: output box shown outright, no toggle", () => {
    mount(
      <ToolCall toolName="jagentdesk_remote_run" status="completed" detail={remoteRunDetail} />,
    );
    expect(document.querySelector('[data-testid="remote-job-output-box"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="remote-job-output-toggle"]')).toBeNull();
  });
});
