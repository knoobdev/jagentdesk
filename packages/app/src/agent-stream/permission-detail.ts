import type { AgentPermissionRequest, ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import { hasMeaningfulToolCallDetail } from "@/utils/tool-call-detail-state";

/**
 * What a permission card shows under its title (spec 33.7): the provider's detail, else the
 * request's input. `null` when the request carries neither, so the card never claims "No
 * additional details available" for a request that has them.
 */
export function permissionRequestDetail(
  request: Pick<AgentPermissionRequest, "detail" | "input">,
): ToolCallDetail | null {
  if (request.detail && hasMeaningfulToolCallDetail(request.detail)) return request.detail;
  const input: ToolCallDetail = { type: "unknown", input: request.input ?? null, output: null };
  return hasMeaningfulToolCallDetail(input) ? input : null;
}
