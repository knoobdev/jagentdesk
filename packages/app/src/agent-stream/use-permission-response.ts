import { useCallback, useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { AgentPermissionResponse } from "@jagentdesk/protocol/agent-types";
import type { AgentPermissionResolvedMessage } from "@jagentdesk/protocol/messages";

export interface PermissionResponder {
  respondToPermissionAndWait: (
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
    timeout?: number,
  ) => Promise<AgentPermissionResolvedMessage["payload"]>;
}

const RESPONSE_TIMEOUT_MS = 15000;

/**
 * One permission card's answer. A failed answer stops the spinner and leaves the actions enabled
 * so pressing one again retries; a request the provider no longer has reports `onExpired` (the
 * daemon has already dropped the card).
 */
export function usePermissionResponse(input: {
  client: PermissionResponder | null;
  agentId: string;
  requestId: string;
  unavailableMessage: string;
  onExpired: () => void;
}) {
  const { client, agentId, requestId, unavailableMessage, onExpired } = input;
  const mutation = useMutation({
    mutationFn: async (response: AgentPermissionResponse) => {
      if (!client) throw new Error(unavailableMessage);
      return client.respondToPermissionAndWait(agentId, requestId, response, RESPONSE_TIMEOUT_MS);
    },
  });
  const { reset, mutateAsync, isPending, error } = mutation;
  const [actionId, setActionId] = useState<string | null>(null);

  useEffect(() => {
    reset();
    setActionId(null);
  }, [agentId, requestId, reset]);

  const respond = useCallback(
    (response: AgentPermissionResponse, respondingActionId: string | null = null) => {
      setActionId(respondingActionId);
      void (async () => {
        try {
          const resolved = await mutateAsync(response);
          if (resolved.expired) onExpired();
        } catch (failure) {
          console.error("[PermissionRequestCard] Failed to respond to permission:", failure);
        }
      })();
    },
    [mutateAsync, onExpired],
  );

  return {
    respond,
    isResponding: isPending,
    /** Only while the answer is in flight, so a failure never leaves a spinner behind. */
    respondingActionId: isPending ? actionId : null,
    error: error ? error.message || unavailableMessage : null,
  };
}
