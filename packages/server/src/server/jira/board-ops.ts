import type {
  JiraBacklogSprintSchema,
  JiraBoard,
  JiraBoardConfiguration,
  JiraBoardFilter,
  JiraEpic,
  JiraIssueCard,
  JiraLane,
  JiraProject,
  JiraSprint,
  JiraSprintDestination,
  JiraSprintState,
  JiraSwimlaneConfig,
  JiraVersion,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import type { z } from "zod";
import { andJql, applyBoardFilter, computeLanes, onBoard } from "./board-view.js";
import { JiraApiError } from "./errors.js";
import { arr, bool, num, obj, objs, str, type Json } from "./json.js";
import { mapBoard, mapProject, mapSprint } from "./mapping.js";
import type { JiraSite } from "./site.js";

// Projects, boards, board issues, backlog and sprints (spec 29.3) on Jira Software's
// `/rest/agile/1.0` + (Cloud) `/rest/software/1.0`.

const AGILE = "/rest/agile/1.0";
const MAX_BATCH = 50;

async function pageValues(
  site: JiraSite,
  path: string,
  query: Json = {},
  max = 500,
): Promise<Json[]> {
  const values: Json[] = [];
  for (let startAt = 0; values.length < max; ) {
    const page: Json = await site.get(path, { ...query, startAt, maxResults: 50 } as Record<
      string,
      string | number
    >);
    const batch = objs(page.values);
    values.push(...batch);
    startAt += batch.length;
    if (batch.length === 0 || bool(page.isLast) || page.isLast === undefined) break;
  }
  return values;
}

export async function listProjects(site: JiraSite, query?: string): Promise<JiraProject[]> {
  if (site.flavor.deployment === "cloud") {
    const values = await pageValues(site, site.api("/project/search"), {
      query: query ?? "",
      expand: "lead",
      orderBy: "name",
    });
    return values.map((project) => mapProject(project, site.flavor));
  }
  const all = objs(await site.get<unknown>(site.api("/project"), { expand: "lead" }));
  const needle = query?.trim().toLowerCase() ?? "";
  return all
    .map((project) => mapProject(project, site.flavor))
    .filter(
      (p) =>
        needle.length === 0 ||
        p.name.toLowerCase().includes(needle) ||
        p.key.toLowerCase().includes(needle),
    );
}

export async function listBoards(
  site: JiraSite,
  input: { projectKey?: string; query?: string },
): Promise<JiraBoard[]> {
  const values = await pageValues(site, `${AGILE}/board`, {
    ...(input.projectKey ? { projectKeyOrId: input.projectKey } : {}),
    ...(input.query ? { name: input.query } : {}),
  });
  return values.map(mapBoard);
}

export async function getBoard(site: JiraSite, boardId: number): Promise<JiraBoard> {
  return mapBoard(await site.get(`${AGILE}/board/${boardId}`));
}

async function boardFeatures(site: JiraSite, boardId: number): Promise<Set<string> | null> {
  try {
    const response: Json = await site.get(`${AGILE}/board/${boardId}/features`);
    const enabled = objs(response.features)
      .filter((feature) => str(feature.state) === "ENABLED")
      .map((feature) => str(feature.boardFeature) ?? str(feature.feature) ?? "");
    return new Set(enabled);
  } catch (error) {
    // Older Data Center versions have no features endpoint; fall back to the board type.
    if (error instanceof JiraApiError && error.code === "not_found") return null;
    throw error;
  }
}

export interface BoardSetup {
  configuration: JiraBoardConfiguration;
  filterJql: string | null;
  subQuery: string | null;
  // Kanban with a backlog: the first configured column lives in the backlog, not on the board.
  backlogStatusIds: string[];
}

// oxlint-disable-next-line complexity
export async function boardSetup(site: JiraSite, boardId: number): Promise<BoardSetup> {
  const [config, board, features, statuses] = await Promise.all([
    site.get(`${AGILE}/board/${boardId}/configuration`),
    getBoard(site, boardId),
    boardFeatures(site, boardId),
    site.statuses(),
  ]);
  const quickFilters = site.flavor.hasQuickFilters
    ? (await pageValues(site, `${AGILE}/board/${boardId}/quickfilter`)).map((filter) => ({
        id: num(filter.id) ?? 0,
        name: str(filter.name) ?? "",
        jql: str(filter.jql) ?? "",
      }))
    : [];
  const columnConfig = obj(config.columnConfig) ?? {};
  const allColumns = objs(columnConfig.columns).map((column) => ({
    name: str(column.name) ?? "",
    statusIds: objs(column.statuses).map((status) => str(status.id) ?? ""),
    min: num(column.min),
    max: num(column.max),
  }));
  const isScrum = board.type === "scrum";
  const backlogEnabled = isScrum || (features?.has("BACKLOG") ?? false);
  const kanbanBacklog = !isScrum && backlogEnabled && allColumns.length > 1;
  const columns = kanbanBacklog ? allColumns.slice(1) : allColumns;
  const boardStatusIds = new Set(allColumns.flatMap((column) => column.statusIds));
  const estimationField = obj(obj(config.estimation)?.field);
  const filterId = str(obj(config.filter)?.id);
  let filterJql: string | null = null;
  if (filterId) {
    const filter: Json = await site.get(site.api(`/filter/${filterId}`));
    filterJql = str(filter.jql);
  }
  return {
    configuration: {
      boardId,
      name: str(config.name) ?? board.name,
      type: board.type,
      columns,
      constraintType: str(columnConfig.constraintType) ?? "none",
      estimation: estimationField
        ? {
            fieldId: str(estimationField.fieldId) ?? "",
            displayName: str(estimationField.displayName) ?? "",
          }
        : null,
      rankFieldId: num(obj(config.ranking)?.rankCustomFieldId),
      quickFilters,
      backlogEnabled,
      sprintsEnabled: isScrum || (features?.has("SPRINTS") ?? false),
      statuses: statuses.filter((status) => boardStatusIds.has(status.id)),
    },
    filterJql,
    subQuery: str(obj(config.subQuery)?.query),
    backlogStatusIds: kanbanBacklog ? (allColumns[0]?.statusIds ?? []) : [],
  };
}

export async function listSprints(
  site: JiraSite,
  boardId: number,
  states: JiraSprintState[] = ["active", "future"],
): Promise<JiraSprint[]> {
  const values = await pageValues(site, `${AGILE}/board/${boardId}/sprint`, {
    state: states.join(","),
  });
  return values.map(mapSprint);
}

export interface BoardIssues {
  issues: JiraIssueCard[];
  lanes: JiraLane[];
  sprint: JiraSprint | null;
  truncated: boolean;
}

export async function boardIssues(
  site: JiraSite,
  input: { boardId: number; filter?: JiraBoardFilter; swimlanes: JiraSwimlaneConfig },
): Promise<BoardIssues> {
  const setup = await boardSetup(site, input.boardId);
  const { configuration } = setup;
  const context = await site.cardContext(configuration.estimation?.fieldId ?? null);
  const quick = configuration.quickFilters
    .filter((filter) => input.filter?.quickFilterIds?.includes(filter.id))
    .map((filter) => filter.jql);
  let sprint: JiraSprint | null = null;
  let page;
  if (configuration.type === "scrum") {
    const active = await listSprints(site, input.boardId, ["active"]);
    sprint = active[0] ?? null;
    if (!sprint) return { issues: [], lanes: [], sprint: null, truncated: false };
    page = await site.issues({
      path: `${site.flavor.boardIssues}/board/${input.boardId}/sprint/${sprint.id}/issue`,
      jql: andJql(quick) ?? undefined,
      context,
    });
  } else {
    page = await site.issues({
      path: `${site.flavor.boardIssues}/board/${input.boardId}/issue`,
      jql: andJql([setup.subQuery, ...quick]) ?? undefined,
      context,
    });
  }
  const backlogStatuses = new Set(setup.backlogStatusIds);
  const visible = onBoard(page.issues, configuration.columns).filter(
    (issue) =>
      !backlogStatuses.has(issue.status.id) &&
      !(configuration.type === "scrum" && issue.type.name === "Epic"),
  );
  const issues = applyBoardFilter(visible, input.filter);
  const queryMatches = await laneQueryMatches(site, issues, input.swimlanes);
  return {
    issues,
    lanes: computeLanes(issues, input.swimlanes, queryMatches),
    sprint,
    truncated: page.truncated,
  };
}

async function laneQueryMatches(
  site: JiraSite,
  issues: JiraIssueCard[],
  config: JiraSwimlaneConfig,
): Promise<Map<string, Set<string>>> {
  const matches = new Map<string, Set<string>>();
  if (config.mode !== "queries" || issues.length === 0) return matches;
  const keys = issues.map((issue) => issue.key);
  const context = await site.cardContext(null);
  for (const query of config.queries) {
    const ids = new Set<string>();
    for (let index = 0; index < keys.length; index += 100) {
      const chunk = keys.slice(index, index + 100);
      const jql = andJql([`key in (${chunk.join(",")})`, query.jql]) ?? "";
      const page = await site.issues({ path: site.flavor.search, jql, context, limit: 100 });
      for (const issue of page.issues) ids.add(issue.id);
    }
    matches.set(query.id, ids);
  }
  return matches;
}

type BacklogSprint = z.infer<typeof JiraBacklogSprintSchema>;

export interface Backlog {
  sprints: BacklogSprint[];
  backlog: JiraIssueCard[];
  epics: JiraEpic[];
  versions: JiraVersion[];
}

export async function backlog(site: JiraSite, boardId: number): Promise<Backlog> {
  const setup = await boardSetup(site, boardId);
  const context = await site.cardContext(setup.configuration.estimation?.fieldId ?? null);
  const sprints = setup.configuration.sprintsEnabled ? await listSprints(site, boardId) : [];
  const sprintBlocks = await Promise.all(
    sprints.map(async (sprint) => ({
      sprint,
      issues: (
        await site.issues({
          path: `${site.flavor.boardIssues}/board/${boardId}/sprint/${sprint.id}/issue`,
          context,
        })
      ).issues,
    })),
  );
  const backlogIssues = await site.issues({
    path: `${site.flavor.boardIssues}/board/${boardId}/backlog`,
    context,
  });
  const epics = await optionalValues(site, `${AGILE}/board/${boardId}/epic`);
  const versions = await optionalValues(site, `${AGILE}/board/${boardId}/version`);
  return {
    sprints: sprintBlocks,
    backlog: backlogIssues.issues.filter((issue) => issue.type.name !== "Epic"),
    epics: epics.map((epic) => ({
      id: str(epic.id) ?? "",
      key: str(epic.key) ?? "",
      name: str(epic.name) ?? str(epic.summary) ?? "",
      done: bool(epic.done),
    })),
    versions: versions.map((version) => ({
      id: str(version.id) ?? "",
      name: str(version.name) ?? "",
      released: bool(version.released),
      releaseDate: str(version.releaseDate),
    })),
  };
}

// Team-managed boards answer 400 for epics/versions (they use the parent field and no versions).
async function optionalValues(site: JiraSite, path: string): Promise<Json[]> {
  try {
    return await pageValues(site, path);
  } catch (error) {
    if (
      error instanceof JiraApiError &&
      (error.code === "invalid_input" || error.code === "not_found")
    ) {
      return [];
    }
    throw error;
  }
}

export async function createSprint(
  site: JiraSite,
  input: {
    boardId: number;
    name: string;
    goal?: string;
    startDate_ms?: number;
    endDate_ms?: number;
  },
): Promise<JiraSprint> {
  const created: Json = await site.post(`${AGILE}/sprint`, {
    name: input.name,
    originBoardId: input.boardId,
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.startDate_ms ? { startDate: new Date(input.startDate_ms).toISOString() } : {}),
    ...(input.endDate_ms ? { endDate: new Date(input.endDate_ms).toISOString() } : {}),
  });
  return mapSprint(created);
}

export async function updateSprint(
  site: JiraSite,
  sprintId: number,
  patch: {
    name?: string;
    goal?: string;
    state?: "active" | "closed";
    startDate_ms?: number;
    endDate_ms?: number;
  },
): Promise<JiraSprint> {
  const updated: Json = await site.post(`${AGILE}/sprint/${sprintId}`, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
    ...(patch.state ? { state: patch.state } : {}),
    ...(patch.startDate_ms ? { startDate: new Date(patch.startDate_ms).toISOString() } : {}),
    ...(patch.endDate_ms ? { endDate: new Date(patch.endDate_ms).toISOString() } : {}),
  });
  return mapSprint(updated);
}

export async function moveToSprint(
  site: JiraSite,
  sprintId: number,
  issueKeys: string[],
): Promise<void> {
  for (let index = 0; index < issueKeys.length; index += MAX_BATCH) {
    await site.post(`${AGILE}/sprint/${sprintId}/issue`, {
      issues: issueKeys.slice(index, index + MAX_BATCH),
    });
  }
}

export async function moveToBacklog(site: JiraSite, issueKeys: string[]): Promise<void> {
  for (let index = 0; index < issueKeys.length; index += MAX_BATCH) {
    await site.post(`${AGILE}/backlog/issue`, {
      issues: issueKeys.slice(index, index + MAX_BATCH),
    });
  }
}

/** Jira's REST complete has no "move open issues to" option, so they move first (reference §2.3). */
export async function completeSprint(
  site: JiraSite,
  input: { boardId: number; sprintId: number; destination: JiraSprintDestination },
): Promise<{ sprint: JiraSprint; movedIssueKeys: string[] }> {
  const context = await site.cardContext(null);
  const open = await site.issues({
    path: `${site.flavor.boardIssues}/board/${input.boardId}/sprint/${input.sprintId}/issue`,
    jql: "statusCategory != Done",
    context,
  });
  const keys = open.issues.map((issue) => issue.key);
  if (keys.length > 0) {
    switch (input.destination.kind) {
      case "backlog":
        await moveToBacklog(site, keys);
        break;
      case "sprint":
        await moveToSprint(site, input.destination.sprintId, keys);
        break;
      case "new_sprint": {
        const next = await createSprint(site, {
          boardId: input.boardId,
          name: input.destination.name,
        });
        await moveToSprint(site, next.id, keys);
        break;
      }
    }
  }
  const sprint = await updateSprint(site, input.sprintId, { state: "closed" });
  return { sprint, movedIssueKeys: keys };
}

export async function rankIssues(
  site: JiraSite,
  input: {
    issueKeys: string[];
    rankBeforeKey?: string;
    rankAfterKey?: string;
    rankFieldId?: number;
  },
): Promise<void> {
  if (!input.rankBeforeKey && !input.rankAfterKey) {
    throw new JiraApiError({ code: "invalid_input", message: "Rank needs a neighbor issue." });
  }
  for (let index = 0; index < input.issueKeys.length; index += MAX_BATCH) {
    const response: Json | undefined = await site.put(`${AGILE}/issue/rank`, {
      issues: input.issueKeys.slice(index, index + MAX_BATCH),
      ...(input.rankBeforeKey ? { rankBeforeIssue: input.rankBeforeKey } : {}),
      ...(input.rankAfterKey ? { rankAfterIssue: input.rankAfterKey } : {}),
      ...(input.rankFieldId ? { rankCustomFieldId: input.rankFieldId } : {}),
    });
    // 207: some issues could not be ranked.
    const failed = objs(response?.entries).filter((entry) => arr(entry.errors).length > 0);
    if (failed.length > 0) {
      const messages = failed.flatMap((entry) => arr(entry.errors).map(String));
      throw new JiraApiError({ code: "jira_error", message: messages.join("; ") });
    }
  }
}
