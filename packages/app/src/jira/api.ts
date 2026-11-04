import { useCallback } from "react";
import type {
  JiraError,
  JiraRequestParams,
  JiraRequestType,
  JiraResponseData,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

// The app's door to the jira.* RPCs (spec 29.5). A Jira-side failure comes back as
// `payload.error`; this turns it into a thrown JiraRpcError so React Query and mutations see it.

export class JiraRpcError extends Error {
  readonly code: string;
  readonly fieldErrors: Record<string, string>;

  constructor(error: JiraError) {
    super(error.message);
    this.name = "JiraRpcError";
    this.code = error.code;
    this.fieldErrors = error.fieldErrors ?? {};
  }
}

export class JiraHostOfflineError extends Error {
  constructor() {
    super("The host is offline.");
    this.name = "JiraHostOfflineError";
  }
}

export type JiraCall = <T extends JiraRequestType>(
  type: T,
  params: JiraRequestParams<T>,
) => Promise<JiraResponseData<T>>;

export async function callJira<T extends JiraRequestType>(
  client: DaemonClient | null,
  type: T,
  params: JiraRequestParams<T>,
): Promise<JiraResponseData<T>> {
  if (!client) throw new JiraHostOfflineError();
  const payload = await client.jiraRequest(type, params);
  const { requestId: _requestId, error, ...data } = payload;
  if (error) throw new JiraRpcError(error);
  return data as JiraResponseData<T>;
}

export function useJiraCall(serverId: string): JiraCall {
  const client = useHostRuntimeClient(serverId);
  return useCallback(
    <T extends JiraRequestType>(type: T, params: JiraRequestParams<T>) =>
      callJira(client, type, params),
    [client],
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
