import type {
  JiraAttachment,
  JiraBoard,
  JiraChangelogEntry,
  JiraComment,
  JiraFieldKind,
  JiraFieldValue,
  JiraFieldView,
  JiraIssueCard,
  JiraIssueLink,
  JiraIssueRef,
  JiraIssueType,
  JiraOption,
  JiraProject,
  JiraSprint,
  JiraStatus,
  JiraStatusCategory,
  JiraUser,
  JiraWorklog,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import type { JiraFlavor } from "./flavor.js";
import { arr, bool, jiraTime, num, obj, objs, str, type Json } from "./json.js";

// Jira JSON → wire DTOs. Only listed fields cross; URLs to Jira resources (avatars, icons,
// `self`, attachment content) never do (ADR-0034 §1).

export interface FieldCatalog {
  names: Map<string, string>;
  sprintFieldId: string | null;
  epicLinkFieldId: string | null;
  flaggedFieldId: string | null;
  storyPointsFieldId: string | null;
}

export interface CardContext {
  flavor: JiraFlavor;
  catalog: FieldCatalog;
  estimationFieldId: string | null;
}

export function mapUser(value: unknown, flavor: JiraFlavor): JiraUser | null {
  const user = obj(value);
  if (!user) return null;
  const ref = flavor.userRef(user);
  if (!ref) return null;
  return { ref, displayName: str(user.displayName) ?? ref };
}

const CATEGORY_KEYS: Record<string, JiraStatusCategory> = {
  new: "new",
  indeterminate: "indeterminate",
  done: "done",
};

export function mapStatus(value: unknown): JiraStatus {
  const status = obj(value) ?? {};
  const category = str(obj(status.statusCategory)?.key) ?? "undefined";
  return {
    id: str(status.id) ?? "",
    name: str(status.name) ?? "",
    category: CATEGORY_KEYS[category] ?? "undefined",
  };
}

export function mapIssueType(value: unknown): JiraIssueType {
  const type = obj(value) ?? {};
  return { id: str(type.id) ?? "", name: str(type.name) ?? "", subtask: bool(type.subtask) };
}

function mapParent(fields: Json, catalog: FieldCatalog): JiraIssueRef | null {
  const parent = obj(fields.parent);
  if (parent) {
    const parentFields = obj(parent.fields) ?? {};
    return {
      id: str(parent.id) ?? "",
      key: str(parent.key) ?? "",
      summary: str(parentFields.summary) ?? "",
      typeName: str(obj(parentFields.issuetype)?.name) ?? "",
    };
  }
  // Agile endpoints on Data Center report the epic separately.
  const epic = obj(fields.epic);
  if (epic) {
    return {
      id: str(epic.id) ?? "",
      key: str(epic.key) ?? "",
      summary: str(epic.summary) ?? str(epic.name) ?? "",
      typeName: "Epic",
    };
  }
  const epicKey = catalog.epicLinkFieldId ? str(fields[catalog.epicLinkFieldId]) : null;
  return epicKey ? { id: "", key: epicKey, summary: epicKey, typeName: "Epic" } : null;
}

function mapSprintId(fields: Json, catalog: FieldCatalog): number | null {
  const agile = obj(fields.sprint);
  if (agile) return num(agile.id);
  const custom = catalog.sprintFieldId ? arr(fields[catalog.sprintFieldId]) : [];
  const open = objs(custom).find((sprint) => str(sprint.state) !== "closed");
  return open ? num(open.id) : null;
}

function isFlagged(fields: Json, catalog: FieldCatalog): boolean {
  if (typeof fields.flagged === "boolean") return fields.flagged;
  if (!catalog.flaggedFieldId) return false;
  return arr(fields[catalog.flaggedFieldId]).length > 0;
}

export function mapCard(issue: Json, context: CardContext): JiraIssueCard {
  const fields = obj(issue.fields) ?? {};
  const priority = obj(fields.priority);
  const estimateField = context.estimationFieldId ?? context.catalog.storyPointsFieldId;
  return {
    id: str(issue.id) ?? "",
    key: str(issue.key) ?? "",
    summary: str(fields.summary) ?? "",
    type: mapIssueType(fields.issuetype),
    status: mapStatus(fields.status),
    priority: priority ? { id: str(priority.id) ?? "", name: str(priority.name) ?? "" } : null,
    assignee: mapUser(fields.assignee, context.flavor),
    estimate: estimateField ? num(fields[estimateField]) : null,
    parent: mapParent(fields, context.catalog),
    labels: arr(fields.labels).filter((label): label is string => typeof label === "string"),
    flagged: isFlagged(fields, context.catalog),
    sprintId: mapSprintId(fields, context.catalog),
    updated_ms: jiraTime(fields.updated) ?? 0,
  };
}

/** Fields to request so mapCard has what it reads. */
export function cardFields(context: CardContext): string[] {
  const { catalog } = context;
  return [
    "summary",
    "issuetype",
    "status",
    "priority",
    "assignee",
    "parent",
    "labels",
    "updated",
    // Data Center agile endpoints report these as agile fields (ignored elsewhere).
    ...(context.flavor.deployment === "datacenter" ? ["sprint", "epic", "flagged"] : []),
    ...[
      context.estimationFieldId,
      catalog.storyPointsFieldId,
      catalog.sprintFieldId,
      catalog.epicLinkFieldId,
      catalog.flaggedFieldId,
    ].filter((id): id is string => id !== null),
  ];
}

export function mapProject(value: Json, flavor: JiraFlavor): JiraProject {
  return {
    id: str(value.id) ?? "",
    key: str(value.key) ?? "",
    name: str(value.name) ?? "",
    projectTypeKey: str(value.projectTypeKey) ?? "software",
    lead: mapUser(value.lead, flavor),
  };
}

export function mapBoard(value: Json): JiraBoard {
  const location = obj(value.location) ?? {};
  const type = str(value.type);
  return {
    id: num(value.id) ?? 0,
    name: str(value.name) ?? "",
    type: type === "scrum" || type === "simple" ? type : "kanban",
    projectKey: str(location.projectKey),
    projectName: str(location.projectName) ?? str(location.displayName) ?? str(location.name),
  };
}

export function mapSprint(value: Json): JiraSprint {
  const state = str(value.state);
  return {
    id: num(value.id) ?? 0,
    name: str(value.name) ?? "",
    state: state === "active" || state === "closed" ? state : "future",
    goal: str(value.goal) || null,
    startDate_ms: jiraTime(value.startDate),
    endDate_ms: jiraTime(value.endDate),
    completeDate_ms: jiraTime(value.completeDate),
    boardId: num(value.originBoardId),
  };
}

export function mapAttachment(value: Json, flavor: JiraFlavor): JiraAttachment {
  return {
    id: str(value.id) ?? "",
    filename: str(value.filename) ?? "",
    mimeType: str(value.mimeType) ?? "application/octet-stream",
    size: num(value.size) ?? 0,
    created_ms: jiraTime(value.created) ?? 0,
    author: mapUser(value.author, flavor),
    hasThumbnail: typeof value.thumbnail === "string",
  };
}

export function mapIssueLink(value: Json): JiraIssueLink | null {
  const type = obj(value.type) ?? {};
  const outward = obj(value.outwardIssue);
  const inward = obj(value.inwardIssue);
  const other = outward ?? inward;
  if (!other) return null;
  const fields = obj(other.fields) ?? {};
  return {
    id: str(value.id) ?? "",
    // This issue → outwardIssue reads with the outward phrase ("blocks").
    relation: (outward ? str(type.outward) : str(type.inward)) ?? str(type.name) ?? "",
    issue: {
      id: str(other.id) ?? "",
      key: str(other.key) ?? "",
      summary: str(fields.summary) ?? "",
      status: mapStatus(fields.status),
      typeName: str(obj(fields.issuetype)?.name) ?? "",
    },
  };
}

export function mapComment(value: Json, flavor: JiraFlavor, myRef: string): JiraComment {
  const author = mapUser(value.author, flavor);
  return {
    id: str(value.id) ?? "",
    author,
    body: flavor.readText(value.body),
    created_ms: jiraTime(value.created) ?? 0,
    updated_ms: jiraTime(value.updated) ?? 0,
    editable: author?.ref === myRef,
  };
}

export function mapWorklog(value: Json, flavor: JiraFlavor): JiraWorklog {
  return {
    id: str(value.id) ?? "",
    author: mapUser(value.author, flavor),
    timeSpent: str(value.timeSpent) ?? "",
    timeSpentSeconds: num(value.timeSpentSeconds) ?? 0,
    started_ms: jiraTime(value.started) ?? 0,
    comment: flavor.readText(value.comment).markdown,
  };
}

export function mapChangelog(value: Json, flavor: JiraFlavor): JiraChangelogEntry {
  return {
    id: str(value.id) ?? "",
    author: mapUser(value.author, flavor),
    created_ms: jiraTime(value.created) ?? 0,
    items: objs(value.items).map((item) => ({
      field: str(item.field) ?? "",
      from: str(item.fromString),
      to: str(item.toString),
    })),
  };
}

// ── Fields (editmeta, transition screens, createmeta) ───────────────────

const TEXTAREA_CUSTOM = "com.atlassian.jira.plugin.system.customfieldtypes:textarea";
const SPRINT_CUSTOM = "com.pyxis.greenhopper.jira:gh-sprint";
const OPTION_TYPES = new Set([
  "option",
  "priority",
  "version",
  "component",
  "resolution",
  "securitylevel",
  "option-with-child",
]);

// oxlint-disable-next-line complexity
export function fieldKind(fieldId: string, meta: Json): JiraFieldKind {
  const schema = obj(meta.schema) ?? {};
  const type = str(schema.type);
  const items = str(schema.items);
  const system = str(schema.system);
  const custom = str(schema.custom);
  const hasAllowed = Array.isArray(meta.allowedValues);
  if (custom === SPRINT_CUSTOM) return "option";
  if (type === "string") {
    if (system === "description" || system === "environment" || custom === TEXTAREA_CUSTOM) {
      return "textarea";
    }
    return "text";
  }
  if (type === "number") return "number";
  if (type === "date") return "date";
  if (type === "user") return "user";
  if (type === "array" && items === "string" && (system === "labels" || fieldId === "labels")) {
    return "labels";
  }
  if (type === "array" && items !== null && OPTION_TYPES.has(items) && hasAllowed) return "options";
  if (type !== null && OPTION_TYPES.has(type) && hasAllowed) return "option";
  return "readonly";
}

function optionOf(value: unknown): JiraOption | null {
  const option = obj(value);
  if (!option) return null;
  const id = str(option.id);
  const name = str(option.name) ?? str(option.value) ?? str(option.displayName);
  return id && name ? { id, name } : null;
}

export function allowedValues(meta: Json): JiraOption[] | null {
  if (!Array.isArray(meta.allowedValues)) return null;
  return arr(meta.allowedValues)
    .map(optionOf)
    .filter((option): option is JiraOption => option !== null);
}

function displayText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    const parts = value.map(displayText).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  const record = obj(value);
  if (!record) return null;
  return (
    str(record.displayName) ??
    str(record.name) ??
    str(record.value) ??
    str(record.key) ??
    (record.type === "doc" ? "(rich text)" : null)
  );
}

// oxlint-disable-next-line complexity
export function fieldValue(kind: JiraFieldKind, raw: unknown, flavor: JiraFlavor): JiraFieldValue {
  switch (kind) {
    case "text":
    case "textarea": {
      if (typeof raw === "string") return { kind: "text", text: raw };
      return { kind: "text", text: raw ? flavor.readText(raw).markdown : null };
    }
    case "number":
      return { kind: "number", number: num(raw) };
    case "date":
      return { kind: "date", date: str(raw) };
    case "user":
      return { kind: "user", user: mapUser(raw, flavor) };
    case "labels":
      return { kind: "labels", labels: arr(raw).filter((l): l is string => typeof l === "string") };
    case "option": {
      if (Array.isArray(raw)) {
        // Sprint field: the open sprint, else the latest closed one.
        const sprints = objs(raw);
        const current = sprints.find((s) => str(s.state) !== "closed") ?? sprints.at(-1) ?? null;
        return { kind: "option", option: current ? optionOf(current) : null };
      }
      return { kind: "option", option: optionOf(raw) };
    }
    case "options":
      return {
        kind: "options",
        options: arr(raw)
          .map(optionOf)
          .filter((option): option is JiraOption => option !== null),
      };
    case "readonly":
      return { kind: "text", text: displayText(raw) };
  }
}

export function fieldView(input: {
  fieldId: string;
  meta: Json;
  raw: unknown;
  flavor: JiraFlavor;
  editable: boolean;
}): JiraFieldView {
  const kind = fieldKind(input.fieldId, input.meta);
  return {
    fieldId: input.fieldId,
    name: str(input.meta.name) ?? input.fieldId,
    kind,
    required: bool(input.meta.required),
    editable: input.editable && kind !== "readonly",
    value: fieldValue(kind, input.raw, input.flavor),
    allowedValues: allowedValues(input.meta),
  };
}
