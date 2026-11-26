import type { JsonValue } from "@jagentdesk/protocol/agent-types";
import { type AgentProvider } from "@jagentdesk/protocol/agent-types";
import { type WorkspaceFileTabTarget } from "@/workspace/file-open";

export interface WorkspaceDraftTabSetup {
  provider: AgentProvider;
  cwd: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  providerOptions: Record<string, unknown>;
}

export interface WorkspaceWorkingDiffTabTarget {
  kind: "working_diff";
  focusPath?: string;
  focusRequestId?: number;
}

export type PluginWorkspaceTabTarget =
  | {
      kind: "plugin";
      pluginId: string;
      panelId: string;
      context: "workspace";
    }
  | {
      kind: "plugin";
      pluginId: string;
      panelId: string;
      context: "agent";
      agentId: string;
    };

export type WorkspaceTabTarget =
  | { kind: "draft"; draftId: string; setup?: WorkspaceDraftTabSetup }
  | { kind: "agent"; agentId: string }
  | { kind: "provider_subagent"; parentAgentId: string; subagentId: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "browser"; browserId: string }
  | { kind: "files" }
  | { kind: "changes_tree" }
  | { kind: "pull_request" }
  /** Spec 40 §2: the focused agent's session ledger, in the inspector. */
  | { kind: "ledger" }
  | WorkspaceFileTabTarget
  | WorkspaceWorkingDiffTabTarget
  | PluginWorkspaceTabTarget
  /** A built-in feature's agent inspector tab (spec 41 §5 Memory); shows the inspected agent. */
  | { kind: "builtin_inspector"; tabId: string }
  | { kind: "setup"; workspaceId: string }
  | { kind: "commit_diff"; sha: string };

export interface WorkspaceTab {
  state?: JsonValue;
  tabId: string;
  target: WorkspaceTabTarget;
  createdAt: number;
}

export function buildWorkspaceTabPersistenceKey(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const serverId = input.serverId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!serverId || !workspaceId) {
    return null;
  }
  return `${serverId}:${workspaceId}`;
}
