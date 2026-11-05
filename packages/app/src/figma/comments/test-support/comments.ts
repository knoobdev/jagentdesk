import type { FigmaComment } from "@jagentdesk/protocol/figma/rpc-schemas";

export function comment(
  id: string,
  overrides: Partial<Omit<FigmaComment, "id">> = {},
): FigmaComment {
  return {
    id,
    parentId: overrides.parentId === undefined ? null : overrides.parentId,
    message: overrides.message ?? "message",
    user: overrides.user ?? { handle: "someone", figmaUserId: "u1" },
    createdAt_ms: overrides.createdAt_ms ?? 1_700_000_000_000,
    resolvedAt_ms: overrides.resolvedAt_ms ?? null,
    nodeId: overrides.nodeId ?? null,
    offset: overrides.offset ?? null,
    reactions: overrides.reactions ?? [],
    mine: overrides.mine ?? false,
  };
}
