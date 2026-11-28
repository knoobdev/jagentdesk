import {
  isFormAlreadySettledError,
  isFormNotFoundError,
  isPermissionNotFoundError,
  isSessionNotFoundError,
  type FormInfo,
  type FormValue,
  type PermissionRequest,
} from "@opencode/client";
import { type V2Api } from "./api.js";
import {
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentSessionConfig,
  type AgentStreamEvent,
  type ToolCallDetail,
} from "../../../agent-sdk-types.js";
import { PermissionNotPendingError } from "../../../permission-not-pending-error.js";
import { splitMultiSelectAnswer } from "../../question-card-answer.js";
import { OpenCodeHttpError } from "../http-error.js";

export class SessionPermissions {
  private readonly pending = new Map<string, AgentPermissionRequest>();
  private readonly permissionOwners = new Map<string, string>();
  private readonly forms = new Map<string, FormInfo>();
  // Requests with a reply in flight: reconcile must not expire them while OpenCode answers.
  private readonly replying = new Set<string>();
  constructor(
    private readonly getClient: () => V2Api,
    private readonly id: string,
    private readonly config: AgentSessionConfig,
    private readonly emit: (event: AgentStreamEvent) => void,
  ) {}
  observe(event: import("@opencode/client").OpenCodeEvent) {
    if (event.type === "permission.replied") {
      this.resolvePending(event.data.requestID, {
        behavior: event.data.reply === "reject" ? "deny" : "allow",
      });
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      this.resolvePending(event.data.id, {
        behavior: event.type === "form.cancelled" ? "deny" : "allow",
      });
    }
  }
  list() {
    return [...this.pending.values()];
  }
  isOwnedBy(requestId: string, sessionID: string) {
    return (
      this.forms.get(requestId)?.sessionID === sessionID ||
      this.permissionOwners.get(requestId) === sessionID
    );
  }
  async respondToPermission(requestId: string, response: AgentPermissionResponse) {
    this.replying.add(requestId);
    try {
      await this.reply(requestId, response);
    } catch (error) {
      if (!isNoLongerPending(error)) throw error;
      // OpenCode forgot the request: it was answered elsewhere, cancelled with its turn, or lost
      // when the server restarted. Retrying can never succeed, so the card goes away.
      const notPending = new PermissionNotPendingError(requestId, { cause: error });
      this.expire(requestId, notPending.message);
      throw notPending;
    } finally {
      this.replying.delete(requestId);
    }
    this.resolvePending(requestId, response);
  }
  private async reply(requestId: string, response: AgentPermissionResponse) {
    const form = this.forms.get(requestId);
    if (form) {
      if (response.behavior === "deny")
        await this.getClient().session.form.cancel({ sessionID: form.sessionID, formID: form.id });
      else {
        const raw = response.updatedInput?.answers;
        const answer: Record<string, FormValue> = {};
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("OpenCode question response requires answers");
        for (const field of form.fields) {
          const value: unknown =
            Reflect.get(raw, field.key) ?? Reflect.get(raw, field.title ?? field.key);
          const normalized = formAnswer(field, value);
          if (normalized !== undefined) answer[field.key] = normalized;
        }
        await this.getClient().session.form.reply({
          sessionID: form.sessionID,
          formID: form.id,
          answer,
        });
      }
      this.forms.delete(requestId);
    } else {
      await this.getClient().permission.reply({
        sessionID: this.permissionOwners.get(requestId) ?? this.id,
        requestID: requestId,
        decision: permissionReply(response),
        ...(response.behavior === "deny" && response.message !== undefined
          ? { message: response.message }
          : {}),
      });
    }
  }
  async reconcile(sessionID: string) {
    const [permissions, forms] = await Promise.all([
      this.getClient().permission.list({ sessionID }),
      this.getClient().session.form.list({ sessionID }),
    ]);
    // A card OpenCode no longer lists can never be answered (the server restarted, or the
    // request was answered or cancelled while the event stream was away).
    const live = new Set([...permissions, ...forms].map((request) => request.id));
    for (const requestId of this.pending.keys())
      if (
        this.ownerOf(requestId) === sessionID &&
        !live.has(requestId) &&
        !this.replying.has(requestId)
      )
        this.expire(requestId, new PermissionNotPendingError(requestId).message);
    for (const request of permissions) {
      if (this.pending.has(request.id)) continue;
      const pending = toolPermissionRequest(request);
      this.pending.set(request.id, pending);
      this.permissionOwners.set(request.id, sessionID);
      if (!this.config.toolPolicy && this.config.providerOptions?.["auto_accept"] === true)
        await this.respondToPermission(request.id, { behavior: "allow" }).catch(ignoreNotPending);
      else this.emit({ type: "permission_requested", provider: "opencode", request: pending });
    }
    for (const form of forms) {
      if (this.pending.has(form.id)) continue;
      const pending: AgentPermissionRequest = {
        id: form.id,
        provider: "opencode",
        name: "question",
        kind: "question",
        title: form.title,
        input: {
          questions: form.fields.map((field) => ({
            header: field.title ?? field.key,
            question: field.description ?? field.title ?? field.key,
            options: "options" in field ? field.options : undefined,
            multiSelect: field.type === "multiselect",
            allowOther: "custom" in field && field.custom === true,
          })),
        },
      };
      this.forms.set(form.id, form);
      this.pending.set(form.id, pending);
      this.emit({ type: "permission_requested", provider: "opencode", request: pending });
    }
  }
  resolvePending(requestId: string, resolution: AgentPermissionResponse, expired = false) {
    if (!this.pending.delete(requestId)) return;
    this.forms.delete(requestId);
    this.permissionOwners.delete(requestId);
    this.emit({
      type: "permission_resolved",
      provider: "opencode",
      requestId,
      resolution,
      ...(expired ? { expired: true } : {}),
    });
  }
  private expire(requestId: string, message: string) {
    this.resolvePending(requestId, { behavior: "deny", message }, true);
  }
  private ownerOf(requestId: string) {
    return this.forms.get(requestId)?.sessionID ?? this.permissionOwners.get(requestId);
  }
}

/** A request that expired while being answered has already been dropped and announced. */
export function ignoreNotPending(error: unknown): void {
  if (!(error instanceof PermissionNotPendingError)) throw error;
}

function isNoLongerPending(error: unknown): boolean {
  // The OpenCode client wraps what its fetch throws as ClientError("Transport", { cause }), so
  // the 404 from validateOpenCodeResponse arrives as the cause, not as the error itself.
  for (let current: unknown = error; current; current = causeOf(current)) {
    if (
      (current instanceof OpenCodeHttpError && current.status === 404) ||
      isPermissionNotFoundError(current) ||
      isFormNotFoundError(current) ||
      isFormAlreadySettledError(current) ||
      isSessionNotFoundError(current)
    )
      return true;
  }
  return false;
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

const TOOL_PERMISSION_TITLES: Record<string, string> = {
  external_directory: "Access external directory",
  shell: "Run shell command",
  read: "Read files",
  edit: "Edit files",
  write: "Write files",
};

/** Spec 33.7: a permission card always shows what it asks for, never an empty detail. */
function toolPermissionRequest(request: PermissionRequest): AgentPermissionRequest {
  const input: Record<string, unknown> = {
    action: request.action,
    resources: request.resources,
    ...(request.metadata && Object.keys(request.metadata).length > 0
      ? { metadata: request.metadata }
      : {}),
  };
  const title = TOOL_PERMISSION_TITLES[request.action];
  return {
    id: request.id,
    provider: "opencode",
    kind: "tool",
    name: request.action,
    ...(title ? { title } : {}),
    ...(request.message ? { description: request.message } : {}),
    input,
    detail: toolPermissionDetail(request, input),
    actions: [
      { id: "once", label: "Allow once", behavior: "allow" },
      { id: "always", label: "Always allow", behavior: "allow" },
      { id: "reject", label: "Deny", behavior: "deny" },
    ],
  };
}

function toolPermissionDetail(
  request: PermissionRequest,
  input: Record<string, unknown>,
): ToolCallDetail {
  // OpenCode asks for the directory patterns the tool reaches outside the project.
  if (request.action === "external_directory" && request.resources.length > 0)
    return { type: "plain_text", text: request.resources.join("\n") };
  const command: unknown = request.metadata?.["command"];
  if (request.action === "shell" && typeof command === "string" && command)
    return { type: "shell", command };
  return { type: "unknown", input, output: null };
}

function permissionReply(response: AgentPermissionResponse): "reject" | "once" | "always" {
  if (response.behavior === "deny") return "reject";
  return response.selectedActionId === "always" ? "always" : "once";
}

function formAnswer(field: FormInfo["fields"][number], value: unknown): FormValue | undefined {
  if (value === undefined) return undefined;
  if (field.type === "external") return undefined;
  const labelValue = (label: string) => {
    const options = "options" in field ? field.options : undefined;
    return (
      options?.find((option) => option.value === label)?.value ??
      options?.find((option) => option.label === label)?.value ??
      label
    );
  };
  if (field.type === "multiselect") {
    const selected = multiSelectAnswer(field, value);
    if (selected) return selected.map(labelValue);
  } else if (field.type === "string" && typeof value === "string") {
    return labelValue(value);
  } else if (field.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  } else if (field.type === "number" || field.type === "integer") {
    const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
    if (
      typeof numeric === "number" &&
      Number.isFinite(numeric) &&
      (field.type !== "integer" || Number.isInteger(numeric))
    )
      return numeric;
  }
  throw new Error(`Invalid answer for OpenCode question ${field.key}`);
}

type MultiSelectField = Extract<FormInfo["fields"][number], { type: "multiselect" }>;

function multiSelectAnswer(field: MultiSelectField, value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((item: unknown) => typeof item === "string"))
    return value;
  if (typeof value !== "string") return undefined;
  const { selected, custom } = splitMultiSelectAnswer(
    value,
    field.options.map((option) => option.label),
  );
  if (custom === null) return selected;
  return field.custom === true ? [...selected, custom] : undefined;
}
