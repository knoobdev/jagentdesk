import { z } from "zod";
import { mentionAsk } from "./github-events.js";

/** The four triggers a bot's hook turns on (spec 37.11.1), as GitLab's settings page names them. */
export const GITLAB_HOOK_TRIGGERS = [
  "Merge request events",
  "Comments",
  "Issues events",
  "Pipeline events",
] as const;

export const GitLabPayloadSchema = z
  .object({
    object_kind: z.string().optional(),
    user: z.object({ username: z.string(), name: z.string().optional() }).optional(),
    project: z
      .object({
        id: z.number(),
        path_with_namespace: z.string(),
        web_url: z.string().optional(),
      })
      .optional(),
    object_attributes: z
      .object({
        id: z.number().optional(),
        iid: z.number().optional(),
        action: z.string().optional(),
        oldrev: z.string().optional(),
        title: z.string().optional(),
        note: z.string().optional(),
        noteable_type: z.string().optional(),
        status: z.string().optional(),
        url: z.string().optional(),
        ref: z.string().optional(),
      })
      .passthrough()
      .optional(),
    merge_request: z.object({ iid: z.number(), title: z.string().optional() }).optional(),
    issue: z.object({ iid: z.number(), title: z.string().optional() }).optional(),
  })
  .passthrough();
export type GitLabPayload = z.infer<typeof GitLabPayloadSchema>;

export interface GitLabEventFacts {
  kinds: string[];
  /** "group/project!3" for a merge request, "group/project#3" for an issue. */
  subject?: string;
  project?: string;
  actor?: string;
  actorName?: string;
  url?: string;
  text?: string;
  ask?: string;
  noteId?: number;
  /** One run per pipeline and final status, whatever GitLab resends. */
  pipelineKey?: string;
}

type FactsHandler = (payload: GitLabPayload, facts: GitLabEventFacts, folder: string) => void;

const MR_ACTIONS: Record<string, string> = {
  open: "mr_opened",
  merge: "mr_merged",
  close: "mr_closed",
};
const ISSUE_ACTIONS: Record<string, string> = { open: "issue_opened", close: "issue_closed" };
const PIPELINE_RESULTS: Record<string, string> = { failed: "ci_failed", success: "ci_passed" };
const PIPELINE_DONE = new Set(["failed", "success", "canceled"]);

function mergeRequest(payload: GitLabPayload, facts: GitLabEventFacts): void {
  const attrs = payload.object_attributes;
  const action = attrs?.action ?? "";
  const pushed = attrs?.oldrev ? "mr_pushed" : "mr_updated";
  const kind = action === "update" ? pushed : MR_ACTIONS[action];
  if (kind) facts.kinds.push(kind);
  if (facts.project && attrs?.iid !== undefined) facts.subject = `${facts.project}!${attrs.iid}`;
  facts.text = attrs?.title;
}
function noteTarget(payload: GitLabPayload): { iid: number; mark: "!" | "#" } | undefined {
  const type = payload.object_attributes?.noteable_type;
  if (type === "MergeRequest" && payload.merge_request)
    return { iid: payload.merge_request.iid, mark: "!" };
  if (type === "Issue" && payload.issue) return { iid: payload.issue.iid, mark: "#" };
  return undefined;
}
function note(payload: GitLabPayload, facts: GitLabEventFacts, folder: string): void {
  const target = noteTarget(payload);
  if (!target) return;
  const attrs = payload.object_attributes;
  facts.kinds.push("comment");
  if (facts.project) facts.subject = `${facts.project}${target.mark}${target.iid}`;
  facts.text = attrs?.note;
  facts.noteId = attrs?.id;
  const ask = mentionAsk(attrs?.note ?? "", folder);
  if (ask === null) return;
  facts.kinds.push("mentioned");
  facts.ask = ask;
}
function issue(payload: GitLabPayload, facts: GitLabEventFacts): void {
  const attrs = payload.object_attributes;
  const kind = ISSUE_ACTIONS[attrs?.action ?? ""];
  if (kind) facts.kinds.push(kind);
  if (facts.project && attrs?.iid !== undefined) facts.subject = `${facts.project}#${attrs.iid}`;
  facts.text = attrs?.title;
}
function pipeline(payload: GitLabPayload, facts: GitLabEventFacts): void {
  const attrs = payload.object_attributes;
  const status = attrs?.status ?? "";
  const kind = PIPELINE_RESULTS[status];
  if (kind) facts.kinds.push(kind);
  if (PIPELINE_DONE.has(status)) {
    facts.kinds.push("ci_finished");
    facts.pipelineKey = `pipeline:${payload.project?.id}:${attrs?.id}:${status}`;
  }
  facts.text = [attrs?.ref, status].filter(Boolean).join(" · ");
}
const HANDLERS: Record<string, FactsHandler> = {
  "Merge Request Hook": mergeRequest,
  "Note Hook": note,
  "Issue Hook": issue,
  "Pipeline Hook": pipeline,
};

/** Spec 37.11.2. */
export function gitlabEventFacts(
  event: string,
  payload: GitLabPayload,
  folder: string,
): GitLabEventFacts {
  const facts: GitLabEventFacts = {
    kinds: [],
    project: payload.project?.path_with_namespace,
    actor: payload.user?.username,
    actorName: payload.user?.name,
    url: payload.object_attributes?.url,
  };
  HANDLERS[event]?.(payload, facts, folder);
  return facts;
}
