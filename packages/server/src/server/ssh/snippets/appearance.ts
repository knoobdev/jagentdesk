import type { SshTerminalAppearance } from "@jagentdesk/protocol/ssh/snippets-schemas";

// Terminal theme and font size per server/group (spec 25.2 `theme?`, `fontSize?`;
// 25.4). The fields live on SshServer/SshGroup in S1's servers.json/groups.json (the
// owner spreads SshTerminalAppearanceShape into both schemas); this resolves the
// effective value up the group chain, nearest first (spec 25.2 group inheritance).

export interface AppearanceServer extends SshTerminalAppearance {
  groupId?: string;
}

export interface AppearanceGroup extends SshTerminalAppearance {
  id: string;
  parentId?: string;
}

export type AppearanceSource =
  | { kind: "server" }
  | { kind: "group"; groupId: string }
  | { kind: "default" };

export interface ResolvedTerminalAppearance {
  /** null → the client's own terminal theme applies. */
  theme: string | null;
  /** null → the client's own terminal font size applies. */
  fontSize: number | null;
  themeSource: AppearanceSource;
  fontSizeSource: AppearanceSource;
}

interface ChainEntry {
  source: AppearanceSource;
  appearance: SshTerminalAppearance;
}

export function resolveTerminalAppearance(
  server: AppearanceServer,
  groups: readonly AppearanceGroup[],
): ResolvedTerminalAppearance {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const chain: ChainEntry[] = [{ source: { kind: "server" }, appearance: server }];
  const seen = new Set<string>();
  let groupId = server.groupId;
  while (groupId && !seen.has(groupId)) {
    seen.add(groupId);
    const group = byId.get(groupId);
    if (!group) break;
    chain.push({ source: { kind: "group", groupId: group.id }, appearance: group });
    groupId = group.parentId;
  }
  const themeEntry = chain.find((entry) => entry.appearance.theme !== undefined);
  const fontEntry = chain.find((entry) => entry.appearance.fontSize !== undefined);
  return {
    theme: themeEntry?.appearance.theme ?? null,
    fontSize: fontEntry?.appearance.fontSize ?? null,
    themeSource: themeEntry?.source ?? { kind: "default" },
    fontSizeSource: fontEntry?.source ?? { kind: "default" },
  };
}
