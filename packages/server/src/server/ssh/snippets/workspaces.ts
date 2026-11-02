import path from "node:path";
import { z } from "zod";
import {
  SSH_WORKSPACE_MAX_PANES,
  SshWorkspaceTemplateSchema,
  type SshLayoutNode,
  type SshWorkspaceLayout,
  type SshWorkspaceTemplate,
  type SshWorkspaceTemplateInput,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { WriteQueue, newSshId, readSecureJson, writeSecureJsonAtomic } from "./secure-file.js";

const WorkspacesFileSchema = z.array(SshWorkspaceTemplateSchema);

export class WorkspaceLayoutError extends Error {}
export class WorkspaceTemplateNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`workspace template ${id} not found`);
  }
}

const SIZE_SUM_TOLERANCE = 0.001;

/**
 * Checks the flat split tree: every node reachable exactly once from `rootId`, split
 * sizes match children and sum to 1, and at most 16 panes (spec 25.4).
 */
export function validateWorkspaceLayout(layout: SshWorkspaceLayout): void {
  const nodes = new Map<string, SshLayoutNode>();
  for (const node of layout.nodes) {
    if (nodes.has(node.id)) throw new WorkspaceLayoutError(`Duplicate node id ${node.id}`);
    nodes.set(node.id, node);
  }
  const visited = new Set<string>();
  let panes = 0;
  const pending = [layout.rootId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    const node = nodes.get(id);
    if (!node) throw new WorkspaceLayoutError(`Unknown node id ${id}`);
    if (visited.has(id)) throw new WorkspaceLayoutError(`Node ${id} appears twice`);
    visited.add(id);
    if (node.kind === "pane") {
      panes += 1;
      continue;
    }
    if (node.sizes.length !== node.children.length) {
      throw new WorkspaceLayoutError(`Split ${id} needs one size per child`);
    }
    const total = node.sizes.reduce((sum, size) => sum + size, 0);
    if (Math.abs(total - 1) > SIZE_SUM_TOLERANCE) {
      throw new WorkspaceLayoutError(`Split ${id} sizes must sum to 1`);
    }
    pending.push(...node.children);
  }
  if (visited.size !== nodes.size) throw new WorkspaceLayoutError("Layout has unreachable nodes");
  if (panes > SSH_WORKSPACE_MAX_PANES) {
    throw new WorkspaceLayoutError(`A workspace holds at most ${SSH_WORKSPACE_MAX_PANES} panes`);
  }
}

/** `workspaces.json` (spec 25.2): saved split layouts with the server of each pane. */
export class WorkspaceTemplates {
  private readonly filePath: string;
  private readonly queue = new WriteQueue();

  constructor(
    sshHome: string,
    private readonly now: () => number,
  ) {
    this.filePath = path.join(sshHome, "workspaces.json");
  }

  list(): Promise<SshWorkspaceTemplate[]> {
    return readSecureJson(this.filePath, WorkspacesFileSchema, []);
  }

  save(input: SshWorkspaceTemplateInput): Promise<SshWorkspaceTemplate> {
    return this.queue.run(async () => {
      const label = input.label.trim();
      if (label === "") throw new WorkspaceLayoutError("Workspace label is required");
      validateWorkspaceLayout(input.layout);
      const templates = await this.list();
      const existing = input.id ? templates.find((t) => t.id === input.id) : undefined;
      if (input.id && !existing) throw new WorkspaceTemplateNotFoundError(input.id);
      const now = this.now();
      const template: SshWorkspaceTemplate = {
        id: existing?.id ?? newSshId("wst"),
        label,
        layout: input.layout,
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
      };
      const next = existing
        ? templates.map((t) => (t.id === template.id ? template : t))
        : [...templates, template];
      await writeSecureJsonAtomic(this.filePath, next);
      return template;
    });
  }

  delete(id: string): Promise<void> {
    return this.queue.run(async () => {
      const templates = await this.list();
      await writeSecureJsonAtomic(
        this.filePath,
        templates.filter((t) => t.id !== id),
      );
    });
  }
}
