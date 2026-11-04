import type {
  JiraAssignee,
  JiraAttachment,
  JiraChangelogEntry,
  JiraComment,
  JiraCreateMetaField,
  JiraFieldInput,
  JiraFieldView,
  JiraFilter,
  JiraIssueCard,
  JiraIssueDetail,
  JiraIssueType,
  JiraLinkInput,
  JiraLinkType,
  JiraOption,
  JiraRemainingEstimate,
  JiraSuggestion,
  JiraTransition,
  JiraUser,
  JiraWorklog,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@jagentdesk/protocol/jira/rpc-schemas";
import { listBoards, listSprints, moveToBacklog, moveToSprint } from "./board-ops.js";
import { JiraApiError } from "./errors.js";
import {
  arr,
  bool,
  jiraTime,
  num,
  obj,
  objs,
  str,
  stripTags,
  toJiraTime,
  type Json,
} from "./json.js";
import {
  allowedValues,
  cardFields,
  fieldKind,
  fieldView,
  mapAttachment,
  mapCard,
  mapChangelog,
  mapComment,
  mapIssueLink,
  mapIssueType,
  mapStatus,
  mapUser,
  mapWorklog,
  type FieldCatalog,
} from "./mapping.js";
import type { JiraSite } from "./site.js";

// Issue detail, edits, transitions, comments, worklogs, attachments, links, search, filters and
// users (spec 29.3 "Issue", 29.4 tools). Text crosses as Markdown; the flavor converts.

const SIDEBAR_EXCLUDED = new Set([
  "summary",
  "description",
  "issuetype",
  "project",
  "attachment",
  "issuelinks",
  "comment",
  "worklog",
  "timetracking",
  "parent",
  "subtasks",
  "status",
]);
const SIDEBAR_READONLY = [
  "assignee",
  "reporter",
  "priority",
  "labels",
  "fixVersions",
  "components",
  "duedate",
  "resolution",
];
const SIDEBAR_FIRST = ["assignee", "reporter", "labels", "priority"];

function sidebarOrder(catalog: FieldCatalog): string[] {
  return [
    ...SIDEBAR_FIRST,
    ...[catalog.sprintFieldId, catalog.storyPointsFieldId].filter((id): id is string => !!id),
    "fixVersions",
    "components",
    "duedate",
  ];
}

async function sprintOptions(site: JiraSite, projectKey: string): Promise<JiraOption[]> {
  const boards = await listBoards(site, { projectKey });
  const scrum = boards.find((board) => board.type === "scrum");
  if (!scrum) return [];
  const sprints = await listSprints(site, scrum.id, ["active", "future"]);
  return sprints.map((sprint) => ({ id: String(sprint.id), name: sprint.name }));
}

// oxlint-disable-next-line complexity
export async function getIssue(site: JiraSite, issueKey: string): Promise<JiraIssueDetail> {
  const catalog = await site.catalog();
  const issue: Json = await site.get(site.api(`/issue/${encodeURIComponent(issueKey)}`), {
    expand: "names,editmeta",
  });
  const fields = obj(issue.fields) ?? {};
  const names = obj(issue.names) ?? {};
  const editmeta = obj(obj(issue.editmeta)?.fields) ?? {};
  const projectKey = str(obj(fields.project)?.key) ?? issueKey.split("-")[0] ?? "";
  const [remote, linkTypes] = await Promise.all([
    site.get<unknown>(site.api(`/issue/${encodeURIComponent(issueKey)}/remotelink`)),
    issueLinkTypes(site),
  ]);
  const order = sidebarOrder(catalog);
  const editableIds = Object.keys(editmeta).filter((id) => !SIDEBAR_EXCLUDED.has(id));
  const readonlyIds = [...SIDEBAR_READONLY, catalog.sprintFieldId, catalog.storyPointsFieldId]
    .filter((id): id is string => !!id && !(id in editmeta))
    .filter((id) => {
      const raw = fields[id];
      return raw !== null && raw !== undefined && !(Array.isArray(raw) && raw.length === 0);
    });
  const ids = [...new Set([...editableIds, ...readonlyIds])].sort((a, b) => {
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    return rank(a) - rank(b);
  });
  const sidebar: JiraFieldView[] = [];
  for (const id of ids) {
    const editable = id in editmeta;
    const meta = obj(editmeta[id]) ?? { name: str(names[id]) ?? catalog.names.get(id) ?? id };
    let view = fieldView({ fieldId: id, meta, raw: fields[id], flavor: site.flavor, editable });
    if (editable && id === catalog.sprintFieldId) {
      view = { ...view, allowedValues: await sprintOptions(site, projectKey) };
    }
    sidebar.push(view);
  }
  const watches = obj(fields.watches) ?? {};
  const timetracking = obj(fields.timetracking);
  const context = await site.cardContext(null);
  const attachments = objs(fields.attachment).map((a) => mapAttachment(a, site.flavor));
  return {
    id: str(issue.id) ?? "",
    key: str(issue.key) ?? issueKey,
    webUrl: `${site.connection.siteUrl.replace(/\/+$/, "")}/browse/${str(issue.key) ?? issueKey}`,
    projectKey,
    summary: str(fields.summary) ?? "",
    type: mapIssueType(fields.issuetype),
    status: mapStatus(fields.status),
    priority: obj(fields.priority)
      ? { id: str(obj(fields.priority)?.id) ?? "", name: str(obj(fields.priority)?.name) ?? "" }
      : null,
    assignee: mapUser(fields.assignee, site.flavor),
    reporter: mapUser(fields.reporter, site.flavor),
    parent: mapCard(issue, context).parent,
    labels: arr(fields.labels).filter((label): label is string => typeof label === "string"),
    created_ms: jiraTime(fields.created) ?? 0,
    updated_ms: jiraTime(fields.updated) ?? 0,
    description: site.flavor.readText(fields.description, attachments),
    subtasks: objs(fields.subtasks).map((subtask) => mapCard(subtask, context)),
    links: objs(fields.issuelinks)
      .map(mapIssueLink)
      .filter((link): link is NonNullable<typeof link> => link !== null),
    remoteLinks: objs(remote).map((link) => ({
      id: str(link.id) ?? "",
      title: str(obj(link.object)?.title) ?? str(obj(link.object)?.url) ?? "",
      url: str(obj(link.object)?.url) ?? "",
    })),
    attachments,
    watching: bool(watches.isWatching),
    watchCount: num(watches.watchCount) ?? 0,
    timeTracking: timetracking
      ? {
          originalEstimate: str(timetracking.originalEstimate),
          remainingEstimate: str(timetracking.remainingEstimate),
          timeSpent: str(timetracking.timeSpent),
        }
      : null,
    fields: sidebar,
    canEdit: "summary" in editmeta,
    linkTypes,
  };
}

export async function getCard(site: JiraSite, issueKey: string): Promise<JiraIssueCard> {
  const context = await site.cardContext(null);
  const issue: Json = await site.get(site.api(`/issue/${encodeURIComponent(issueKey)}`), {
    fields: cardFields(context).join(","),
  });
  return mapCard(issue, context);
}

async function issueLinkTypes(site: JiraSite): Promise<JiraLinkType[]> {
  const response: Json = await site.get(site.api("/issueLinkType"));
  return objs(response.issueLinkTypes).map((type) => ({
    id: str(type.id) ?? "",
    name: str(type.name) ?? "",
    inward: str(type.inward) ?? "",
    outward: str(type.outward) ?? "",
  }));
}

/** Shapes one field input into the JSON Jira expects for that field's schema. */
// oxlint-disable-next-line complexity
export function jiraFieldJson(
  site: JiraSite,
  fieldId: string,
  meta: Json,
  input: JiraFieldInput,
): unknown {
  const kind = fieldKind(fieldId, meta);
  const sprintField = str(obj(meta.schema)?.custom) === "com.pyxis.greenhopper.jira:gh-sprint";
  switch (input.kind) {
    case "markdown":
      return kind === "textarea" ? site.flavor.writeText(input.markdown) : input.markdown;
    case "text":
      return input.text;
    case "number":
    case "date":
      return input.kind === "number" ? input.number : input.date;
    case "user":
      return input.ref === null ? null : site.flavor.userBody(input.ref);
    case "labels":
      return input.labels;
    case "option":
      if (input.id === null) return null;
      return sprintField ? Number(input.id) : { id: input.id };
    case "options":
      return input.ids.map((id) => ({ id }));
  }
}

function mapFieldInputs(
  site: JiraSite,
  metaFields: Json,
  inputs: Record<string, JiraFieldInput>,
): Json {
  const out: Json = {};
  for (const [fieldId, input] of Object.entries(inputs)) {
    const meta = obj(metaFields[fieldId]);
    if (!meta) {
      throw new JiraApiError({
        code: "invalid_input",
        message: `Field ${fieldId} cannot be set here.`,
        fieldErrors: { [fieldId]: "Not editable on this screen." },
      });
    }
    out[fieldId] = jiraFieldJson(site, fieldId, meta, input);
  }
  return out;
}

export async function updateIssue(
  site: JiraSite,
  issueKey: string,
  input: {
    summary?: string;
    descriptionMarkdown?: string;
    fields?: Record<string, JiraFieldInput>;
  },
): Promise<JiraIssueDetail> {
  const path = site.api(`/issue/${encodeURIComponent(issueKey)}`);
  const catalog = await site.catalog();
  const fieldInputs = { ...input.fields };
  const sprintInput = catalog.sprintFieldId ? fieldInputs[catalog.sprintFieldId] : undefined;
  if (catalog.sprintFieldId) delete fieldInputs[catalog.sprintFieldId];
  const editmeta: Json = await site.get(`${path}/editmeta`);
  const metaFields = obj(editmeta.fields) ?? {};
  const fields: Json = mapFieldInputs(site, metaFields, fieldInputs);
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.descriptionMarkdown !== undefined) {
    fields.description = site.flavor.writeText(input.descriptionMarkdown);
  }
  if (Object.keys(fields).length > 0) await site.put(path, { fields });
  if (sprintInput && sprintInput.kind === "option") {
    // Sprint membership goes through the agile API, which also handles leaving a sprint.
    if (sprintInput.id === null) await moveToBacklog(site, [issueKey]);
    else await moveToSprint(site, Number(sprintInput.id), [issueKey]);
  }
  const detail = await getIssue(site, issueKey);
  site.noteWrite(detail.id);
  return detail;
}

export async function createMeta(
  site: JiraSite,
  projectKey: string,
  issueTypeId?: string,
): Promise<{ issueTypes: JiraIssueType[]; fields: JiraCreateMetaField[] }> {
  const base = site.api(`/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`);
  const typesPage: Json = await site.get(base, { maxResults: 100 });
  const issueTypes = objs(typesPage.issueTypes ?? typesPage.values).map(mapIssueType);
  if (!issueTypeId) return { issueTypes, fields: [] };
  const fieldsPage: Json = await site.get(`${base}/${encodeURIComponent(issueTypeId)}`, {
    maxResults: 200,
  });
  const fields = objs(fieldsPage.fields ?? fieldsPage.values)
    .filter(
      (field) =>
        ![
          "project",
          "issuetype",
          "summary",
          "description",
          "attachment",
          "issuelinks",
          "reporter",
          "parent",
        ].includes(str(field.fieldId) ?? ""),
    )
    .map((field) => {
      const fieldId = str(field.fieldId) ?? "";
      return {
        fieldId,
        name: str(field.name) ?? fieldId,
        kind: fieldKind(fieldId, field),
        required: bool(field.required),
        allowedValues: allowedValues(field),
      };
    });
  return { issueTypes, fields };
}

export async function createIssue(
  site: JiraSite,
  input: {
    projectKey: string;
    issueTypeId: string;
    summary: string;
    descriptionMarkdown?: string;
    parentKey?: string;
    sprintId?: number;
    fields?: Record<string, JiraFieldInput>;
  },
): Promise<JiraIssueCard> {
  let extra: Json = {};
  if (input.fields && Object.keys(input.fields).length > 0) {
    const page: Json = await site.get(
      site.api(
        `/issue/createmeta/${encodeURIComponent(input.projectKey)}/issuetypes/${encodeURIComponent(input.issueTypeId)}`,
      ),
      { maxResults: 200 },
    );
    const metaFields = Object.fromEntries(
      objs(page.fields ?? page.values).map((field) => [str(field.fieldId) ?? "", field]),
    );
    extra = mapFieldInputs(site, metaFields, input.fields);
  }
  const created: Json = await site.post(site.api("/issue"), {
    fields: {
      project: { key: input.projectKey },
      issuetype: { id: input.issueTypeId },
      summary: input.summary,
      ...(input.descriptionMarkdown
        ? { description: site.flavor.writeText(input.descriptionMarkdown) }
        : {}),
      ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
      ...extra,
    },
  });
  const key = str(created.key) ?? "";
  if (input.sprintId !== undefined) await moveToSprint(site, input.sprintId, [key]);
  site.noteWrite(str(created.id) ?? "");
  return getCard(site, key);
}

export async function listTransitions(site: JiraSite, issueKey: string): Promise<JiraTransition[]> {
  const response: Json = await site.get(
    site.api(`/issue/${encodeURIComponent(issueKey)}/transitions`),
    { expand: "transitions.fields" },
  );
  return objs(response.transitions).map((transition) => {
    const fields = obj(transition.fields) ?? {};
    return {
      id: str(transition.id) ?? "",
      name: str(transition.name) ?? "",
      to: mapStatus(transition.to),
      hasScreen: bool(transition.hasScreen),
      fields: Object.entries(fields).map(([fieldId, meta]) =>
        fieldView({
          fieldId,
          meta: obj(meta) ?? {},
          raw: obj(meta)?.defaultValue,
          flavor: site.flavor,
          editable: true,
        }),
      ),
    };
  });
}

export async function runTransition(
  site: JiraSite,
  issueKey: string,
  input: {
    transitionId: string;
    fields?: Record<string, JiraFieldInput>;
    commentMarkdown?: string;
  },
): Promise<JiraIssueCard> {
  const path = site.api(`/issue/${encodeURIComponent(issueKey)}/transitions`);
  let fields: Json = {};
  if (input.fields && Object.keys(input.fields).length > 0) {
    const response: Json = await site.get(path, {
      expand: "transitions.fields",
      transitionId: input.transitionId,
    });
    const match = objs(response.transitions).find((t) => str(t.id) === input.transitionId);
    fields = mapFieldInputs(site, obj(match?.fields) ?? {}, input.fields);
  }
  await site.post(path, {
    transition: { id: input.transitionId },
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(input.commentMarkdown
      ? { update: { comment: [{ add: { body: site.flavor.writeText(input.commentMarkdown) } }] } }
      : {}),
  });
  const card = await getCard(site, issueKey);
  site.noteWrite(card.id);
  return card;
}

export async function assign(
  site: JiraSite,
  issueKey: string,
  assignee: JiraAssignee,
): Promise<JiraUser | null> {
  let ref: string | null = null;
  if (assignee.kind === "me") ref = site.myRef;
  if (assignee.kind === "user") ref = assignee.ref;
  await site.put(
    site.api(`/issue/${encodeURIComponent(issueKey)}/assignee`),
    site.flavor.userBody(ref),
  );
  const card = await getCard(site, issueKey);
  site.noteWrite(card.id);
  return card.assignee;
}

export async function setWatching(
  site: JiraSite,
  issueKey: string,
  watching: boolean,
): Promise<{ watching: boolean; watchCount: number }> {
  const path = site.api(`/issue/${encodeURIComponent(issueKey)}/watchers`);
  if (watching) await site.post(path, site.myRef);
  else await site.delete(path, { [site.flavor.userParam]: site.myRef });
  const state: Json = await site.get(path);
  return { watching: bool(state.isWatching), watchCount: num(state.watchCount) ?? 0 };
}

export async function changelog(
  site: JiraSite,
  issueKey: string,
  startAt = 0,
): Promise<{ entries: JiraChangelogEntry[]; total: number; startAt: number }> {
  const key = encodeURIComponent(issueKey);
  if (site.flavor.deployment === "cloud") {
    const page: Json = await site.get(site.api(`/issue/${key}/changelog`), {
      startAt,
      maxResults: 50,
    });
    const entries = objs(page.values).map((entry) => mapChangelog(entry, site.flavor));
    return { entries, total: num(page.total) ?? entries.length, startAt };
  }
  // Data Center 9.x has no changelog endpoint; the issue expands it.
  const issue: Json = await site.get(site.api(`/issue/${key}`), {
    expand: "changelog",
    fields: "summary",
  });
  const histories = objs(obj(issue.changelog)?.histories);
  const entries = histories.slice(startAt, startAt + 50).map((e) => mapChangelog(e, site.flavor));
  return { entries, total: histories.length, startAt };
}

/** The issue's attachments, which comment media and `!file!` references resolve against. */
async function issueAttachments(site: JiraSite, issueKey: string): Promise<JiraAttachment[]> {
  const issue: Json = await site.get(site.api(`/issue/${encodeURIComponent(issueKey)}`), {
    fields: "attachment",
  });
  return objs(obj(issue.fields)?.attachment).map((a) => mapAttachment(a, site.flavor));
}

export async function listComments(
  site: JiraSite,
  issueKey: string,
  startAt = 0,
): Promise<{ comments: JiraComment[]; total: number; startAt: number }> {
  const [page, attachments] = await Promise.all([
    site.get<Json>(site.api(`/issue/${encodeURIComponent(issueKey)}/comment`), {
      startAt,
      maxResults: 50,
      orderBy: "-created",
    }),
    issueAttachments(site, issueKey),
  ]);
  const comments = objs(page.comments).map((c) =>
    mapComment(c, site.flavor, site.myRef, attachments),
  );
  return { comments, total: num(page.total) ?? comments.length, startAt };
}

export async function addComment(
  site: JiraSite,
  issueKey: string,
  markdown: string,
): Promise<JiraComment> {
  const created: Json = await site.post(
    site.api(`/issue/${encodeURIComponent(issueKey)}/comment`),
    {
      body: site.flavor.writeText(markdown),
    },
  );
  return mapComment(created, site.flavor, site.myRef, await issueAttachments(site, issueKey));
}

export async function updateComment(
  site: JiraSite,
  issueKey: string,
  commentId: string,
  markdown: string,
): Promise<JiraComment> {
  const updated: Json = await site.put(
    site.api(`/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`),
    { body: site.flavor.writeText(markdown) },
  );
  return mapComment(updated, site.flavor, site.myRef, await issueAttachments(site, issueKey));
}

export async function listWorklogs(
  site: JiraSite,
  issueKey: string,
  startAt = 0,
): Promise<{ worklogs: JiraWorklog[]; total: number; startAt: number }> {
  const page: Json = await site.get(site.api(`/issue/${encodeURIComponent(issueKey)}/worklog`), {
    startAt,
    maxResults: 50,
  });
  const worklogs = objs(page.worklogs).map((w) => mapWorklog(w, site.flavor));
  return { worklogs, total: num(page.total) ?? worklogs.length, startAt };
}

export async function addWorklog(
  site: JiraSite,
  issueKey: string,
  input: {
    timeSpent: string;
    started_ms: number;
    commentMarkdown?: string;
    remainingEstimate?: JiraRemainingEstimate;
  },
): Promise<JiraWorklog> {
  const remaining = input.remainingEstimate ?? { kind: "auto" };
  const created: Json = await site.post(
    site.api(`/issue/${encodeURIComponent(issueKey)}/worklog`),
    {
      timeSpent: input.timeSpent,
      started: toJiraTime(input.started_ms),
      ...(input.commentMarkdown ? { comment: site.flavor.writeText(input.commentMarkdown) } : {}),
    },
    {
      adjustEstimate: remaining.kind,
      ...(remaining.kind === "new" ? { newEstimate: remaining.value } : {}),
    },
  );
  return mapWorklog(created, site.flavor);
}

export async function uploadAttachment(
  site: JiraSite,
  issueKey: string,
  input: { fileName: string; mimeType: string; bytes: Buffer },
): Promise<JiraAttachment[]> {
  if (input.bytes.length > JIRA_ATTACHMENT_MAX_BYTES) {
    throw new JiraApiError({
      code: "too_large",
      message: "Attachments are limited to 10 MB here.",
    });
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
    input.fileName,
  );
  const created = await site.upload<unknown>(
    site.api(`/issue/${encodeURIComponent(issueKey)}/attachments`),
    form,
  );
  return objs(created).map((a) => mapAttachment(a, site.flavor));
}

export interface AttachmentBytes {
  fileName: string;
  mimeType: string;
  size: number;
  bytes: Buffer;
}

export async function downloadAttachment(
  site: JiraSite,
  attachmentId: string,
  variant: "content" | "thumbnail",
  maxBytes = JIRA_ATTACHMENT_MAX_BYTES,
): Promise<AttachmentBytes> {
  const id = encodeURIComponent(attachmentId);
  const meta: Json = await site.get(site.api(`/attachment/${id}`));
  const size = num(meta.size) ?? 0;
  if (variant === "content" && size > maxBytes) {
    throw new JiraApiError({
      code: "too_large",
      message: `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`,
    });
  }
  // Cloud serves bytes from /attachment/content|thumbnail/{id} (following its redirect);
  // Data Center reports a same-site URL in the metadata.
  const path =
    site.flavor.deployment === "cloud"
      ? site.api(`/attachment/${variant}/${id}`)
      : (str(variant === "content" ? meta.content : meta.thumbnail) ?? "");
  if (!path) throw new JiraApiError({ code: "not_found", message: "No preview for this file." });
  const { bytes, contentType } = await site.bytes(path, maxBytes);
  return {
    fileName: str(meta.filename) ?? attachmentId,
    mimeType: variant === "content" ? (str(meta.mimeType) ?? contentType) : contentType,
    size: bytes.length,
    bytes,
  };
}

export async function deleteAttachment(site: JiraSite, attachmentId: string): Promise<void> {
  await site.delete(site.api(`/attachment/${encodeURIComponent(attachmentId)}`));
}

export async function addLink(
  site: JiraSite,
  issueKey: string,
  link: JiraLinkInput,
): Promise<void> {
  if (link.kind === "web") {
    await site.post(site.api(`/issue/${encodeURIComponent(issueKey)}/remotelink`), {
      object: { url: link.url, title: link.title },
    });
    return;
  }
  // The inwardIssue reads the type's outward phrase toward the outwardIssue: for "Blocks",
  // { inwardIssue: A, outwardIssue: B } shows "A blocks B" on A.
  const outward = link.direction === "outward";
  await site.post(site.api("/issueLink"), {
    type: { name: link.linkTypeName },
    inwardIssue: { key: outward ? issueKey : link.targetKey },
    outwardIssue: { key: outward ? link.targetKey : issueKey },
  });
}

export async function search(
  site: JiraSite,
  input: { jql: string; nextPageToken?: string; maxResults?: number },
): Promise<{ issues: JiraIssueCard[]; nextPageToken: string | null; total: number | null }> {
  const context = await site.cardContext(null);
  const maxResults = Math.min(100, input.maxResults ?? 50);
  const fields = cardFields(context).join(",");
  if (site.flavor.deployment === "cloud") {
    const reconcile = site.reconcileIds();
    const page: Json = await site.get(site.flavor.search, {
      jql: input.jql,
      fields,
      maxResults,
      nextPageToken: input.nextPageToken,
      reconcileIssues: reconcile.length > 0 ? reconcile : undefined,
    });
    return {
      issues: objs(page.issues).map((issue) => mapCard(issue, context)),
      nextPageToken: str(page.nextPageToken),
      total: null,
    };
  }
  const startAt = Number(input.nextPageToken ?? "0") || 0;
  const page: Json = await site.get(site.flavor.search, {
    jql: input.jql,
    fields,
    maxResults,
    startAt,
  });
  const issues = objs(page.issues).map((issue) => mapCard(issue, context));
  const total = num(page.total);
  const next = startAt + issues.length;
  return {
    issues,
    nextPageToken: total !== null && next < total && issues.length > 0 ? String(next) : null,
    total,
  };
}

export async function jqlSuggest(
  site: JiraSite,
  input: { fieldName?: string; value?: string },
): Promise<JiraSuggestion[]> {
  if (input.fieldName) {
    const response: Json = await site.get(site.api("/jql/autocompletedata/suggestions"), {
      fieldName: input.fieldName,
      fieldValue: input.value ?? "",
    });
    return objs(response.results).map((result) => ({
      value: str(result.value) ?? "",
      label: stripTags(str(result.displayName) ?? str(result.value) ?? ""),
    }));
  }
  const data: Json = await site.get(site.api("/jql/autocompletedata"));
  const needle = input.value?.toLowerCase() ?? "";
  const fieldNames = objs(data.visibleFieldNames).map((field) => ({
    value: str(field.value) ?? "",
    label: stripTags(str(field.displayName) ?? str(field.value) ?? ""),
  }));
  const functions = objs(data.visibleFunctionNames).map((fn) => ({
    value: str(fn.value) ?? "",
    label: stripTags(str(fn.displayName) ?? str(fn.value) ?? ""),
  }));
  return [...fieldNames, ...functions]
    .filter((s) => needle.length === 0 || s.label.toLowerCase().includes(needle))
    .slice(0, 50);
}

function mapFilter(value: Json, mine: boolean): JiraFilter {
  return {
    id: str(value.id) ?? "",
    name: str(value.name) ?? "",
    jql: str(value.jql) ?? "",
    favourite: bool(value.favourite),
    owner: str(obj(value.owner)?.displayName),
    mine,
  };
}

export async function listFilters(site: JiraSite): Promise<JiraFilter[]> {
  const favourites = objs(await site.get<unknown>(site.api("/filter/favourite")));
  let mine: Json[] = [];
  try {
    mine = objs(await site.get<unknown>(site.api("/filter/my")));
  } catch (error) {
    // Some Data Center versions lack /filter/my; favourites still list.
    if (!(error instanceof JiraApiError && error.code === "not_found")) throw error;
  }
  const byId = new Map<string, JiraFilter>();
  for (const filter of mine) byId.set(str(filter.id) ?? "", mapFilter(filter, true));
  for (const filter of favourites) {
    const id = str(filter.id) ?? "";
    const existing = byId.get(id);
    const ownedByMe = site.flavor.userRef(obj(filter.owner) ?? {}) === site.myRef;
    byId.set(id, existing ? { ...existing, favourite: true } : mapFilter(filter, ownedByMe));
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveFilter(
  site: JiraSite,
  input: { name: string; jql: string; description?: string; favourite?: boolean },
): Promise<JiraFilter> {
  const created: Json = await site.post(site.api("/filter"), {
    name: input.name,
    jql: input.jql,
    ...(input.description ? { description: input.description } : {}),
    favourite: input.favourite ?? true,
  });
  return mapFilter(created, true);
}

export async function findUsers(
  site: JiraSite,
  input: { query: string; issueKey?: string; projectKey?: string },
): Promise<JiraUser[]> {
  const scoped = input.issueKey || input.projectKey;
  const path = site.api(scoped ? "/user/assignable/search" : "/user/search");
  const users = objs(
    await site.get<unknown>(path, {
      [site.flavor.userSearchParam]: input.query,
      ...(input.issueKey ? { issueKey: input.issueKey } : {}),
      ...(!input.issueKey && input.projectKey ? { project: input.projectKey } : {}),
      maxResults: 20,
    }),
  );
  return users
    .map((user) => mapUser(user, site.flavor))
    .filter((user): user is JiraUser => user !== null);
}
