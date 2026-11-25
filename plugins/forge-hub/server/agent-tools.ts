// Moved verbatim from core, where lint ran only on edited lines; these rules predate the move.
/* oxlint-disable no-nested-ternary */
import { z } from "zod";
import type {
  BuiltinAgentToolContext,
  JAgentDeskToolExecutionContext,
  JAgentDeskToolResult,
  RegisterBuiltinTool,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import type { ForgeHubService } from "./forge-hub-session.js";

// Forge Hub tools (spec 19 / ADR-0015). These mirror the kubectl_* precedent:
// read tools are auto-approved, write tools are gated behind requestHostToolPermission.
// The generic ForgeHubService methods are GitHub-only; GitLab/Bitbucket use the
// *GitLab*/*Bitbucket* variants, so every non-discovery tool takes a `forge` enum
// and routes with a 3-way branch, matching ForgeHubSession.handle().
export function registerForgeTools(params: {
  registerTool: RegisterBuiltinTool;
  options: {
    forgeHub?: ForgeHubService;
    requestHostToolPermission?: BuiltinAgentToolContext["requestPermission"];
  };
  callerAgentId: string | undefined;
}): void {
  const { registerTool, options, callerAgentId } = params;

  const forgeUnavailable: JAgentDeskToolResult = {
    content: [{ type: "text", text: "Forge is not available." }],
    isError: true,
  };
  const forgeEnum = z.enum(["github", "gitlab", "bitbucket"]);
  const ok = (result: unknown): JAgentDeskToolResult => ({
    content: [{ type: "text", text: JSON.stringify(result) }],
  });
  const fail = (err: unknown): JAgentDeskToolResult => ({
    content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  });

  // READ 1: discovery — fans out to all three forges internally, no routing.
  registerTool(
    "forge_list_repos",
    {
      title: "List forge repositories",
      description:
        "List repositories across all connected forge accounts (GitHub/GitLab/Bitbucket). Returns forge,owner,name to pass to other forge_* tools. (read-only, auto-approved)",
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async (input: { query?: string; limit?: number }) => {
      if (!options.forgeHub) return forgeUnavailable;
      try {
        return ok(await options.forgeHub.listRepos({ query: input.query, limit: input.limit }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // READ 2: pull/merge requests.
  registerTool(
    "forge_list_change_requests",
    {
      title: "List change requests",
      description:
        "List pull requests (GitHub/Bitbucket) or merge requests (GitLab) for a repo. (read-only, auto-approved)",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        state: z.enum(["open", "draft", "merged", "closed", "all"]).optional(),
        limit: z.number().optional(),
      },
    },
    async (input: {
      forge: "github" | "gitlab" | "bitbucket";
      owner: string;
      name: string;
      state?: "open" | "draft" | "merged" | "closed" | "all";
      limit?: number;
    }) => {
      if (!options.forgeHub) return forgeUnavailable;
      const arg = { owner: input.owner, name: input.name, state: input.state, limit: input.limit };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.listChangeRequests(arg)
            : input.forge === "gitlab"
              ? await options.forgeHub.listGitLabChangeRequests(arg)
              : await options.forgeHub.listBitbucketChangeRequests(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // READ 3: changed files of a change request.
  registerTool(
    "forge_get_change_request_files",
    {
      title: "Get change request files",
      description: "List the changed files of a pull/merge request. (read-only, auto-approved)",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        number: z.number(),
      },
    },
    async (input: {
      forge: "github" | "gitlab" | "bitbucket";
      owner: string;
      name: string;
      number: number;
    }) => {
      if (!options.forgeHub) return forgeUnavailable;
      const arg = { owner: input.owner, name: input.name, number: input.number };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.getChangeRequestFiles(arg)
            : input.forge === "gitlab"
              ? await options.forgeHub.getGitLabChangeRequestFiles(arg)
              : await options.forgeHub.getBitbucketChangeRequestFiles(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // READ 4: CI pipeline runs.
  registerTool(
    "forge_list_pipelines",
    {
      title: "List pipelines",
      description: "List recent CI pipeline runs for a repo. (read-only, auto-approved)",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        limit: z.number().optional(),
      },
    },
    async (input: {
      forge: "github" | "gitlab" | "bitbucket";
      owner: string;
      name: string;
      limit?: number;
    }) => {
      if (!options.forgeHub) return forgeUnavailable;
      const arg = { owner: input.owner, name: input.name, limit: input.limit };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.listPipelines(arg)
            : input.forge === "gitlab"
              ? await options.forgeHub.listGitLabPipelines(arg)
              : await options.forgeHub.listBitbucketPipelines(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // READ 5: issues.
  registerTool(
    "forge_list_issues",
    {
      title: "List issues",
      description: "List issues for a repo. (read-only, auto-approved)",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        state: z.enum(["open", "closed", "all"]).optional(),
        limit: z.number().optional(),
      },
    },
    async (input: {
      forge: "github" | "gitlab" | "bitbucket";
      owner: string;
      name: string;
      state?: "open" | "closed" | "all";
      limit?: number;
    }) => {
      if (!options.forgeHub) return forgeUnavailable;
      const arg = { owner: input.owner, name: input.name, state: input.state, limit: input.limit };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.listIssues(arg)
            : input.forge === "gitlab"
              ? await options.forgeHub.listGitLabIssues(arg)
              : await options.forgeHub.listBitbucketIssues(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // READ 6: file contents at a ref. The service methods require a ref; default to
  // "HEAD" (the default branch tip) when the caller omits one.
  registerTool(
    "forge_read_file",
    {
      title: "Read forge file",
      description:
        "Read a file's contents from a repo at a ref (defaults to HEAD). (read-only, auto-approved)",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        path: z.string(),
        ref: z.string().optional(),
      },
    },
    async (input: {
      forge: "github" | "gitlab" | "bitbucket";
      owner: string;
      name: string;
      path: string;
      ref?: string;
    }) => {
      if (!options.forgeHub) return forgeUnavailable;
      const arg = {
        owner: input.owner,
        name: input.name,
        path: input.path,
        ref: input.ref ?? "HEAD",
      };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.getFile(arg)
            : input.forge === "gitlab"
              ? await options.forgeHub.getGitLabFile(arg)
              : await options.forgeHub.getBitbucketFile(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // READ 7: commits.
  registerTool(
    "forge_list_commits",
    {
      title: "List commits",
      description: "List recent commits for a repo. (read-only, auto-approved)",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        limit: z.number().optional(),
      },
    },
    async (input: {
      forge: "github" | "gitlab" | "bitbucket";
      owner: string;
      name: string;
      limit?: number;
    }) => {
      if (!options.forgeHub) return forgeUnavailable;
      const arg = { owner: input.owner, name: input.name, limit: input.limit };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.listCommits(arg)
            : input.forge === "gitlab"
              ? await options.forgeHub.listGitLabCommits(arg)
              : await options.forgeHub.listBitbucketCommits(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // WRITE 8: comment on an issue. Gated behind user approval like kubectl_apply.
  registerTool(
    "forge_comment_issue",
    {
      title: "Comment on issue",
      description: "Post a comment on an issue. Requires user approval via permission card.",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        number: z.number(),
        body: z.string(),
      },
    },
    async (
      input: {
        forge: "github" | "gitlab" | "bitbucket";
        owner: string;
        name: string;
        number: number;
        body: string;
      },
      _context: JAgentDeskToolExecutionContext,
    ) => {
      if (!options.forgeHub) return forgeUnavailable;
      if (!callerAgentId) {
        return {
          content: [
            {
              type: "text",
              text: "forge_comment_issue is only available to agent-scoped tool sessions",
            },
          ],
          isError: true,
        };
      }
      const decision = await options.requestHostToolPermission!(callerAgentId, {
        name: "forge_comment_issue",
        kind: "tool",
        title: `Comment on ${input.forge} ${input.owner}/${input.name}#${input.number}`,
        description: input.body,
        input: input as unknown as Record<string, unknown>,
      });
      if (decision.behavior !== "allow") {
        return { content: [{ type: "text", text: "Denied by user." }], isError: true };
      }
      const arg = {
        owner: input.owner,
        name: input.name,
        number: input.number,
        body: input.body,
      };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.commentIssue(arg)
            : input.forge === "gitlab"
              ? await options.forgeHub.commentGitLabIssue(arg)
              : await options.forgeHub.commentBitbucketIssue(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // WRITE 9: create an issue.
  registerTool(
    "forge_create_issue",
    {
      title: "Create issue",
      description: "Create a new issue. Requires user approval via permission card.",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        title: z.string(),
        body: z.string().optional(),
      },
    },
    async (
      input: {
        forge: "github" | "gitlab" | "bitbucket";
        owner: string;
        name: string;
        title: string;
        body?: string;
      },
      _context: JAgentDeskToolExecutionContext,
    ) => {
      if (!options.forgeHub) return forgeUnavailable;
      if (!callerAgentId) {
        return {
          content: [
            {
              type: "text",
              text: "forge_create_issue is only available to agent-scoped tool sessions",
            },
          ],
          isError: true,
        };
      }
      const decision = await options.requestHostToolPermission!(callerAgentId, {
        name: "forge_create_issue",
        kind: "tool",
        title: `Create issue in ${input.forge} ${input.owner}/${input.name}`,
        description: input.title,
        input: input as unknown as Record<string, unknown>,
      });
      if (decision.behavior !== "allow") {
        return { content: [{ type: "text", text: "Denied by user." }], isError: true };
      }
      const arg = {
        owner: input.owner,
        name: input.name,
        title: input.title,
        body: input.body,
      };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.createIssue(arg)
            : input.forge === "gitlab"
              ? await options.forgeHub.createGitLabIssue(arg)
              : await options.forgeHub.createBitbucketIssue(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // WRITE 10: rerun a pipeline. Bitbucket has no rerun.
  registerTool(
    "forge_rerun_pipeline",
    {
      title: "Rerun pipeline",
      description:
        "Rerun a CI pipeline run (GitHub/GitLab only). Requires user approval via permission card.",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        runId: z.string(),
      },
    },
    async (
      input: {
        forge: "github" | "gitlab" | "bitbucket";
        owner: string;
        name: string;
        runId: string;
      },
      _context: JAgentDeskToolExecutionContext,
    ) => {
      if (!options.forgeHub) return forgeUnavailable;
      if (!callerAgentId) {
        return {
          content: [
            {
              type: "text",
              text: "forge_rerun_pipeline is only available to agent-scoped tool sessions",
            },
          ],
          isError: true,
        };
      }
      if (input.forge === "bitbucket") {
        return {
          content: [{ type: "text", text: "Rerun is not supported for Bitbucket pipelines." }],
          isError: true,
        };
      }
      const decision = await options.requestHostToolPermission!(callerAgentId, {
        name: "forge_rerun_pipeline",
        kind: "tool",
        title: `Rerun ${input.forge} pipeline ${input.runId}`,
        description: `${input.owner}/${input.name} run ${input.runId}`,
        input: input as unknown as Record<string, unknown>,
      });
      if (decision.behavior !== "allow") {
        return { content: [{ type: "text", text: "Denied by user." }], isError: true };
      }
      const arg = { owner: input.owner, name: input.name, runId: input.runId };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.rerunPipeline(arg)
            : await options.forgeHub.rerunGitLabPipeline(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // WRITE 11: merge a change request. All three merge methods take `method: ForgeMergeMethod`
  // (z.enum(["merge","squash","rebase"])).
  registerTool(
    "forge_merge_change_request",
    {
      title: "Merge change request",
      description: "Merge a pull/merge request. Requires user approval via permission card.",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        number: z.number(),
        method: z.enum(["merge", "squash", "rebase"]).optional(),
      },
    },
    async (
      input: {
        forge: "github" | "gitlab" | "bitbucket";
        owner: string;
        name: string;
        number: number;
        method?: "merge" | "squash" | "rebase";
      },
      _context: JAgentDeskToolExecutionContext,
    ) => {
      if (!options.forgeHub) return forgeUnavailable;
      if (!callerAgentId) {
        return {
          content: [
            {
              type: "text",
              text: "forge_merge_change_request is only available to agent-scoped tool sessions",
            },
          ],
          isError: true,
        };
      }
      const decision = await options.requestHostToolPermission!(callerAgentId, {
        name: "forge_merge_change_request",
        kind: "tool",
        title: `Merge ${input.forge} ${input.owner}/${input.name}#${input.number}`,
        description: `method=${input.method ?? "merge"}`,
        input: input as unknown as Record<string, unknown>,
      });
      if (decision.behavior !== "allow") {
        return { content: [{ type: "text", text: "Denied by user." }], isError: true };
      }
      const arg = {
        owner: input.owner,
        name: input.name,
        number: input.number,
        method: input.method ?? ("merge" as const),
      };
      try {
        return ok(
          input.forge === "github"
            ? await options.forgeHub.mergeChangeRequest(arg)
            : input.forge === "gitlab"
              ? await options.forgeHub.mergeGitLabChangeRequest(arg)
              : await options.forgeHub.mergeBitbucketChangeRequest(arg),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // WRITE 12: create a change request. GitHub/GitLab accept an optional `draft`;
  // Bitbucket's createBitbucketChangeRequest has no draft param, so it is dropped
  // for that forge. All take {owner,name,base,head,title,body?}.
  registerTool(
    "forge_create_change_request",
    {
      title: "Create change request",
      description:
        "Open a new pull/merge request from head into base. Requires user approval via permission card.",
      inputSchema: {
        forge: forgeEnum,
        owner: z.string(),
        name: z.string(),
        title: z.string(),
        head: z.string(),
        base: z.string(),
        body: z.string().optional(),
        draft: z.boolean().optional(),
      },
    },
    async (
      input: {
        forge: "github" | "gitlab" | "bitbucket";
        owner: string;
        name: string;
        title: string;
        head: string;
        base: string;
        body?: string;
        draft?: boolean;
      },
      _context: JAgentDeskToolExecutionContext,
    ) => {
      if (!options.forgeHub) return forgeUnavailable;
      if (!callerAgentId) {
        return {
          content: [
            {
              type: "text",
              text: "forge_create_change_request is only available to agent-scoped tool sessions",
            },
          ],
          isError: true,
        };
      }
      const decision = await options.requestHostToolPermission!(callerAgentId, {
        name: "forge_create_change_request",
        kind: "tool",
        title: `Open ${input.forge} PR in ${input.owner}/${input.name}`,
        description: `${input.head} → ${input.base}: ${input.title}`,
        input: input as unknown as Record<string, unknown>,
      });
      if (decision.behavior !== "allow") {
        return { content: [{ type: "text", text: "Denied by user." }], isError: true };
      }
      try {
        if (input.forge === "github") {
          return ok(
            await options.forgeHub.createChangeRequest({
              owner: input.owner,
              name: input.name,
              base: input.base,
              head: input.head,
              title: input.title,
              body: input.body,
              draft: input.draft,
            }),
          );
        }
        if (input.forge === "gitlab") {
          return ok(
            await options.forgeHub.createGitLabChangeRequest({
              owner: input.owner,
              name: input.name,
              base: input.base,
              head: input.head,
              title: input.title,
              body: input.body,
              draft: input.draft,
            }),
          );
        }
        // Bitbucket: createBitbucketChangeRequest has no `draft` param.
        return ok(
          await options.forgeHub.createBitbucketChangeRequest({
            owner: input.owner,
            name: input.name,
            base: input.base,
            head: input.head,
            title: input.title,
            body: input.body,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
