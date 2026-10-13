import type { JsonValue } from "@jagentdesk/protocol/agent-types";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export interface WorkspaceTabDescriptor {
  state?: JsonValue;
  key: string;
  tabId: string;
  kind: WorkspaceTabTarget["kind"];
  target: WorkspaceTabTarget;
}
