import type { JsonValue } from "@jagentdesk/protocol/agent-types";
import type { WorkspaceTab, WorkspaceTabTarget } from "./model";
import { buildDeterministicWorkspaceTabId } from "./identity";
import { isSheetTabModified, resolveCompactSheetPolicy } from "./compact-sheet";
import { panelResourceKey, type CompactSheetPolicy } from "@/panels/panel-manifest";
import { collectAllTabs, type WorkspaceLayout } from "@/stores/workspace-layout-actions";
export type WorkspaceLayoutMode = "compact" | "single-pane" | "split-panes";
export type WorkspaceTabOpenIntent = "new" | "reveal" | "background";
export interface SheetTab {
  tab: WorkspaceTab;
  policy: CompactSheetPolicy;
  parentTabId: string | null;
}
export interface SheetState {
  layoutMode: WorkspaceLayoutMode;
  sheetsByWorkspace: Record<string, readonly SheetTab[]>;
  layoutByWorkspace: Record<string, WorkspaceLayout>;
}
const NO_SHEETS: readonly SheetTab[] = [];
function createWorkspaceTabInstanceId(): string {
  const value =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `tab_${value}`;
}

export function getSheets(
  state: Pick<SheetState, "sheetsByWorkspace">,
  workspaceKey: string,
): readonly SheetTab[] {
  return state.sheetsByWorkspace[workspaceKey] ?? NO_SHEETS;
}

export function findSheet(
  state: Pick<SheetState, "sheetsByWorkspace">,
  workspaceKey: string,
  tabId: string,
): SheetTab | undefined {
  return getSheets(state, workspaceKey).find((sheet) => sheet.tab.tabId === tabId);
}

export function withSheets(
  state: Pick<SheetState, "sheetsByWorkspace">,
  workspaceKey: string,
  sheets: readonly SheetTab[],
): Pick<SheetState, "sheetsByWorkspace"> {
  if (sheets.length > 0) {
    return { sheetsByWorkspace: { ...state.sheetsByWorkspace, [workspaceKey]: sheets } };
  }
  if (!(workspaceKey in state.sheetsByWorkspace)) {
    return { sheetsByWorkspace: state.sheetsByWorkspace };
  }
  const { [workspaceKey]: _removed, ...sheetsByWorkspace } = state.sheetsByWorkspace;
  return { sheetsByWorkspace };
}

export function withoutSheet(
  state: Pick<SheetState, "sheetsByWorkspace">,
  workspaceKey: string,
  tabId: string,
): Pick<SheetState, "sheetsByWorkspace"> {
  return withSheets(
    state,
    workspaceKey,
    getSheets(state, workspaceKey).filter((sheet) => sheet.tab.tabId !== tabId),
  );
}

export function withSheetTab(
  state: Pick<SheetState, "sheetsByWorkspace">,
  workspaceKey: string,
  tabId: string,
  update: (sheet: SheetTab) => SheetTab,
): Pick<SheetState, "sheetsByWorkspace"> {
  return withSheets(
    state,
    workspaceKey,
    getSheets(state, workspaceKey).map((sheet) =>
      sheet.tab.tabId === tabId ? update(sheet) : sheet,
    ),
  );
}

function isTargetOpenAsTab(layout: WorkspaceLayout | undefined, target: WorkspaceTabTarget) {
  if (!layout) return false;
  const resourceKey = panelResourceKey(target);
  return collectAllTabs(layout.root).some((tab) => panelResourceKey(tab.target) === resourceKey);
}

function resolveSheetPolicy(
  state: Pick<SheetState, "layoutMode" | "layoutByWorkspace">,
  workspaceKey: string,
  target: WorkspaceTabTarget,
  intent: WorkspaceTabOpenIntent,
): CompactSheetPolicy | null {
  if (state.layoutMode !== "compact" || intent === "background") return null;
  if (intent === "reveal" && isTargetOpenAsTab(state.layoutByWorkspace[workspaceKey], target)) {
    return null;
  }
  return resolveCompactSheetPolicy(workspaceKey, target);
}

/**
 * The parent a newly opened tab links to. A sheet tab is not in the layout, so a target opened
 * from inside a sheet inherits that sheet's own parent instead.
 */
export function resolveOpenParentTabId(
  state: Pick<SheetState, "sheetsByWorkspace">,
  workspaceKey: string,
  parentTabId: string | undefined,
): string | null {
  if (!parentTabId) return null;
  return findSheet(state, workspaceKey, parentTabId)?.parentTabId ?? parentTabId;
}

export function placeTargetInSheet(input: {
  /** The sheet whose tab the target keeps, if any. */
  kept: SheetTab | undefined;
  target: WorkspaceTabTarget;
  intent: WorkspaceTabOpenIntent;
  policy: CompactSheetPolicy;
  parentTabId: string | null;
  state: JsonValue | undefined;
}): SheetTab {
  if (input.kept) {
    return { ...input.kept, tab: { ...input.kept.tab, target: input.target } };
  }
  return {
    tab: {
      tabId:
        input.intent === "reveal"
          ? buildDeterministicWorkspaceTabId(input.target)
          : createWorkspaceTabInstanceId(),
      target: input.target,
      createdAt: Date.now(),
      ...(input.state !== undefined ? { state: input.state } : {}),
    },
    policy: input.policy,
    parentTabId: input.parentTabId,
  };
}

function sheetHoldsUnsavedWork(workspaceKey: string, sheet: SheetTab): boolean {
  return isSheetTabModified(workspaceKey, sheet.tab.tabId);
}

/**
 * Where an open lands among the sheet tabs, or null when it opens as a tab. A new target goes on
 * top. A reveal of a resource a sheet already shows keeps that sheet's tab and uncovers it by
 * closing the sheets above it, except ones holding unsaved work, which stay where they are.
 */
export function resolveSheetPlacement(
  state: SheetState,
  workspaceKey: string,
  target: WorkspaceTabTarget,
  intent: WorkspaceTabOpenIntent,
): { policy: CompactSheetPolicy; keptIndex: number | null } | null {
  const policy = resolveSheetPolicy(state, workspaceKey, target, intent);
  if (!policy) return null;
  if (intent !== "reveal") return { policy, keptIndex: null };
  const sheets = getSheets(state, workspaceKey);
  const resourceKey = panelResourceKey(target);
  const index = sheets.findIndex((sheet) => panelResourceKey(sheet.tab.target) === resourceKey);
  return { policy, keptIndex: index === -1 ? null : index };
}

/** Closes the sheets because navigation moved on underneath them, except ones with unsaved work. */
export function dismissSheets(
  state: Pick<SheetState, "sheetsByWorkspace">,
  workspaceKey: string,
): Pick<SheetState, "sheetsByWorkspace"> {
  return withSheets(
    state,
    workspaceKey,
    getSheets(state, workspaceKey).filter((sheet) => sheetHoldsUnsavedWork(workspaceKey, sheet)),
  );
}

/** The stack preserves keyed sheet roots while uncovering a prior resource. */
export function openTargetInSheet(
  state: SheetState,
  workspaceKey: string,
  target: WorkspaceTabTarget,
  parentTabId?: string,
): SheetTab | null {
  const placement = resolveSheetPlacement(state, workspaceKey, target, "reveal");
  if (!placement) return null;
  const sheets = getSheets(state, workspaceKey);
  const { keptIndex } = placement;
  return placeTargetInSheet({
    kept: keptIndex === null ? undefined : sheets[keptIndex],
    target,
    intent: "reveal",
    policy: placement.policy,
    parentTabId: resolveOpenParentTabId(state, workspaceKey, parentTabId),
    state: undefined,
  });
}
export function revealSheet(state: SheetState, workspaceKey: string, sheet: SheetTab) {
  const sheets = getSheets(state, workspaceKey);
  const index = sheets.findIndex((existing) => existing.tab.tabId === sheet.tab.tabId);
  const next =
    index === -1
      ? [...sheets, sheet]
      : sheets.flatMap((existing, position) => {
          if (position === index) return [sheet];
          if (position < index) return [existing];
          return sheetHoldsUnsavedWork(workspaceKey, existing) ? [existing] : [];
        });
  return withSheets(state, workspaceKey, next);
}
