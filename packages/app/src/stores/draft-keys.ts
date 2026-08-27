import { generateMessageId } from "@/types/stream";

export const NEW_WORKSPACE_DRAFT_KEY = "new-workspace";
const NEW_WORKSPACE_FORK_DRAFT_PREFIX = `${NEW_WORKSPACE_DRAFT_KEY}:draft:`;

export function generateDraftId(): string {
  return `draft_${generateMessageId()}`;
}

export function buildNewWorkspaceDraftKey(draftId?: string): string {
  const explicitDraftId = draftId?.trim();
  if (explicitDraftId) {
    return `${NEW_WORKSPACE_FORK_DRAFT_PREFIX}${explicitDraftId}`;
  }
  return NEW_WORKSPACE_DRAFT_KEY;
}

export function isLegacyNewWorkspaceDraftKey(draftKey: string): boolean {
  return (
    draftKey.startsWith(`${NEW_WORKSPACE_DRAFT_KEY}:`) &&
    !draftKey.startsWith(NEW_WORKSPACE_FORK_DRAFT_PREFIX)
  );
}

export function buildDraftStoreKey(input: {
  serverId: string;
  agentId: string;
  draftId?: string | null;
}): string {
  const serverId = input.serverId.trim();
  const explicitDraftId = input.draftId?.trim();
  if (explicitDraftId) {
    return `draft:${serverId}:${explicitDraftId}`;
  }
  return `agent:${serverId}:${input.agentId.trim()}`;
}

/**
 * Rewrite a single draft key from an old host+agent onto the new host+agent after
 * a migration. Returns the new key when `draftKey` belongs to `oldServerId`, or
 * null when it is unaffected (a different host, or a host-agnostic key such as the
 * new-workspace draft). Agent-scoped keys additionally remap their agent id via
 * `idMap`; draft-id-scoped keys keep their draft id (it is host-agnostic).
 */
export function remapDraftKey(input: {
  draftKey: string;
  oldServerId: string;
  newServerId: string;
  idMap: Record<string, string>;
}): string | null {
  const agentPrefix = `agent:${input.oldServerId}:`;
  if (input.draftKey.startsWith(agentPrefix)) {
    const oldAgentId = input.draftKey.slice(agentPrefix.length);
    const newAgentId = input.idMap[oldAgentId] ?? oldAgentId;
    return `agent:${input.newServerId}:${newAgentId}`;
  }
  const draftPrefix = `draft:${input.oldServerId}:`;
  if (input.draftKey.startsWith(draftPrefix)) {
    const draftId = input.draftKey.slice(draftPrefix.length);
    return `draft:${input.newServerId}:${draftId}`;
  }
  return null;
}

/**
 * Remap every draft in `drafts` that belongs to `oldServerId` onto `newServerId`
 * (and, for agent-scoped drafts, onto the new agent id from `idMap`). Keys that
 * do not belong to the old host are left untouched. When a remapped key collides
 * with an existing key the existing entry wins (it is fresher on the target).
 */
export function remapDraftKeys<T>(input: {
  drafts: Record<string, T>;
  oldServerId: string;
  newServerId: string;
  idMap: Record<string, string>;
}): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [draftKey, value] of Object.entries(input.drafts)) {
    const remapped = remapDraftKey({
      draftKey,
      oldServerId: input.oldServerId,
      newServerId: input.newServerId,
      idMap: input.idMap,
    });
    if (remapped === null) {
      if (!(draftKey in next)) {
        next[draftKey] = value;
      }
      continue;
    }
    changed = true;
    if (!(remapped in next)) {
      next[remapped] = value;
    }
  }
  return changed ? next : input.drafts;
}
