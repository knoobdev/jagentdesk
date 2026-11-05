import type { ReactNode } from "react";
import type { FigmaFileRef } from "@/figma/contracts";

// Stub for the W10-owned file screen: canvas, renderer mount, inspect, comments and the pending
// bar live there. W8 renders this from the Figma route when a fileKey is present; W10 replaces
// this file. It must keep accepting `{ file }` (the shared FigmaFileRef) and mounting the
// PendingBar per figma/contracts.ts.

export function FigmaFileScreen({ file }: { file: FigmaFileRef }): ReactNode {
  void file;
  return null;
}
