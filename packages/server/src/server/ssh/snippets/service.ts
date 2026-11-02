import type {
  SshCommandHistoryEntry,
  SshCommandSource,
  SshSnippet,
  SshSnippetInput,
  SshSnippetPackage,
  SshSnippetPackageInput,
  SshSnippetRun,
  SshSnippetRunSource,
  SshSnippetRunSummary,
  SshWorkspaceTemplate,
  SshWorkspaceTemplateInput,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import type { AcquireSshClient } from "../ssh-client-lease.js";
import { CommandHistory } from "./history.js";
import { SnippetLibrary } from "./library.js";
import { SnippetRunner, type SnippetRunEvent } from "./runner.js";
import { ensureSecureDir } from "./secure-file.js";
import { WorkspaceTemplates } from "./workspaces.js";

export interface SshSnippetsServiceOptions {
  /** `$JAGENTDESK_HOME/ssh` */
  sshHome: string;
  acquire: AcquireSshClient;
  now?: () => number;
  outputCapBytes?: number;
}

export interface SnippetLibraryContents {
  packages: SshSnippetPackage[];
  snippets: SshSnippet[];
}

interface ResolvedRunSource {
  snippetId: string | null;
  label: string;
  script: string;
}

export interface RecordCommandParams {
  serverId: string;
  command: string;
  source: SshCommandSource;
}

export interface SnippetRunParams {
  source: SshSnippetRunSource;
  serverIds: readonly string[];
  timeoutMs?: number;
}

/**
 * Milestone S5 (spec 25.4, 25.7): snippet library, multi-server runs over `exec`,
 * per-server command history and workspace templates. Depends on S1 only through
 * `AcquireSshClient`.
 */
export class SshSnippetsService {
  private readonly library: SnippetLibrary;
  private readonly history: CommandHistory;
  private readonly workspaces: WorkspaceTemplates;
  private readonly runner: SnippetRunner;
  private readonly listeners = new Set<(event: SnippetRunEvent) => void>();
  private readonly ready: Promise<void>;

  constructor(options: SshSnippetsServiceOptions) {
    const now = options.now ?? Date.now;
    this.ready = ensureSecureDir(options.sshHome);
    this.library = new SnippetLibrary(options.sshHome, now);
    this.history = new CommandHistory(options.sshHome, now);
    this.workspaces = new WorkspaceTemplates(options.sshHome, now);
    this.runner = new SnippetRunner({
      acquire: options.acquire,
      now,
      outputCapBytes: options.outputCapBytes,
      emit: (event) => {
        for (const listener of this.listeners) listener(event);
      },
    });
  }

  /** Run output/state events for every client; returns the unsubscribe function. */
  subscribe(listener: (event: SnippetRunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listLibrary(): Promise<SnippetLibraryContents> {
    await this.ready;
    return this.library.list();
  }

  async saveSnippet(input: SshSnippetInput): Promise<SshSnippet> {
    await this.ready;
    return this.library.save(input);
  }

  async deleteSnippet(id: string): Promise<void> {
    await this.ready;
    await this.library.delete(id);
  }

  async savePackage(input: SshSnippetPackageInput): Promise<SshSnippetPackage> {
    await this.ready;
    return this.library.savePackage(input);
  }

  async deletePackage(id: string): Promise<void> {
    await this.ready;
    await this.library.deletePackage(id);
  }

  async run(params: SnippetRunParams): Promise<SshSnippetRun> {
    await this.ready;
    const resolved = await this.resolveSource(params.source);
    const run = this.runner.start({
      ...resolved,
      serverIds: params.serverIds,
      timeoutMs: params.timeoutMs,
    });
    await this.history.record({
      serverIds: params.serverIds,
      command: resolved.script,
      source: "snippet",
    });
    return run;
  }

  getRun(runId: string): SshSnippetRun | null {
    return this.runner.get(runId);
  }

  listRuns(): SshSnippetRunSummary[] {
    return this.runner.list();
  }

  waitForRun(runId: string): Promise<SshSnippetRun> {
    return this.runner.wait(runId);
  }

  cancelRun(runId: string, serverId?: string): void {
    this.runner.cancel(runId, serverId);
  }

  async listHistory(serverId: string): Promise<SshCommandHistoryEntry[]> {
    await this.ready;
    return this.history.list(serverId);
  }

  /**
   * Hook for the owner: call with each command a user sent to an SSH terminal
   * (from `CommandLineTracker`) or a snippet typed into an open tab.
   */
  async recordCommand(params: RecordCommandParams): Promise<void> {
    await this.ready;
    await this.history.record({
      serverIds: [params.serverId],
      command: params.command,
      source: params.source,
    });
  }

  async clearHistory(serverId: string): Promise<void> {
    await this.ready;
    await this.history.clear(serverId);
  }

  async listWorkspaces(): Promise<SshWorkspaceTemplate[]> {
    await this.ready;
    return this.workspaces.list();
  }

  async saveWorkspace(input: SshWorkspaceTemplateInput): Promise<SshWorkspaceTemplate> {
    await this.ready;
    return this.workspaces.save(input);
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.ready;
    await this.workspaces.delete(id);
  }

  async dispose(): Promise<void> {
    await this.runner.dispose();
    this.listeners.clear();
  }

  private async resolveSource(source: SshSnippetRunSource): Promise<ResolvedRunSource> {
    if (source.kind === "script") {
      const firstLine = source.script.trim().split("\n")[0] ?? "";
      return { snippetId: null, label: firstLine, script: source.script };
    }
    const snippet = await this.library.get(source.snippetId);
    return { snippetId: snippet.id, label: snippet.label, script: snippet.script };
  }
}
