import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { jiraKeys } from "./queries";

// Spec 29.3: an open board/backlog or issue asks the daemon to poll Jira every 15 s; leaving the
// view (unmount, or the host session going away) stops it. Changes arrive as jira.board.changed /
// jira.issue.changed and refetch the view.

function newWatchId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useBoardWatch(input: {
  serverId: string;
  connectionId: string;
  boardId: number;
  active: boolean;
}): void {
  const { serverId, connectionId, boardId, active } = input;
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client || !active) return;
    const watchId = newWatchId("board");
    const off = client.onJiraPush("jira.board.changed", (message) => {
      if (message.watchId !== watchId) return;
      void queryClient.invalidateQueries({
        queryKey: jiraKeys.boardAny(serverId, connectionId, boardId),
      });
    });
    void client.jiraRequest("jira.board.watch.request", { watchId, connectionId, boardId });
    return () => {
      off();
      void client.jiraRequest("jira.board.unwatch.request", { watchId }).catch(() => undefined);
    };
  }, [client, active, serverId, connectionId, boardId, queryClient]);
}

export function useIssueWatch(input: {
  serverId: string;
  connectionId: string;
  issueKey: string;
  active: boolean;
}): void {
  const { serverId, connectionId, issueKey, active } = input;
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client || !active) return;
    const watchId = newWatchId("issue");
    const off = client.onJiraPush("jira.issue.changed", (message) => {
      if (message.watchId !== watchId) return;
      void queryClient.invalidateQueries({
        queryKey: jiraKeys.issue(serverId, connectionId, issueKey),
      });
    });
    void client.jiraRequest("jira.issue.watch.request", { watchId, connectionId, issueKey });
    return () => {
      off();
      void client.jiraRequest("jira.issue.unwatch.request", { watchId }).catch(() => undefined);
    };
  }, [client, active, serverId, connectionId, issueKey, queryClient]);
}
