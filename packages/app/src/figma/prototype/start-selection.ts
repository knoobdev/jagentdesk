import type { FigmaOutline, FigmaPrototype } from "@jagentdesk/protocol/figma/rpc-schemas";

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
