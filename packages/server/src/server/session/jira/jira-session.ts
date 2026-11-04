import { randomUUID } from "node:crypto";
import type pino from "pino";
import {
  JIRA_BOARD_MAX_ISSUES,
  JiraResponseSchemas,
  type JiraError,
  type JiraRequest,
  type JiraRequestType,
  type JiraResponse,
  type JiraResponseData,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import * as board from "../../jira/board-ops.js";
import { JiraApiError } from "../../jira/errors.js";
import * as issues from "../../jira/issue-ops.js";
import type { JiraService } from "../../jira/service.js";

// The jira.* RPC surface of one client session (spec 29.5). Every request gets exactly one
// response — an error response on failure, never a throw into the socket loop. Request bodies are
// never logged (connections.add and oauth.* carry secrets). Watches opened by this session stop
// when it unwatches or disconnects.

type Req<T extends JiraRequestType> = Extract<JiraRequest, { type: T }>;

function toWireError(error: unknown): JiraError {
  if (error instanceof JiraApiError) return error.toWire();
  return { code: "jira_error", message: error instanceof Error ? error.message : String(error) };
}

const RESPONSE_SCHEMAS = new Map(
  JiraResponseSchemas.map((schema) => [schema.shape.type.value as string, schema]),
);

// The response goes through its own wire schema: what leaves the daemon is exactly the
// allowlisted DTO shape (ADR-0034 §1), and a mapping bug surfaces as an error response.
function buildResponse(type: string, payload: Record<string, unknown>): JiraResponse {
  const schema = RESPONSE_SCHEMAS.get(type);
  if (!schema) throw new Error(`No Jira response schema for ${type}`);
  return schema.parse({ type, payload });
}

export function isJiraRequest(msg: SessionInboundMessage): msg is JiraRequest {
  return msg.type.startsWith("jira.");
}

export class JiraSession {
  private readonly owner = `jira-session-${randomUUID()}`;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly options: {
      service: JiraService;
      emit: (msg: SessionOutboundMessage) => void;
      logger: pino.Logger;
    },
  ) {
    this.unsubscribe = options.service.onEvent((event) => options.emit(event));
  }

  dispose(): void {
    this.unsubscribe();
    this.options.service.watches.unwatchOwner(this.owner);
  }

  private watchKey(watchId: string): string {
    return `${this.owner}/${watchId}`;
  }

  private async respond<T extends JiraRequestType>(
    msg: Req<T>,
    run: () => Promise<JiraResponseData<T>>,
    empty: JiraResponseData<T>,
  ): Promise<void> {
    const responseType = msg.type.replace(/\.request$/, ".response");
    let data: JiraResponseData<T> = empty;
    let error: JiraError | null = null;
    try {
      data = await run();
    } catch (caught) {
      error = toWireError(caught);
      this.options.logger.info({ type: msg.type, code: error.code }, "jira rpc failed");
    }
    let response: JiraResponse;
    try {
      response = buildResponse(responseType, { requestId: msg.requestId, error, ...data });
    } catch (invalid) {
      this.options.logger.error({ type: msg.type, err: String(invalid) }, "jira response invalid");
      response = buildResponse(responseType, {
        requestId: msg.requestId,
        error: { code: "jira_error", message: "Jira returned data JAgentDesk could not read." },
        ...empty,
      });
    }
    this.options.emit(response);
  }

  // oxlint-disable-next-line complexity, max-lines-per-function
  handle(msg: JiraRequest): Promise<void> {
    const s = this.options.service;
    const site = (connectionId: string) => s.site(connectionId);
    switch (msg.type) {
      case "jira.connections.list.request":
        return this.respond(msg, async () => ({ connections: s.listConnections() }), {
          connections: [],
        });
      case "jira.connections.add.request":
        return this.respond(msg, async () => ({ connection: await s.addTokenConnection(msg) }), {
          connection: null,
        });
      case "jira.connections.remove.request":
        return this.respond(
          msg,
          async () => {
            await s.removeConnection(msg.connectionId);
            return {};
          },
          {},
        );
      case "jira.connections.test.request":
        return this.respond(
          msg,
          async () => ({ connection: await s.testConnection(msg.connectionId) }),
          { connection: null },
        );
      case "jira.oauth.begin.request":
        return this.respond(msg, async () => s.beginOAuth(msg), {
          state: "",
          authorizeUrl: "",
          redirectUri: "",
          expiresAt_ms: 0,
        });
      case "jira.oauth.delegate.request":
        return this.respond(msg, async () => s.delegateOAuth(msg), {
          state: "",
          authorizeUrl: "",
          redirectUri: "",
          expiresAt_ms: 0,
        });
      case "jira.oauth.complete.request":
        return this.respond(msg, async () => s.completeOAuth(msg), {
          connection: null,
          sites: null,
        });
      case "jira.projects.list.request":
        return this.respond(
          msg,
          async () => ({ projects: await board.listProjects(site(msg.connectionId), msg.query) }),
          { projects: [] },
        );
      case "jira.boards.list.request":
        return this.respond(
          msg,
          async () => ({ boards: await board.listBoards(site(msg.connectionId), msg) }),
          { boards: [] },
        );
      case "jira.boards.get.request":
        return this.respond(
          msg,
          async () => ({ board: await board.getBoard(site(msg.connectionId), msg.boardId) }),
          { board: null },
        );
      case "jira.boards.configuration.request":
        return this.respond(
          msg,
          async () => ({
            configuration: (await board.boardSetup(site(msg.connectionId), msg.boardId))
              .configuration,
          }),
          { configuration: null },
        );
      case "jira.board.issues.request":
        return this.respond(
          msg,
          async () => {
            const swimlanes = await s.getSwimlanes(msg.connectionId, msg.boardId);
            const result = await board.boardIssues(site(msg.connectionId), {
              boardId: msg.boardId,
              filter: msg.filter,
              swimlanes,
            });
            return { ...result, swimlanes };
          },
          {
            issues: [],
            lanes: [],
            swimlanes: { mode: "none", queries: [] },
            sprint: null,
            truncated: false,
          },
        );
      case "jira.board.watch.request":
        return this.respond(
          msg,
          async () => {
            site(msg.connectionId);
            s.watches.watchBoard({
              watchId: this.watchKey(msg.watchId),
              owner: this.owner,
              connectionId: msg.connectionId,
              boardId: msg.boardId,
              onChange: (issueKeys) =>
                this.options.emit({
                  type: "jira.board.changed",
                  watchId: msg.watchId,
                  connectionId: msg.connectionId,
                  boardId: msg.boardId,
                  issueKeys,
                }),
            });
            return {};
          },
          {},
        );
      case "jira.board.unwatch.request":
      case "jira.issue.unwatch.request":
        return this.respond(
          msg,
          async () => {
            s.watches.unwatch(this.watchKey(msg.watchId));
            return {};
          },
          {},
        );
      case "jira.backlog.get.request":
        return this.respond(
          msg,
          async () => board.backlog(site(msg.connectionId), msg.boardId, JIRA_BOARD_MAX_ISSUES),
          {
            sprints: [],
            backlog: [],
            epics: [],
            versions: [],
          },
        );
      case "jira.sprints.list.request":
        return this.respond(
          msg,
          async () => ({
            sprints: await board.listSprints(site(msg.connectionId), msg.boardId, msg.states),
          }),
          { sprints: [] },
        );
      case "jira.sprints.create.request":
        return this.respond(
          msg,
          async () => ({ sprint: await board.createSprint(site(msg.connectionId), msg) }),
          { sprint: null },
        );
      case "jira.sprints.start.request":
        return this.respond(
          msg,
          async () => ({
            sprint: await board.updateSprint(site(msg.connectionId), msg.sprintId, {
              name: msg.name,
              goal: msg.goal,
              state: "active",
              startDate_ms: msg.startDate_ms,
              endDate_ms: msg.endDate_ms,
            }),
          }),
          { sprint: null },
        );
      case "jira.sprints.complete.request":
        return this.respond(
          msg,
          async () =>
            board.completeSprint(site(msg.connectionId), {
              boardId: msg.boardId,
              sprintId: msg.sprintId,
              destination: msg.incompleteDestination,
            }),
          { sprint: null, movedIssueKeys: [] },
        );
      case "jira.sprints.move_issues.request":
        return this.respond(
          msg,
          async () => {
            const target = site(msg.connectionId);
            if (msg.target.kind === "sprint") {
              await board.moveToSprint(target, msg.target.sprintId, msg.issueKeys);
            } else {
              await board.moveToBacklog(target, msg.issueKeys);
            }
            return {};
          },
          {},
        );
      case "jira.issue.get.request":
        return this.respond(
          msg,
          async () => ({ issue: await issues.getIssue(site(msg.connectionId), msg.issueKey) }),
          { issue: null },
        );
      case "jira.issue.create.request":
        return this.respond(
          msg,
          async () => ({ issue: await issues.createIssue(site(msg.connectionId), msg) }),
          { issue: null },
        );
      case "jira.issue.create_meta.request":
        return this.respond(
          msg,
          async () => issues.createMeta(site(msg.connectionId), msg.projectKey, msg.issueTypeId),
          { issueTypes: [], fields: [] },
        );
      case "jira.issue.update.request":
        return this.respond(
          msg,
          async () => ({
            issue: await issues.updateIssue(site(msg.connectionId), msg.issueKey, msg),
          }),
          { issue: null },
        );
      case "jira.issue.transitions.request":
        return this.respond(
          msg,
          async () => ({
            transitions: await issues.listTransitions(site(msg.connectionId), msg.issueKey),
          }),
          { transitions: [] },
        );
      case "jira.issue.transition.request":
        return this.respond(
          msg,
          async () => ({
            issue: await issues.runTransition(site(msg.connectionId), msg.issueKey, msg),
          }),
          { issue: null },
        );
      case "jira.issue.assign.request":
        return this.respond(
          msg,
          async () => ({
            assignee: await issues.assign(site(msg.connectionId), msg.issueKey, msg.assignee),
          }),
          { assignee: null },
        );
      case "jira.issue.rank.request":
        return this.respond(
          msg,
          async () => {
            await board.rankIssues(site(msg.connectionId), msg);
            return {};
          },
          {},
        );
      case "jira.issue.watch.request":
        return this.respond(
          msg,
          async () => {
            site(msg.connectionId);
            s.watches.watchIssue({
              watchId: this.watchKey(msg.watchId),
              owner: this.owner,
              connectionId: msg.connectionId,
              issueKey: msg.issueKey,
              onChange: (updated_ms) =>
                this.options.emit({
                  type: "jira.issue.changed",
                  watchId: msg.watchId,
                  connectionId: msg.connectionId,
                  issueKey: msg.issueKey,
                  updated_ms,
                }),
            });
            return {};
          },
          {},
        );
      case "jira.issue.watchers.set.request":
        return this.respond(
          msg,
          async () => issues.setWatching(site(msg.connectionId), msg.issueKey, msg.watching),
          { watching: false, watchCount: 0 },
        );
      case "jira.issue.changelog.list.request":
        return this.respond(
          msg,
          async () => issues.changelog(site(msg.connectionId), msg.issueKey, msg.startAt),
          { entries: [], total: 0, startAt: 0 },
        );
      case "jira.issue.comments.list.request":
        return this.respond(
          msg,
          async () => issues.listComments(site(msg.connectionId), msg.issueKey, msg.startAt),
          { comments: [], total: 0, startAt: 0 },
        );
      case "jira.issue.comments.add.request":
        return this.respond(
          msg,
          async () => ({
            comment: await issues.addComment(
              site(msg.connectionId),
              msg.issueKey,
              msg.bodyMarkdown,
            ),
          }),
          { comment: null },
        );
      case "jira.issue.comments.update.request":
        return this.respond(
          msg,
          async () => ({
            comment: await issues.updateComment(
              site(msg.connectionId),
              msg.issueKey,
              msg.commentId,
              msg.bodyMarkdown,
            ),
          }),
          { comment: null },
        );
      case "jira.issue.worklog.list.request":
        return this.respond(
          msg,
          async () => issues.listWorklogs(site(msg.connectionId), msg.issueKey, msg.startAt),
          { worklogs: [], total: 0, startAt: 0 },
        );
      case "jira.issue.worklog.add.request":
        return this.respond(
          msg,
          async () => ({
            worklog: await issues.addWorklog(site(msg.connectionId), msg.issueKey, msg),
          }),
          { worklog: null },
        );
      case "jira.issue.attachments.upload.request":
        return this.respond(
          msg,
          async () => ({
            attachments: await issues.uploadAttachment(site(msg.connectionId), msg.issueKey, {
              fileName: msg.fileName,
              mimeType: msg.mimeType,
              bytes: Buffer.from(msg.dataBase64, "base64"),
            }),
          }),
          { attachments: [] },
        );
      case "jira.issue.attachments.download.request":
        return this.respond(
          msg,
          async () => {
            const file = await issues.downloadAttachment(
              site(msg.connectionId),
              msg.attachmentId,
              msg.variant,
            );
            return {
              fileName: file.fileName,
              mimeType: file.mimeType,
              size: file.size,
              dataBase64: file.bytes.toString("base64"),
            };
          },
          { fileName: "", mimeType: "", size: 0, dataBase64: "" },
        );
      case "jira.issue.attachments.delete.request":
        return this.respond(
          msg,
          async () => {
            await issues.deleteAttachment(site(msg.connectionId), msg.attachmentId);
            return {};
          },
          {},
        );
      case "jira.issue.links.add.request":
        return this.respond(
          msg,
          async () => {
            await issues.addLink(site(msg.connectionId), msg.issueKey, msg.link);
            return {};
          },
          {},
        );
      case "jira.search.request":
        return this.respond(msg, async () => issues.search(site(msg.connectionId), msg), {
          issues: [],
          nextPageToken: null,
          total: null,
        });
      case "jira.jql.suggest.request":
        return this.respond(
          msg,
          async () => ({ suggestions: await issues.jqlSuggest(site(msg.connectionId), msg) }),
          { suggestions: [] },
        );
      case "jira.filters.list.request":
        return this.respond(
          msg,
          async () => ({ filters: await issues.listFilters(site(msg.connectionId)) }),
          { filters: [] },
        );
      case "jira.filters.save.request":
        return this.respond(
          msg,
          async () => ({ filter: await issues.saveFilter(site(msg.connectionId), msg) }),
          { filter: null },
        );
      case "jira.users.find.request":
        return this.respond(
          msg,
          async () => ({ users: await issues.findUsers(site(msg.connectionId), msg) }),
          { users: [] },
        );
      case "jira.swimlanes.get.request":
        return this.respond(
          msg,
          async () => ({ swimlanes: await s.getSwimlanes(msg.connectionId, msg.boardId) }),
          { swimlanes: { mode: "none", queries: [] } },
        );
      case "jira.swimlanes.set.request":
        return this.respond(
          msg,
          async () => ({
            swimlanes: await s.setSwimlanes(msg.connectionId, msg.boardId, msg.swimlanes),
          }),
          { swimlanes: { mode: "none", queries: [] } },
        );
    }
  }
}
