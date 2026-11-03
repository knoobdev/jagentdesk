import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { jiraCardLine, jiraIssueMarkdown } from "@jagentdesk/protocol/jira/issue-markdown";
import {
  type JiraIssueCard,
  JiraFieldInputSchema,
  JiraRemainingEstimateSchema,
  JiraSprintDestinationSchema,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { JAgentDeskToolDefinition, JAgentDeskToolResult } from "../agent/tools/types.js";
import * as board from "./board-ops.js";
import { JiraApiError } from "./errors.js";
import * as issues from "./issue-ops.js";
import type { JiraService } from "./service.js";
import type { JiraSite } from "./site.js";

// jira_* agent tools (spec 29.4). Reads run without asking; every write raises the permission
// card (04.21) first and runs only on "allow". There is no delete tool. Results are compact
// Markdown, never raw ADF.

export const JIRA_TOOL_ATTACHMENT_MAX_BYTES = 256 * 1024;

export interface JiraToolPermissionRequest {
  name: string;
  kind: "tool";
  title: string;
  description: string;
  input: Record<string, unknown>;
}

export type RequestJiraToolPermission = (
  agentId: string,
  request: JiraToolPermissionRequest,
) => Promise<AgentPermissionResponse>;

export interface JiraAgentTool extends JAgentDeskToolDefinition {
  requiresPermission: boolean;
}

export interface JiraAgentToolDependencies {
  service: JiraService;
  callerAgentId: string | null;
  requestPermission: RequestJiraToolPermission;
}

class ToolFailure extends Error {}

function text(markdown: string): JAgentDeskToolResult {
  return { content: [{ type: "text", text: markdown }] };
}

const connectionIdInput = z
  .string()
  .optional()
  .describe("Jira connection id (jir_…). Optional when only one connection exists.");
const connectionSchema = z.object({ connectionId: connectionIdInput });
const issueKeyInput = z.string().min(1).describe("Issue key, e.g. ABC-12");

interface ToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  /** Present for writes: what the permission card shows. */
  permission?: (
    input: z.infer<z.ZodObject<Shape>>,
  ) => Omit<JiraToolPermissionRequest, "name" | "kind">;
  run: (input: z.infer<z.ZodObject<Shape>>, site: JiraSite) => Promise<string>;
}

function define<Shape extends z.ZodRawShape>(
  deps: JiraAgentToolDependencies,
  spec: ToolSpec<Shape>,
): JiraAgentTool {
  const schema = z.object(spec.inputSchema);
  const suffix = spec.permission ? " Requires the user's approval." : " Read-only, auto-approved.";
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description + suffix,
    inputSchema: spec.inputSchema,
    requiresPermission: spec.permission !== undefined,
    async handler(raw: unknown) {
      try {
        const input = schema.parse(raw);
        const requested = connectionSchema.parse(raw).connectionId;
        const connectionId = requested ?? deps.service.defaultConnectionId();
        const site = deps.service.site(connectionId);
        if (spec.permission) {
          if (!deps.callerAgentId) {
            throw new ToolFailure(`${spec.name} is only available to agent-scoped tool sessions.`);
          }
          const ask = spec.permission(input);
          const decision = await deps.requestPermission(deps.callerAgentId, {
            name: spec.name,
            kind: "tool",
            ...ask,
          });
          if (decision.behavior !== "allow") throw new ToolFailure("Denied by user.");
        }
        return text(await spec.run(input, site));
      } catch (error) {
        const message =
          error instanceof JiraApiError ||
          error instanceof ToolFailure ||
          error instanceof z.ZodError
            ? error.message
            : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  };
}

function cards(list: JiraIssueCard[]): string {
  return list.length > 0 ? list.map(jiraCardLine).join("\n") : "(none)";
}

// oxlint-disable-next-line max-lines-per-function
function readTools(deps: JiraAgentToolDependencies): JiraAgentTool[] {
  return [
    define(deps, {
      name: "jira_list_projects",
      title: "List Jira projects",
      description: "Find Jira projects by name or key.",
      inputSchema: { connectionId: connectionIdInput, query: z.string().optional() },
      async run(input, site) {
        const projects = await board.listProjects(site, input.query);
        return projects.map((p) => `- ${p.key}: ${p.name}`).join("\n") || "(none)";
      },
    }),
    define(deps, {
      name: "jira_search",
      title: "Search Jira issues",
      description:
        "Search issues with JQL (e.g. `project = ABC AND assignee = currentUser() ORDER BY updated DESC`). Returns key, type, summary, status, assignee and a nextPageToken when more exist.",
      inputSchema: {
        connectionId: connectionIdInput,
        jql: z.string().min(1),
        nextPageToken: z.string().optional(),
        maxResults: z.number().int().positive().max(100).optional(),
      },
      async run(input, site) {
        const result = await issues.search(site, input);
        const more = result.nextPageToken ? `\n\nnextPageToken: ${result.nextPageToken}` : "";
        return cards(result.issues) + more;
      },
    }),
    define(deps, {
      name: "jira_get_issue",
      title: "Get a Jira issue",
      description:
        "Read an issue: fields, description (Markdown), subtasks, links, web links, attachments and the 5 latest comments.",
      inputSchema: { connectionId: connectionIdInput, issueKey: issueKeyInput },
      async run(input, site) {
        const [detail, comments] = await Promise.all([
          issues.getIssue(site, input.issueKey),
          issues.listComments(site, input.issueKey),
        ]);
        return jiraIssueMarkdown(detail, { comments: comments.comments.slice(0, 5) });
      },
    }),
    define(deps, {
      name: "jira_get_comments",
      title: "Get Jira comments",
      description: "Comments of an issue, newest first, 50 per page.",
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        startAt: z.number().int().min(0).optional(),
      },
      async run(input, site) {
        const page = await issues.listComments(site, input.issueKey, input.startAt);
        const body = page.comments
          .map(
            (c) =>
              `**${c.author?.displayName ?? "Unknown"}** (comment ${c.id}, ${new Date(c.created_ms).toISOString()}):\n${c.body.markdown}`,
          )
          .join("\n\n");
        return `${page.comments.length} of ${page.total} from ${page.startAt}\n\n${body}`;
      },
    }),
    define(deps, {
      name: "jira_get_changelog",
      title: "Get Jira issue history",
      description: "Field changes of an issue (who changed what, when).",
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        startAt: z.number().int().min(0).optional(),
      },
      async run(input, site) {
        const page = await issues.changelog(site, input.issueKey, input.startAt);
        return (
          page.entries
            .flatMap((e) =>
              e.items.map(
                (i) =>
                  `- ${new Date(e.created_ms).toISOString()} ${e.author?.displayName ?? "?"}: ${i.field} ${i.from ?? "∅"} → ${i.to ?? "∅"}`,
              ),
            )
            .join("\n") || "(no changes)"
        );
      },
    }),
    define(deps, {
      name: "jira_get_worklogs",
      title: "Get Jira work logs",
      description: "Time logged on an issue.",
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        startAt: z.number().int().min(0).optional(),
      },
      async run(input, site) {
        const page = await issues.listWorklogs(site, input.issueKey, input.startAt);
        return (
          page.worklogs
            .map(
              (w) =>
                `- ${w.author?.displayName ?? "?"} ${w.timeSpent} on ${new Date(w.started_ms).toISOString()}${w.comment ? `: ${w.comment}` : ""}`,
            )
            .join("\n") || "(no work logged)"
        );
      },
    }),
    define(deps, {
      name: "jira_get_transitions",
      title: "Get Jira transitions",
      description: "Transitions available for an issue now, with the fields each one requires.",
      inputSchema: { connectionId: connectionIdInput, issueKey: issueKeyInput },
      async run(input, site) {
        const list = await issues.listTransitions(site, input.issueKey);
        return list
          .map((t) => {
            const required = t.fields.filter((f) => f.required);
            const fields = required.map(
              (f) =>
                `${f.fieldId} (${f.kind}${f.allowedValues ? `: ${f.allowedValues.map((v) => `${v.id}=${v.name}`).join(", ")}` : ""})`,
            );
            return `- id ${t.id}: ${t.name} → ${t.to.name}${fields.length > 0 ? `; requires ${fields.join("; ")}` : ""}`;
          })
          .join("\n");
      },
    }),
    define(deps, {
      name: "jira_get_create_meta",
      title: "Get Jira create fields",
      description:
        "Issue types of a project, and with issueTypeId the fields needed to create one.",
      inputSchema: {
        connectionId: connectionIdInput,
        projectKey: z.string(),
        issueTypeId: z.string().optional(),
      },
      async run(input, site) {
        const meta = await issues.createMeta(site, input.projectKey, input.issueTypeId);
        const types = meta.issueTypes.map(
          (t) => `- ${t.id}: ${t.name}${t.subtask ? " (subtask)" : ""}`,
        );
        const fields = meta.fields.map(
          (f) => `- ${f.fieldId} ${f.name} (${f.kind}${f.required ? ", required" : ""})`,
        );
        return [
          `Issue types:`,
          ...types,
          ...(fields.length > 0 ? ["", "Fields:", ...fields] : []),
        ].join("\n");
      },
    }),
    define(deps, {
      name: "jira_list_boards",
      title: "List Jira boards",
      description: "Boards, optionally of one project.",
      inputSchema: { connectionId: connectionIdInput, projectKey: z.string().optional() },
      async run(input, site) {
        const list = await board.listBoards(site, { projectKey: input.projectKey });
        return (
          list.map((b) => `- ${b.id}: ${b.name} (${b.type}, ${b.projectKey ?? "—"})`).join("\n") ||
          "(none)"
        );
      },
    }),
    define(deps, {
      name: "jira_get_board",
      title: "Get a Jira board",
      description:
        "A board's columns (with statuses and WIP limits), estimation field and quick filters.",
      inputSchema: { connectionId: connectionIdInput, boardId: z.number().int() },
      async run(input, site) {
        const { configuration: c } = await board.boardSetup(site, input.boardId);
        const status = (id: string) => c.statuses.find((s) => s.id === id)?.name ?? id;
        return [
          `# ${c.name} (${c.type})`,
          "",
          ...c.columns.map(
            (col) =>
              `- ${col.name}: ${col.statusIds.map(status).join(", ")}${col.max !== null ? ` (max ${col.max})` : ""}`,
          ),
          ...(c.quickFilters.length > 0
            ? ["", "Quick filters:", ...c.quickFilters.map((q) => `- ${q.id} ${q.name}: ${q.jql}`)]
            : []),
        ].join("\n");
      },
    }),
    define(deps, {
      name: "jira_list_sprints",
      title: "List Jira sprints",
      description: "Active and future sprints of a board (add closed with states).",
      inputSchema: {
        connectionId: connectionIdInput,
        boardId: z.number().int(),
        states: z.array(z.enum(["future", "active", "closed"])).optional(),
      },
      async run(input, site) {
        const list = await board.listSprints(site, input.boardId, input.states);
        return (
          list
            .map(
              (s) =>
                `- ${s.id}: ${s.name} [${s.state}]${s.endDate_ms ? ` ends ${new Date(s.endDate_ms).toISOString().slice(0, 10)}` : ""}${s.goal ? ` — ${s.goal}` : ""}`,
            )
            .join("\n") || "(none)"
        );
      },
    }),
    define(deps, {
      name: "jira_get_sprint_issues",
      title: "Get Jira sprint issues",
      description: "Issues in a sprint of a board.",
      inputSchema: {
        connectionId: connectionIdInput,
        boardId: z.number().int(),
        sprintId: z.number().int(),
      },
      async run(input, site) {
        const page = await site.issues({
          path: `${site.flavor.boardIssues}/board/${input.boardId}/sprint/${input.sprintId}/issue`,
          context: await site.cardContext(null),
        });
        return cards(page.issues);
      },
    }),
    define(deps, {
      name: "jira_get_backlog",
      title: "Get a Jira backlog",
      description: "Sprints with their issues and the backlog of a board.",
      inputSchema: { connectionId: connectionIdInput, boardId: z.number().int() },
      async run(input, site) {
        const result = await board.backlog(site, input.boardId);
        return [
          ...result.sprints.flatMap((s) => [
            `## ${s.sprint.name} [${s.sprint.state}] (id ${s.sprint.id})`,
            cards(s.issues),
            "",
          ]),
          "## Backlog",
          cards(result.backlog),
        ].join("\n");
      },
    }),
    define(deps, {
      name: "jira_find_users",
      title: "Find Jira users",
      description:
        "Find people (assignable to an issue or project when given). Returns their ref (accountId on Cloud, username on Data Center).",
      inputSchema: {
        connectionId: connectionIdInput,
        query: z.string(),
        issueKey: z.string().optional(),
        projectKey: z.string().optional(),
      },
      async run(input, site) {
        const users = await issues.findUsers(site, input);
        return users.map((u) => `- ${u.displayName}: ${u.ref}`).join("\n") || "(none)";
      },
    }),
    define(deps, {
      name: "jira_list_filters",
      title: "List Jira filters",
      description: "Saved filters that are mine or favourites, with their JQL.",
      inputSchema: { connectionId: connectionIdInput },
      async run(_input, site) {
        const filters = await issues.listFilters(site);
        return (
          filters
            .map((f) => `- ${f.id} ${f.name}${f.favourite ? " ★" : ""}: ${f.jql}`)
            .join("\n") || "(none)"
        );
      },
    }),
    define(deps, {
      name: "jira_get_attachment",
      title: "Read a Jira attachment",
      description: `Read a text attachment (up to ${JIRA_TOOL_ATTACHMENT_MAX_BYTES / 1024} KB). Other files return their size and type only.`,
      inputSchema: { connectionId: connectionIdInput, attachmentId: z.string() },
      async run(input, site) {
        const file = await issues.downloadAttachment(
          site,
          input.attachmentId,
          "content",
          JIRA_TOOL_ATTACHMENT_MAX_BYTES,
        );
        const isText = /^text\/|json|xml|yaml|csv|javascript|typescript/.test(file.mimeType);
        if (!isText)
          return `${file.fileName}: ${file.mimeType}, ${file.size} bytes (binary, not shown).`;
        return `${file.fileName} (${file.mimeType}):\n\n\`\`\`\n${file.bytes.toString("utf8")}\n\`\`\``;
      },
    }),
  ];
}

// oxlint-disable-next-line max-lines-per-function
function writeTools(deps: JiraAgentToolDependencies): JiraAgentTool[] {
  const fieldsInput = z
    .record(z.string(), JiraFieldInputSchema)
    .optional()
    .describe('Field values by field id, e.g. {"priority": {"kind": "option", "id": "2"}}');
  return [
    define(deps, {
      name: "jira_create_issue",
      title: "Create a Jira issue",
      description:
        "Create an issue or subtask (parentKey). Description is Markdown; mention people with [@Name](jira-mention:<ref>).",
      inputSchema: {
        connectionId: connectionIdInput,
        projectKey: z.string(),
        issueTypeId: z.string(),
        summary: z.string().min(1),
        descriptionMarkdown: z.string().optional(),
        parentKey: z.string().optional(),
        sprintId: z.number().int().optional(),
        fields: fieldsInput,
      },
      permission: (input) => ({
        title: `Create a Jira issue in ${input.projectKey}`,
        description: input.summary,
        input,
      }),
      async run(input, site) {
        const card = await issues.createIssue(site, input);
        return `Created ${card.key}.\n${jiraCardLine(card)}`;
      },
    }),
    define(deps, {
      name: "jira_update_issue",
      title: "Update a Jira issue",
      description: "Change summary, description (Markdown) or fields of an issue.",
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        summary: z.string().optional(),
        descriptionMarkdown: z.string().optional(),
        fields: fieldsInput,
      },
      permission: (input) => ({
        title: `Update ${input.issueKey}`,
        description: Object.keys(input)
          .filter((k) => !["connectionId", "issueKey"].includes(k))
          .join(", "),
        input,
      }),
      async run(input, site) {
        const detail = await issues.updateIssue(site, input.issueKey, input);
        return `Updated ${detail.key}.`;
      },
    }),
    define(deps, {
      name: "jira_transition_issue",
      title: "Move a Jira issue",
      description:
        "Run a transition (see jira_get_transitions), with the fields its screen requires and an optional comment.",
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        transitionId: z.string(),
        fields: fieldsInput,
        commentMarkdown: z.string().optional(),
      },
      permission: (input) => ({
        title: `Transition ${input.issueKey}`,
        description: `Transition ${input.transitionId}`,
        input,
      }),
      async run(input, site) {
        const card = await issues.runTransition(site, input.issueKey, input);
        return `${card.key} is now ${card.status.name}.`;
      },
    }),
    define(deps, {
      name: "jira_assign_issue",
      title: "Assign a Jira issue",
      description: 'Assign to "me", to a user ref (jira_find_users), or "none" to unassign.',
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        assignee: z.string(),
      },
      permission: (input) => ({
        title: `Assign ${input.issueKey}`,
        description: `Assign to ${input.assignee}`,
        input,
      }),
      async run(input, site) {
        let assignee: Parameters<typeof issues.assign>[2] = { kind: "user", ref: input.assignee };
        if (input.assignee === "me") assignee = { kind: "me" };
        if (input.assignee === "none") assignee = { kind: "none" };
        const user = await issues.assign(site, input.issueKey, assignee);
        return `${input.issueKey} assigned to ${user?.displayName ?? "nobody"}.`;
      },
    }),
    define(deps, {
      name: "jira_add_comment",
      title: "Comment on a Jira issue",
      description: "Add a Markdown comment (links, code, [@Name](jira-mention:<ref>) mentions).",
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        bodyMarkdown: z.string().min(1),
      },
      permission: (input) => ({
        title: `Comment on ${input.issueKey}`,
        description: input.bodyMarkdown,
        input,
      }),
      async run(input, site) {
        const comment = await issues.addComment(site, input.issueKey, input.bodyMarkdown);
        return `Comment ${comment.id} added to ${input.issueKey}.`;
      },
    }),
    define(deps, {
      name: "jira_add_worklog",
      title: "Log work on a Jira issue",
      description: 'Log time spent ("1h 30m") starting at an ISO time (default now).',
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        timeSpent: z.string(),
        started: z.string().optional(),
        commentMarkdown: z.string().optional(),
        remainingEstimate: JiraRemainingEstimateSchema.optional(),
      },
      permission: (input) => ({
        title: `Log ${input.timeSpent} on ${input.issueKey}`,
        description: input.commentMarkdown ?? "",
        input,
      }),
      async run(input, site) {
        const started = input.started ? Date.parse(input.started) : Date.now();
        if (!Number.isFinite(started)) throw new ToolFailure("started must be an ISO date-time.");
        const worklog = await issues.addWorklog(site, input.issueKey, {
          ...input,
          started_ms: started,
        });
        return `Logged ${worklog.timeSpent} on ${input.issueKey}.`;
      },
    }),
    define(deps, {
      name: "jira_link_issues",
      title: "Link Jira issues",
      description:
        'Link two issues: "<issueKey> <outward phrase> <targetKey>" with direction outward (e.g. Blocks: ABC-1 blocks ABC-2), inward for the reverse.',
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        linkTypeName: z.string(),
        direction: z.enum(["outward", "inward"]),
        targetKey: z.string(),
      },
      permission: (input) => ({
        title: `Link ${input.issueKey} → ${input.targetKey}`,
        description: `${input.linkTypeName} (${input.direction})`,
        input,
      }),
      async run(input, site) {
        await issues.addLink(site, input.issueKey, {
          kind: "issue",
          linkTypeName: input.linkTypeName,
          direction: input.direction,
          targetKey: input.targetKey,
        });
        return `Linked ${input.issueKey} and ${input.targetKey}.`;
      },
    }),
    define(deps, {
      name: "jira_add_remote_link",
      title: "Add a web link to a Jira issue",
      description: "Attach a URL (e.g. the pull request) to an issue's web links.",
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        url: z.string().url(),
        title: z.string().min(1),
      },
      permission: (input) => ({
        title: `Add a web link to ${input.issueKey}`,
        description: `${input.title}: ${input.url}`,
        input,
      }),
      async run(input, site) {
        await issues.addLink(site, input.issueKey, {
          kind: "web",
          url: input.url,
          title: input.title,
        });
        return `Added ${input.url} to ${input.issueKey}.`;
      },
    }),
    define(deps, {
      name: "jira_add_attachment",
      title: "Attach a file to a Jira issue",
      description: "Upload a file from the workspace (absolute path, up to 10 MB).",
      inputSchema: {
        connectionId: connectionIdInput,
        issueKey: issueKeyInput,
        path: z.string().min(1),
        mimeType: z.string().optional(),
      },
      permission: (input) => ({
        title: `Attach a file to ${input.issueKey}`,
        description: input.path,
        input,
      }),
      async run(input, site) {
        const bytes = await readFile(input.path);
        const uploaded = await issues.uploadAttachment(site, input.issueKey, {
          fileName: basename(input.path),
          mimeType: input.mimeType ?? "application/octet-stream",
          bytes,
        });
        return `Attached ${uploaded.map((a) => a.filename).join(", ")} to ${input.issueKey}.`;
      },
    }),
    define(deps, {
      name: "jira_move_to_sprint",
      title: "Move Jira issues to a sprint",
      description: "Move issues into a sprint.",
      inputSchema: {
        connectionId: connectionIdInput,
        sprintId: z.number().int(),
        issueKeys: z.array(z.string()).min(1),
      },
      permission: (input) => ({
        title: `Move ${input.issueKeys.length} issue(s) to sprint ${input.sprintId}`,
        description: input.issueKeys.join(", "),
        input,
      }),
      async run(input, site) {
        await board.moveToSprint(site, input.sprintId, input.issueKeys);
        return `Moved ${input.issueKeys.join(", ")} to sprint ${input.sprintId}.`;
      },
    }),
    define(deps, {
      name: "jira_move_to_backlog",
      title: "Move Jira issues to the backlog",
      description: "Take issues out of their sprint into the backlog.",
      inputSchema: { connectionId: connectionIdInput, issueKeys: z.array(z.string()).min(1) },
      permission: (input) => ({
        title: `Move ${input.issueKeys.length} issue(s) to the backlog`,
        description: input.issueKeys.join(", "),
        input,
      }),
      async run(input, site) {
        await board.moveToBacklog(site, input.issueKeys);
        return `Moved ${input.issueKeys.join(", ")} to the backlog.`;
      },
    }),
    define(deps, {
      name: "jira_rank_issues",
      title: "Rank Jira issues",
      description: "Rank issues before or after another issue.",
      inputSchema: {
        connectionId: connectionIdInput,
        issueKeys: z.array(z.string()).min(1),
        rankBeforeKey: z.string().optional(),
        rankAfterKey: z.string().optional(),
      },
      permission: (input) => ({
        title: `Rank ${input.issueKeys.join(", ")}`,
        description: input.rankBeforeKey
          ? `before ${input.rankBeforeKey}`
          : `after ${input.rankAfterKey ?? "?"}`,
        input,
      }),
      async run(input, site) {
        await board.rankIssues(site, input);
        return `Ranked ${input.issueKeys.join(", ")}.`;
      },
    }),
    define(deps, {
      name: "jira_create_sprint",
      title: "Create a Jira sprint",
      description: "Create a future sprint on a board.",
      inputSchema: {
        connectionId: connectionIdInput,
        boardId: z.number().int(),
        name: z.string().min(1),
        goal: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      },
      permission: (input) => ({
        title: `Create sprint ${input.name}`,
        description: input.goal ?? "",
        input,
      }),
      async run(input, site) {
        const sprint = await board.createSprint(site, {
          boardId: input.boardId,
          name: input.name,
          goal: input.goal,
          startDate_ms: input.startDate ? Date.parse(input.startDate) : undefined,
          endDate_ms: input.endDate ? Date.parse(input.endDate) : undefined,
        });
        return `Created sprint ${sprint.id} ${sprint.name}.`;
      },
    }),
    define(deps, {
      name: "jira_update_sprint",
      title: "Update a Jira sprint",
      description:
        'Rename, set the goal or dates, start (state "active", needs dates) or complete (state "closed", with where open issues go).',
      inputSchema: {
        connectionId: connectionIdInput,
        sprintId: z.number().int(),
        boardId: z.number().int().optional().describe("Required to complete a sprint."),
        name: z.string().optional(),
        goal: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        state: z.enum(["active", "closed"]).optional(),
        incompleteDestination: JiraSprintDestinationSchema.optional(),
      },
      permission: (input) => ({
        title: `Update sprint ${input.sprintId}`,
        description: input.state ? `state → ${input.state}` : "details",
        input,
      }),
      async run(input, site) {
        if (input.state === "closed") {
          if (input.boardId === undefined)
            throw new ToolFailure("boardId is required to complete a sprint.");
          const result = await board.completeSprint(site, {
            boardId: input.boardId,
            sprintId: input.sprintId,
            destination: input.incompleteDestination ?? { kind: "backlog" },
          });
          return `Completed ${result.sprint.name}; moved ${result.movedIssueKeys.length} open issue(s).`;
        }
        const sprint = await board.updateSprint(site, input.sprintId, {
          name: input.name,
          goal: input.goal,
          state: input.state,
          startDate_ms: input.startDate ? Date.parse(input.startDate) : undefined,
          endDate_ms: input.endDate ? Date.parse(input.endDate) : undefined,
        });
        return `Sprint ${sprint.id} ${sprint.name} is ${sprint.state}.`;
      },
    }),
  ];
}

// Needs no site, so it works whatever the number of connections.
function listConnectionsTool(deps: JiraAgentToolDependencies): JiraAgentTool {
  return {
    name: "jira_list_connections",
    title: "List Jira connections",
    description:
      "List the Jira sites JAgentDesk is connected to (id, site, account, state). Read-only, auto-approved.",
    inputSchema: {},
    requiresPermission: false,
    async handler() {
      const lines = deps.service
        .listConnections()
        .map(
          (c) =>
            `- ${c.id}: ${c.label} — ${c.siteUrl} (${c.deployment}, ${c.method}) as ${c.account.displayName} [${c.authState}]`,
        );
      return text(lines.join("\n") || "No Jira connection. Add one in JAgentDesk → Jira.");
    },
  };
}

export function createJiraAgentTools(deps: JiraAgentToolDependencies): JiraAgentTool[] {
  return [listConnectionsTool(deps), ...readTools(deps), ...writeTools(deps)];
}

export const JIRA_READ_TOOL_NAMES = [
  "jira_list_connections",
  "jira_list_projects",
  "jira_search",
  "jira_get_issue",
  "jira_get_comments",
  "jira_get_changelog",
  "jira_get_worklogs",
  "jira_get_transitions",
  "jira_get_create_meta",
  "jira_list_boards",
  "jira_get_board",
  "jira_list_sprints",
  "jira_get_sprint_issues",
  "jira_get_backlog",
  "jira_find_users",
  "jira_list_filters",
  "jira_get_attachment",
] as const;
