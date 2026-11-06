// The prototype stage reports the SAME visible statuses as the canvas (spec 32.5.1), and the
// web stage announces them to assistive tech alongside its ready name (spec 32.5.3). These are
// the shared strings — verbatim the canvas status primitive. The values live here, not behind a
// `@/figma/canvas/canvas-view` import, so the player never pulls the whole canvas module graph
// (and its daemon/host machinery) just to paint one line of text. The canvas owns its copy in
// canvas-view.tsx; the E2E gate asserts both surfaces announce these exact strings.

/** Loading line — identical to the canvas `STATUS_LOADING` (spec 32.5.1). */
export const STATUS_LOADING = "Loading content…";

/** Terminal-failure line — identical to the canvas `STATUS_FAILED` (spec 32.5.1). */
export const STATUS_FAILED = "Some content failed to load — tap to retry";

/** The assistive-tech name of a content-ready prototype frame (spec 32.5.3). */
export const PROTOTYPE_READY_LABEL = "Figma prototype frame";
