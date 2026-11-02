import { createWorkspace, type SplitWorkspace } from "./split-layout";

export type SnippetInsertMode = "run" | "paste";

/**
 * Terminal input for a snippet (spec 25.7): "run" types the script and presses Enter,
 * "paste" types it and leaves the last line at the prompt. Line breaks become Enter
 * (`\r`), which is what a terminal sends.
 */
export function snippetTerminalInput(script: string, mode: SnippetInsertMode): string {
  const body = script.replace(/\r?\n$/, "").replace(/\r?\n/g, "\r");
  return mode === "run" ? `${body}\r` : body;
}

export interface SnippetWorkspacePlan {
  workspace: SplitWorkspace;
  /** Input to send to each pane's terminal once its connection is ready. */
  inputByPaneId: Record<string, string>;
}

export function snippetPaneId(serverId: string): string {
  return `pane_${serverId}`;
}

/**
 * "Run on many servers" as a workspace (spec 25.7, 25.16 #9): one pane per server in a
 * new workspace, each typing the snippet once connected. The owner opens an SSH
 * terminal per pane (`ssh.session.create`) and sends `inputByPaneId[pane]` to it.
 */
export function planSnippetWorkspace(params: {
  serverIds: readonly string[];
  labelsByServerId: Readonly<Record<string, string>>;
  script: string;
}): SnippetWorkspacePlan {
  const serverIds = [...new Set(params.serverIds)];
  const workspace = createWorkspace(
    serverIds.map((serverId) => ({
      id: snippetPaneId(serverId),
      target: { kind: "server", serverId },
      tabTitle: params.labelsByServerId[serverId] ?? serverId,
    })),
  );
  const input = snippetTerminalInput(params.script, "run");
  const inputByPaneId: Record<string, string> = {};
  for (const serverId of serverIds) inputByPaneId[snippetPaneId(serverId)] = input;
  return { workspace, inputByPaneId };
}
