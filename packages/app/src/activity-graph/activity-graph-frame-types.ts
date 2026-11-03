import type {
  ActivityGraphNodeRef,
  ActivityGraphNodeStatusEntry,
} from "@jagentdesk/protocol/agent-activity-graph";
import type { ActivityGraphViewAction } from "./activity-graph-document";

export interface ActivityGraphFrameHandle {
  // Repaint node statuses inside the frame without reloading it (spec 31.3).
  postStatus(nodes: readonly ActivityGraphNodeStatusEntry[]): void;
  view(action: ActivityGraphViewAction, nodeId?: string): void;
}

export interface ActivityGraphFrameProps {
  // Full document from buildActivityGraphDocument.
  document: string;
  // Node index of the version shown; a select message is accepted only for a node in it (31.6).
  nodeIndex: Readonly<Record<string, ActivityGraphNodeRef>>;
  onSelect: (nodeId: string) => void;
  // Fires once per (re)load of the document; tests and the panel use it to prove status pushes
  // do not reload the frame.
  onLoad?: () => void;
  title: string;
  testID?: string;
}
