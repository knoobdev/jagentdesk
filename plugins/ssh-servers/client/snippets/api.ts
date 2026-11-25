import {
  SshHistoryClearResponseSchema,
  SshHistoryListResponseSchema,
  SshSnippetCancelResponseSchema,
  SshSnippetGetRunResponseSchema,
  SshSnippetListRunsResponseSchema,
  SshSnippetOutputEventSchema,
  SshSnippetRunResponseSchema,
  SshSnippetStateEventSchema,
  SshSnippetsDeletePackageResponseSchema,
  SshSnippetsDeleteResponseSchema,
  SshSnippetsListResponseSchema,
  SshSnippetsSavePackageResponseSchema,
  SshSnippetsSaveResponseSchema,
  SshWorkspacesDeleteResponseSchema,
  SshWorkspacesListResponseSchema,
  SshWorkspacesSaveResponseSchema,
  type SshCommandHistoryEntry,
  type SshSnippet,
  type SshSnippetInput,
  type SshSnippetOutputEvent,
  type SshSnippetPackage,
  type SshSnippetPackageInput,
  type SshSnippetRun,
  type SshSnippetRunSource,
  type SshSnippetRunSummary,
  type SshSnippetStateEvent,
  type SshWorkspaceTemplate,
  type SshWorkspaceTemplateInput,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { SshRpcError, onSshEvent, sshRequest, type SshRpcIo } from "./rpc-io";

export interface SnippetLibraryContents {
  packages: SshSnippetPackage[];
  snippets: SshSnippet[];
}

export interface SnippetRunRequest {
  source: SshSnippetRunSource;
  serverIds: string[];
  timeoutMs?: number;
}

export type SnippetRunEvent = SshSnippetOutputEvent | SshSnippetStateEvent;

/** Typed S5 RPCs for one daemon. `hostKey` scopes React Query caches per host. */
export interface SnippetsApi {
  hostKey: string;
  listLibrary(): Promise<SnippetLibraryContents>;
  saveSnippet(snippet: SshSnippetInput): Promise<SshSnippet>;
  deleteSnippet(id: string): Promise<void>;
  savePackage(pkg: SshSnippetPackageInput): Promise<SshSnippetPackage>;
  deletePackage(id: string): Promise<void>;
  run(request: SnippetRunRequest): Promise<SshSnippetRun>;
  cancelRun(runId: string, serverId?: string): Promise<void>;
  getRun(runId: string): Promise<SshSnippetRun | null>;
  listRuns(): Promise<SshSnippetRunSummary[]>;
  listHistory(serverId: string): Promise<SshCommandHistoryEntry[]>;
  clearHistory(serverId: string): Promise<void>;
  listWorkspaces(): Promise<SshWorkspaceTemplate[]>;
  saveWorkspace(template: SshWorkspaceTemplateInput): Promise<SshWorkspaceTemplate>;
  deleteWorkspace(id: string): Promise<void>;
  onRunEvent(handler: (event: SnippetRunEvent) => void): () => void;
}

function required<T>(value: T | null, requestType: string): T {
  if (value === null) throw new SshRpcError(requestType, "The host returned no result");
  return value;
}

export function createSnippetsApi(io: SshRpcIo, hostKey: string): SnippetsApi {
  return {
    hostKey,
    async listLibrary() {
      const payload = await sshRequest({
        io,
        message: { type: "ssh.snippets.list.request" },
        response: SshSnippetsListResponseSchema,
      });
      return { packages: payload.packages, snippets: payload.snippets };
    },
    async saveSnippet(snippet) {
      const payload = await sshRequest({
        io,
        message: { type: "ssh.snippets.save.request", snippet },
        response: SshSnippetsSaveResponseSchema,
      });
      return required(payload.snippet, "ssh.snippets.save.request");
    },
    async deleteSnippet(id) {
      await sshRequest({
        io,
        message: { type: "ssh.snippets.delete.request", id },
        response: SshSnippetsDeleteResponseSchema,
      });
    },
    async savePackage(pkg) {
      const payload = await sshRequest({
        io,
        message: { type: "ssh.snippets.save_package.request", package: pkg },
        response: SshSnippetsSavePackageResponseSchema,
      });
      return required(payload.package, "ssh.snippets.save_package.request");
    },
    async deletePackage(id) {
      await sshRequest({
        io,
        message: { type: "ssh.snippets.delete_package.request", id },
        response: SshSnippetsDeletePackageResponseSchema,
      });
    },
    async run(request) {
      const payload = await sshRequest({
        io,
        message: { type: "ssh.snippet.run.request", ...request },
        response: SshSnippetRunResponseSchema,
      });
      return required(payload.run, "ssh.snippet.run.request");
    },
    async cancelRun(runId, serverId) {
      await sshRequest({
        io,
        message: { type: "ssh.snippet.cancel.request", runId, ...(serverId ? { serverId } : {}) },
        response: SshSnippetCancelResponseSchema,
      });
    },
    async getRun(runId) {
      const payload = await sshRequest({
        io,
        message: { type: "ssh.snippet.get_run.request", runId },
        response: SshSnippetGetRunResponseSchema,
      });
      return payload.run;
    },
    async listRuns() {
      const payload = await sshRequest({
        io,
        message: { type: "ssh.snippet.list_runs.request" },
        response: SshSnippetListRunsResponseSchema,
      });
      return payload.runs;
    },
    async listHistory(serverId) {
      const payload = await sshRequest({
        io,
        message: { type: "ssh.history.list.request", serverId },
        response: SshHistoryListResponseSchema,
      });
      return payload.entries;
    },
    async clearHistory(serverId) {
      await sshRequest({
        io,
        message: { type: "ssh.history.clear.request", serverId },
        response: SshHistoryClearResponseSchema,
      });
    },
    async listWorkspaces() {
      const payload = await sshRequest({
        io,
        message: { type: "ssh.workspaces.list.request" },
        response: SshWorkspacesListResponseSchema,
      });
      return payload.templates;
    },
    async saveWorkspace(template) {
      const payload = await sshRequest({
        io,
        message: { type: "ssh.workspaces.save.request", template },
        response: SshWorkspacesSaveResponseSchema,
      });
      return required(payload.template, "ssh.workspaces.save.request");
    },
    async deleteWorkspace(id) {
      await sshRequest({
        io,
        message: { type: "ssh.workspaces.delete.request", id },
        response: SshWorkspacesDeleteResponseSchema,
      });
    },
    onRunEvent(handler) {
      const offOutput = onSshEvent(io, SshSnippetOutputEventSchema, handler);
      const offState = onSshEvent(io, SshSnippetStateEventSchema, handler);
      return () => {
        offOutput();
        offState();
      };
    },
  };
}
