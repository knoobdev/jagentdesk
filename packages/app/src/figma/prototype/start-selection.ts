import type {
  FigmaFrameSummary,
  FigmaOutline,
  FigmaPrototype,
} from "@jagentdesk/protocol/figma/rpc-schemas";

// The player's opening choice (spec 32.5.3). With no `startNodeId` the player must start on
// something instead of spinning forever: the first flow when flows exist, otherwise the first
// top-level frame of the page — a fallback the toolbar states in its note. `null` means the
// file offers neither, and only then is "No prototype flows in this file." the honest answer.

export interface StartSelection {
  frameId: string;
  /** Non-null only for the no-flows fallback: copy explaining where the player started. */
  note: string | null;
}

export function pickStartPosition(
  flows: FigmaPrototype["flows"],
  outline: FigmaOutline,
): StartSelection | null {
  const flow = flows[0];
  if (flow) return { frameId: flow.nodeId, note: null };
  for (const page of outline.pages) {
    const frame = page.frames[0];
    if (frame) {
      return {
        frameId: frame.id,
        note: `No flow start points — starting from "${frame.name}", the first frame of ${page.name}.`,
      };
    }
  }
  return null;
}

// ADR-0039: the outline flattens the real frames inside SECTIONs onto the page (optional
// parentId/childrenLoaded). Playback must never pull a whole Section subtree just to show a
// container — when the requested start names a known Section/non-frame, the player resolves to
// a playable frame inside it (a declared flow start wins, then any flattened real frame), and
// only asks the user to select a frame when the outline holds nothing playable. An id absent
// from the outline passes through untouched: that is a deep element selection, and the caller
// (the file screen) owns mapping it to an ancestor root frame.

export interface RequestedStartDecision {
  /** The frame to start on; null only when nothing playable can be resolved. */
  frameId: string | null;
  /** True when the request names a known container with no playable frame inside. */
  needsFrameChoice: boolean;
  /** Name of that container, for the prompt copy. */
  containerName: string | null;
}

export function resolveRequestedStart(
  startNodeId: string,
  outline: FigmaOutline,
): RequestedStartDecision {
  const summaries = outline.pages.flatMap((page) => page.frames);
  const byId = new Map(summaries.map((frame) => [frame.id, frame]));
  const parentOf = (frame: FigmaFrameSummary): string | null =>
    (frame as { parentId?: string | null }).parentId ?? null;
  const inSubtreeOf = (nodeId: string, containerId: string): boolean => {
    let cursor = byId.get(nodeId);
    const seen = new Set<string>();
    while (cursor) {
      const parent = parentOf(cursor);
      if (parent === containerId) return true;
      if (parent === null || seen.has(cursor.id)) return false;
      seen.add(cursor.id);
      cursor = byId.get(parent);
    }
    return false;
  };

  const requested = byId.get(startNodeId);
  if (!requested || requested.type === "FRAME") {
    return { frameId: startNodeId, needsFrameChoice: false, containerName: null };
  }

  // A known container: prefer its designed entry point, then any real frame flattened under it.
  for (const page of outline.pages) {
    for (const start of page.flowStartingPoints) {
      const summary = byId.get(start.nodeId);
      if (summary?.type === "FRAME" && inSubtreeOf(start.nodeId, startNodeId)) {
        return { frameId: start.nodeId, needsFrameChoice: false, containerName: null };
      }
    }
  }
  for (const frame of summaries) {
    if (frame.type !== "FRAME") continue;
    if (inSubtreeOf(frame.id, startNodeId)) {
      return { frameId: frame.id, needsFrameChoice: false, containerName: null };
    }
  }
  return { frameId: null, needsFrameChoice: true, containerName: requested.name };
}
