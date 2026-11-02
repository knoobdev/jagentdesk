import {
  SnippetsInboundMessageSchema,
  SnippetsInboundSchemas,
  type SnippetsInboundMessage,
  type SnippetsOutboundMessage,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import type { SshSnippetsService } from "./service.js";

const SNIPPETS_TYPES: ReadonlySet<string> = new Set(
  SnippetsInboundSchemas.map((schema) => schema.shape.type.value),
);

export type SnippetsEmit = (message: SnippetsOutboundMessage) => void;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Handles one `ssh.snippets.*`, `ssh.snippet.*`, `ssh.history.*` or `ssh.workspaces.*`
 * request. Returns false when the message belongs to someone else. Run output/state
 * pushes are not sent here: the owner forwards `service.subscribe` events per session.
 */
export async function handleSnippetsMessage(
  service: SshSnippetsService,
  message: { type: string },
  emit: SnippetsEmit,
): Promise<boolean> {
  if (!SNIPPETS_TYPES.has(message.type)) return false;
  const parsed = SnippetsInboundMessageSchema.parse(message);
  if (await dispatchLibrary(service, parsed, emit)) return true;
  if (await dispatchRuns(service, parsed, emit)) return true;
  await dispatchHistoryAndWorkspaces(service, parsed, emit);
  return true;
}

async function dispatchLibrary(
  service: SshSnippetsService,
  message: SnippetsInboundMessage,
  emit: SnippetsEmit,
): Promise<boolean> {
  const { requestId } = message;
  switch (message.type) {
    case "ssh.snippets.list.request": {
      try {
        const library = await service.listLibrary();
        emit({
          type: "ssh.snippets.list.response",
          payload: { requestId, error: null, ...library },
        });
      } catch (error) {
        emit({
          type: "ssh.snippets.list.response",
          payload: { requestId, error: messageOf(error), packages: [], snippets: [] },
        });
      }
      return true;
    }
    case "ssh.snippets.save.request": {
      try {
        const snippet = await service.saveSnippet(message.snippet);
        emit({ type: "ssh.snippets.save.response", payload: { requestId, error: null, snippet } });
      } catch (error) {
        emit({
          type: "ssh.snippets.save.response",
          payload: { requestId, error: messageOf(error), snippet: null },
        });
      }
      return true;
    }
    case "ssh.snippets.delete.request": {
      const error = await settle(service.deleteSnippet(message.id));
      emit({ type: "ssh.snippets.delete.response", payload: { requestId, error } });
      return true;
    }
    case "ssh.snippets.save_package.request": {
      try {
        const pkg = await service.savePackage(message.package);
        emit({
          type: "ssh.snippets.save_package.response",
          payload: { requestId, error: null, package: pkg },
        });
      } catch (error) {
        emit({
          type: "ssh.snippets.save_package.response",
          payload: { requestId, error: messageOf(error), package: null },
        });
      }
      return true;
    }
    case "ssh.snippets.delete_package.request": {
      const error = await settle(service.deletePackage(message.id));
      emit({ type: "ssh.snippets.delete_package.response", payload: { requestId, error } });
      return true;
    }
    default:
      return false;
  }
}

async function dispatchRuns(
  service: SshSnippetsService,
  message: SnippetsInboundMessage,
  emit: SnippetsEmit,
): Promise<boolean> {
  const { requestId } = message;
  switch (message.type) {
    case "ssh.snippet.run.request": {
      try {
        const run = await service.run({
          source: message.source,
          serverIds: message.serverIds,
          timeoutMs: message.timeoutMs,
        });
        emit({ type: "ssh.snippet.run.response", payload: { requestId, error: null, run } });
      } catch (error) {
        emit({
          type: "ssh.snippet.run.response",
          payload: { requestId, error: messageOf(error), run: null },
        });
      }
      return true;
    }
    case "ssh.snippet.cancel.request": {
      const error = await settle(
        Promise.resolve().then(() => service.cancelRun(message.runId, message.serverId)),
      );
      emit({ type: "ssh.snippet.cancel.response", payload: { requestId, error } });
      return true;
    }
    case "ssh.snippet.get_run.request": {
      const run = service.getRun(message.runId);
      emit({ type: "ssh.snippet.get_run.response", payload: { requestId, error: null, run } });
      return true;
    }
    case "ssh.snippet.list_runs.request": {
      const runs = service.listRuns();
      emit({ type: "ssh.snippet.list_runs.response", payload: { requestId, error: null, runs } });
      return true;
    }
    default:
      return false;
  }
}

async function dispatchHistoryAndWorkspaces(
  service: SshSnippetsService,
  message: SnippetsInboundMessage,
  emit: SnippetsEmit,
): Promise<boolean> {
  const { requestId } = message;
  switch (message.type) {
    case "ssh.history.list.request": {
      try {
        const entries = await service.listHistory(message.serverId);
        emit({ type: "ssh.history.list.response", payload: { requestId, error: null, entries } });
      } catch (error) {
        emit({
          type: "ssh.history.list.response",
          payload: { requestId, error: messageOf(error), entries: [] },
        });
      }
      return true;
    }
    case "ssh.history.clear.request": {
      const error = await settle(service.clearHistory(message.serverId));
      emit({ type: "ssh.history.clear.response", payload: { requestId, error } });
      return true;
    }
    case "ssh.workspaces.list.request": {
      try {
        const templates = await service.listWorkspaces();
        emit({
          type: "ssh.workspaces.list.response",
          payload: { requestId, error: null, templates },
        });
      } catch (error) {
        emit({
          type: "ssh.workspaces.list.response",
          payload: { requestId, error: messageOf(error), templates: [] },
        });
      }
      return true;
    }
    case "ssh.workspaces.save.request": {
      try {
        const template = await service.saveWorkspace(message.template);
        emit({
          type: "ssh.workspaces.save.response",
          payload: { requestId, error: null, template },
        });
      } catch (error) {
        emit({
          type: "ssh.workspaces.save.response",
          payload: { requestId, error: messageOf(error), template: null },
        });
      }
      return true;
    }
    case "ssh.workspaces.delete.request": {
      const error = await settle(service.deleteWorkspace(message.id));
      emit({ type: "ssh.workspaces.delete.response", payload: { requestId, error } });
      return true;
    }
    default:
      return false;
  }
}

/** Resolves to null on success or the failure message; for responses with no data. */
async function settle(operation: Promise<void>): Promise<string | null> {
  try {
    await operation;
    return null;
  } catch (error) {
    return messageOf(error);
  }
}
