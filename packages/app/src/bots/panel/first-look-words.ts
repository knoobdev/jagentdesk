// The words for what a new bot finds as it first looks around (spec 37.4.2), ported from Orca dfdb4fda
// (MIT) src/shared/bots/bot-first-look-words.ts:1-120, reading `bots.first_screen.scan`. There is no
// Linear row (spec 37.2.2); GitHub and MCP rows show only when the host has them.
import type { BotFirstScreen } from "@jagentdesk/protocol/bots/views";

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** Shown by name; more are counted. */
const NAMES_SHOWN = 3;

function namesText(names: readonly string[], t: Translate): string {
  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  return names.length > NAMES_SHOWN
    ? t("bots.firstScreen.namesMore", { names: shown, count: names.length - NAMES_SHOWN })
    : shown;
}

export interface FirstLookRow {
  area: "projects" | "github" | "workspaces" | "tools";
  done: boolean;
  text: string;
}

/** The rows, "reading" until the scan answers. */
export function firstLookRows(scan: BotFirstScreen | undefined, t: Translate): FirstLookRow[] {
  if (!scan) {
    return [
      { area: "projects", done: false, text: t("bots.firstScreen.projectsReading") },
      { area: "github", done: false, text: t("bots.firstScreen.githubReading") },
      { area: "workspaces", done: false, text: t("bots.firstScreen.workspacesReading") },
      { area: "tools", done: false, text: t("bots.firstScreen.toolsReading") },
    ];
  }
  const rows: FirstLookRow[] = [];
  const { projects, github, workspaces, mcp } = scan;
  let projectsText: string;
  if (projects.count === 0) projectsText = t("bots.firstScreen.projectsNone");
  else if (projects.count === 1)
    projectsText = t("bots.firstScreen.projectsOne", { names: namesText(projects.names, t) });
  else
    projectsText = t("bots.firstScreen.projectsMany", {
      count: projects.count,
      names: namesText(projects.names, t),
    });
  rows.push({ area: "projects", done: true, text: projectsText });
  if (github) {
    rows.push({
      area: "github",
      done: true,
      text:
        github.openPrs === 1
          ? t("bots.firstScreen.githubOne")
          : t("bots.firstScreen.githubMany", { count: github.openPrs }),
    });
  }
  let workspacesText: string;
  if (workspaces.count === 0) workspacesText = t("bots.firstScreen.workspacesNone");
  else if (workspaces.count === 1) workspacesText = t("bots.firstScreen.workspacesOne");
  else workspacesText = t("bots.firstScreen.workspacesMany", { count: workspaces.count });
  rows.push({ area: "workspaces", done: true, text: workspacesText });
  if (mcp) {
    let toolsText: string;
    if (mcp.count === 0) toolsText = t("bots.firstScreen.toolsNone");
    else if (mcp.count === 1)
      toolsText = t("bots.firstScreen.toolsOne", { names: namesText(mcp.names, t) });
    else
      toolsText = t("bots.firstScreen.toolsMany", {
        count: mcp.count,
        names: namesText(mcp.names, t),
      });
    rows.push({ area: "tools", done: true, text: toolsText });
  }
  return rows;
}
