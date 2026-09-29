// The frame shrinks to the diagram's rendered height (reported from inside the sandbox) but never
// grows past the host's cap, so tall diagrams scroll inside the frame. Before the first report the
// cap is used, which is what the frame showed before it could measure.
const MIN_FRAME_HEIGHT = 200;

export function fitArchifyFrameHeight(contentHeight: number | null, cap: number): number {
  if (contentHeight === null || !Number.isFinite(contentHeight) || contentHeight <= 0) return cap;
  return Math.round(Math.min(cap, Math.max(MIN_FRAME_HEIGHT, contentHeight)));
}
