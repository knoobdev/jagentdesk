import type {
  JiraBoardColumn,
  JiraBoardFilter,
  JiraIssueCard,
  JiraLane,
  JiraSwimlaneConfig,
} from "@jagentdesk/protocol/jira/rpc-schemas";

// Board computations Jira's API leaves to the client (spec 29.3): which issues a board shows,
// the board-side filters, and swimlanes (Jira has no swimlane API, so lanes are computed here).

/** Issues whose status is mapped to one of the columns; others are not on the board (as on web). */
export function onBoard(issues: JiraIssueCard[], columns: JiraBoardColumn[]): JiraIssueCard[] {
  const mapped = new Set(columns.flatMap((column) => column.statusIds));
  return issues.filter((issue) => mapped.has(issue.status.id));
}

/** Search box, assignee, epic/parent, label and type filters of the board toolbar. */
export function applyBoardFilter(
  issues: JiraIssueCard[],
  filter: JiraBoardFilter | undefined,
): JiraIssueCard[] {
  if (!filter) return issues;
  const text = filter.text?.trim().toLowerCase() ?? "";
  const assignees = new Set(filter.assigneeRefs ?? []);
  const parents = new Set(filter.parentKeys ?? []);
  const labels = new Set(filter.labels ?? []);
  const types = new Set(filter.typeIds ?? []);
  return issues.filter((issue) => {
    const matchesText =
      text.length === 0 ||
      issue.key.toLowerCase().includes(text) ||
      issue.summary.toLowerCase().includes(text);
    const matchesAssignee =
      assignees.size === 0 || assignees.has(issue.assignee?.ref ?? "unassigned");
    const matchesParent = parents.size === 0 || parents.has(issue.parent?.key ?? "none");
    const matchesLabel = labels.size === 0 || issue.labels.some((label) => labels.has(label));
    const matchesType = types.size === 0 || types.has(issue.type.id);
    return matchesText && matchesAssignee && matchesParent && matchesLabel && matchesType;
  });
}

/** `(<a>) AND (<b>)` over the non-empty clauses; null when there are none. */
export function andJql(clauses: Array<string | null | undefined>): string | null {
  const present = clauses.map((clause) => clause?.trim() ?? "").filter((c) => c.length > 0);
  if (present.length === 0) return null;
  return present.map((clause) => `(${clause})`).join(" AND ");
}

function groupLanes(
  issues: JiraIssueCard[],
  keyOf: (issue: JiraIssueCard) => { id: string; title: string } | null,
  restTitle: string,
): JiraLane[] {
  const lanes = new Map<string, JiraLane>();
  const rest: string[] = [];
  for (const issue of issues) {
    const key = keyOf(issue);
    if (!key) {
      rest.push(issue.id);
      continue;
    }
    const lane = lanes.get(key.id) ?? { id: key.id, title: key.title, issueIds: [] };
    lane.issueIds.push(issue.id);
    lanes.set(key.id, lane);
  }
  const sorted = [...lanes.values()].sort((a, b) => a.title.localeCompare(b.title));
  return rest.length > 0 ? [...sorted, { id: "rest", title: restTitle, issueIds: rest }] : sorted;
}

/**
 * Lanes for a board. `queryMatches` maps each query lane id to the ids of issues matching its JQL;
 * like Jira web, an issue sits in the first query lane it matches, the rest in "Everything else".
 */
export function computeLanes(
  issues: JiraIssueCard[],
  config: JiraSwimlaneConfig,
  queryMatches: ReadonlyMap<string, ReadonlySet<string>>,
): JiraLane[] {
  switch (config.mode) {
    case "none":
      return [{ id: "all", title: "All issues", issueIds: issues.map((issue) => issue.id) }];
    case "assignee":
      return groupLanes(
        issues,
        (issue) =>
          issue.assignee
            ? { id: `user:${issue.assignee.ref}`, title: issue.assignee.displayName }
            : null,
        "Unassigned",
      );
    case "epic":
      return groupLanes(
        issues,
        (issue) =>
          issue.parent
            ? {
                id: `parent:${issue.parent.key}`,
                title: `${issue.parent.key} ${issue.parent.summary}`,
              }
            : null,
        "Issues without epic",
      );
    case "queries": {
      const placed = new Set<string>();
      const lanes: JiraLane[] = config.queries.map((query) => {
        const matches = queryMatches.get(query.id) ?? new Set<string>();
        const ids = issues
          .filter((issue) => !placed.has(issue.id) && matches.has(issue.id))
          .map((issue) => issue.id);
        for (const id of ids) placed.add(id);
        return { id: `query:${query.id}`, title: query.name, issueIds: ids };
      });
      const rest = issues.filter((issue) => !placed.has(issue.id)).map((issue) => issue.id);
      return [...lanes, { id: "rest", title: "Everything else", issueIds: rest }];
    }
  }
}

/** `updated >= "<time>"` operand: JQL compares in the user's profile time zone, minute precision. */
export function jqlTime(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
}
