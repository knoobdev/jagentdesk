import type { FigmaEditOp, FigmaNode, FigmaOutline } from "@jagentdesk/protocol/figma/rpc-schemas";

// Props shared between the Figma app work packages (spec 32.5–32.6). The file screen (W10) mounts
// the panels below; their owners implement them at these paths with exactly these props:
//   @/figma/prototype/prototype-player   PrototypePlayer   (W1)
//   @/figma/comments/comments-panel      CommentsPanel     (W1)
//   @/figma/versions/versions-panel      VersionsPanel     (W1)
//   @/figma/sidebar-figma-nav            SidebarFigmaNav   (W8)
//   @/figma/connect/connect-screen       FigmaConnectScreen (W8)
//   @/figma/link/link-panel              FigmaLinkPanel    (W8)
//   @/figma/pending/pending-bar          PendingBar        (W8)
//   @/figma/canvas/file-screen           FigmaFileScreen   (W10)
//   @/figma/renderer                     createFigmaRenderer (W9)

export interface FigmaFileRef {
  serverId: string;
  fileKey: string;
  /** Read-only view of an older version (32.5.4). */
  version?: string;
}

export interface FigmaSelection {
  pageId: string;
  nodeId: string | null;
}

export interface PrototypePlayerProps {
  file: FigmaFileRef;
  outline: FigmaOutline;
  /** Flow starting node, or null to let the user pick. */
  startNodeId: string | null;
  onClose: () => void;
}

export interface CommentsPanelProps {
  file: FigmaFileRef;
  selection: FigmaSelection;
  /** Pan/zoom the canvas to a comment's node. */
  onFocusNode: (nodeId: string) => void;
}

export interface VersionsPanelProps {
  file: FigmaFileRef;
  onOpenVersion: (version: string | null) => void;
}

export interface PendingBarProps {
  file: FigmaFileRef;
}

export interface FigmaLinkPanelProps {
  serverId: string;
}

/** Applies edit ops: through Figma Link when the file is linked, otherwise into the queue. */
export type ApplyFigmaEdits = (ops: FigmaEditOp[]) => Promise<void>;

export interface InspectTarget {
  node: FigmaNode;
  linked: boolean;
  applyEdits: ApplyFigmaEdits;
}
