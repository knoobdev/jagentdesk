import { z } from "zod";

// Wire schemas for Figma (spec 32, ADR-0035). Requests are `{ type, requestId, ...params }`;
// responses are `{ type, payload: { requestId, error, ...data } }` (docs/rpc-namespacing.md).
//
// Secrets (OAuth client secret, access/refresh tokens, Figma Link pairing keys) travel at most once,
// client→daemon, on `figma.oauth.begin|delegate`, and then live only in the daemon's FileSecretStore
// under $JAGENTDESK_HOME/figma. No response or push carries one, and no DTO carries a Figma render
// or S3 URL: images, exports and fonts come back as bytes (base64). Every timestamp is Unix ms UTC.
//
// This file is the contract shared by the daemon (packages/server/src/server/figma/**), the session
// handler (packages/server/src/server/session/figma/**), the client and the app. Change it only with
// the spec (docs/spec/32-figma.md in the spec repo).

export const FigmaErrorSchema = z.object({
  // auth_failed | needs_reauth | forbidden | not_found | invalid_input | rate_limited | network |
  // link_unavailable | link_unpaired | link_version_mismatch | port_in_use | conflict |
  // too_large | unsupported | figma_error
  code: z.string(),
  message: z.string(),
  // Rate limits (32.8): when Figma said to retry, and what its headers reported.
  retryAt_ms: z.number().optional(),
  planTier: z.string().optional(),
  rateLimitType: z.enum(["low", "high"]).optional(),
  upgradeUrl: z.string().optional(),
});
export type FigmaError = z.infer<typeof FigmaErrorSchema>;

export const FigmaAuthStateSchema = z.enum(["connected", "needs_reauth", "error"]);
export type FigmaAuthState = z.infer<typeof FigmaAuthStateSchema>;

export const FigmaAccountSchema = z.object({
  figmaUserId: z.string(),
  handle: z.string(),
  email: z.string().nullable(),
});
export type FigmaAccount = z.infer<typeof FigmaAccountSchema>;

export const FigmaConnectionSchema = z.object({
  id: z.string(), // `fgc_…`
  account: FigmaAccountSchema,
  authState: FigmaAuthStateSchema,
  lastError: z.string().optional(),
  tokenExpiresAt_ms: z.number().optional(),
  createdAt_ms: z.number(),
});
export type FigmaConnection = z.infer<typeof FigmaConnectionSchema>;

export const FigmaFileSchema = z.object({
  fileKey: z.string(),
  connectionId: z.string(),
  name: z.string(),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  pinned: z.boolean(),
  lastVersion: z.string().optional(),
  lastModified_ms: z.number().optional(),
  lastOpenedAt_ms: z.number().optional(),
  // True while the Figma Link plugin has this file open (32.4).
  linked: z.boolean(),
});
export type FigmaFile = z.infer<typeof FigmaFileSchema>;

export const FigmaTeamSchema = z.object({
  teamId: z.string(),
  connectionId: z.string(),
  name: z.string(),
});
export type FigmaTeam = z.infer<typeof FigmaTeamSchema>;

export const FigmaProjectSchema = z.object({ id: z.string(), name: z.string() });
export type FigmaProject = z.infer<typeof FigmaProjectSchema>;

export const FigmaProjectFileSchema = z.object({
  fileKey: z.string(),
  name: z.string(),
  lastModified_ms: z.number().optional(),
});
export type FigmaProjectFile = z.infer<typeof FigmaProjectFileSchema>;

// A Figma document node exactly as Figma's REST API returns it (`GET /v1/files/:key/nodes` with
// `geometry=paths`), or the same shape serialized by the Figma Link plugin. The renderer consumes
// this format directly; unknown properties pass through untouched.
//
// NOT recursive: a `z.lazy` self-reference here was miscompiled by zod-aot 0.20.4 into
// `safeParse_WSOutboundMessageSchema(children[i])`, so every child was re-parsed against the
// whole WebSocket message union and every subtree was rejected. Children carry their own
// `id`/`name`/`type` and pass through opaque; the TS interface below stays the deep shape.
export const FigmaNodeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    children: z.array(z.unknown()).optional(),
  })
  .passthrough() as unknown as z.ZodType<FigmaNode>;
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  [property: string]: unknown;
}

export const FigmaSourceSchema = z.enum(["rest", "link"]);
export type FigmaSource = z.infer<typeof FigmaSourceSchema>;

export const FigmaRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type FigmaRect = z.infer<typeof FigmaRectSchema>;

// Top-level frames of a page: enough to lay out the canvas before any subtree is loaded.
export const FigmaFrameSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  bounds: FigmaRectSchema,
  backgroundColor: z.string().optional(), // #RRGGBBAA
  // ADR-0039 (32.5.1): SECTION membership and whether the outline already carries the node's
  // direct children. Frames separated out of a SECTION carry its `parentId`; `childrenLoaded`
  // only appears on SECTIONs — false marks one cut off at the depth=3 boundary, whose viewer
  // reads its children with a depth=1 node request instead of the whole subtree. Everything
  // else omits both fields; parent-first draw order and sibling order are producer-side.
  parentId: z.string().optional(),
  childrenLoaded: z.boolean().optional(),
});
export type FigmaFrameSummary = z.infer<typeof FigmaFrameSummarySchema>;

export const FigmaPageSchema = z.object({
  id: z.string(),
  name: z.string(),
  backgroundColor: z.string().optional(),
  frames: z.array(FigmaFrameSummarySchema),
  flowStartingPoints: z.array(z.object({ nodeId: z.string(), name: z.string() })),
});
export type FigmaPage = z.infer<typeof FigmaPageSchema>;

export const FigmaOutlineSchema = z.object({
  fileKey: z.string(),
  name: z.string(),
  version: z.string(),
  lastModified_ms: z.number(),
  editorType: z.string(), // figma | figjam
  pages: z.array(FigmaPageSchema),
  source: FigmaSourceSchema,
});
export type FigmaOutline = z.infer<typeof FigmaOutlineSchema>;

export const FigmaBytesSchema = z.object({
  mimeType: z.string(),
  dataBase64: z.string(),
});
export type FigmaBytes = z.infer<typeof FigmaBytesSchema>;

export const FigmaVersionSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  description: z.string().nullable(),
  createdAt_ms: z.number(),
  user: z.object({ handle: z.string() }).nullable(),
});
export type FigmaVersion = z.infer<typeof FigmaVersionSchema>;

export const FigmaCommentSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  message: z.string(),
  user: z.object({ handle: z.string(), figmaUserId: z.string() }),
  createdAt_ms: z.number(),
  resolvedAt_ms: z.number().nullable(),
  nodeId: z.string().nullable(),
  // Position relative to the node (or canvas when nodeId is null).
  offset: z.object({ x: z.number(), y: z.number() }).nullable(),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number(), mine: z.boolean() })),
  mine: z.boolean(),
});
export type FigmaComment = z.infer<typeof FigmaCommentSchema>;

// Prototype data (32.5.3). `interactions` are Figma's REST/Plugin reactions, normalized.
export const FigmaTransitionSchema = z.object({
  type: z.string(), // INSTANT | DISSOLVE | MOVE_IN | MOVE_OUT | PUSH | SLIDE_IN | SLIDE_OUT | SMART_ANIMATE | …
  direction: z.string().optional(),
  durationMs: z.number().optional(),
  easing: z.string().optional(),
});
export const FigmaInteractionSchema = z.object({
  nodeId: z.string(),
  trigger: z.object({ type: z.string(), delayMs: z.number().optional() }),
  action: z.object({
    type: z.string(), // NODE | BACK | CLOSE | URL | …
    navigation: z.string().optional(), // NAVIGATE | OVERLAY | SWAP | SCROLL_TO | CHANGE_TO
    destinationId: z.string().nullable().optional(),
    url: z.string().optional(),
    transition: FigmaTransitionSchema.nullable().optional(),
  }),
});
export type FigmaInteraction = z.infer<typeof FigmaInteractionSchema>;
export const FigmaOverlaySettingsSchema = z.object({
  frameId: z.string(),
  position: z.string(), // CENTER | TOP_LEFT | … | MANUAL
  background: z.object({ type: z.string(), color: z.string().optional() }).optional(),
  closeOnClickOutside: z.boolean().optional(),
});
export const FigmaPrototypeSchema = z.object({
  flows: z.array(z.object({ nodeId: z.string(), name: z.string(), pageId: z.string() })),
  interactions: z.array(FigmaInteractionSchema),
  // Only with Figma Link (REST does not expose overlay settings).
  overlays: z.array(FigmaOverlaySettingsSchema),
  overlaySettingsAvailable: z.boolean(),
});
export type FigmaPrototype = z.infer<typeof FigmaPrototypeSchema>;

// Figma Link (32.4).
export const FigmaLinkFileSchema = z.object({
  fileKey: z.string(),
  fileName: z.string(),
  pageName: z.string().nullable(),
  paired: z.boolean(),
  pluginVersion: z.string(),
  connectedAt_ms: z.number(),
});
export type FigmaLinkFile = z.infer<typeof FigmaLinkFileSchema>;

export const FigmaLinkStatusSchema = z.object({
  server: z.enum(["listening", "port_in_use", "stopped"]),
  port: z.number(),
  pluginInstalled: z.boolean(),
  pluginVersion: z.string().nullable(),
  manifestPath: z.string().nullable(),
  runScriptEnabled: z.boolean(),
  files: z.array(FigmaLinkFileSchema),
  // A plugin waiting for a pairing code to be typed in the app.
  pendingPairing: z.object({ fileName: z.string(), expiresAt_ms: z.number() }).nullable(),
});
export type FigmaLinkStatus = z.infer<typeof FigmaLinkStatusSchema>;

// Edit operations the app may perform (32.6) — through Figma Link, or queued (32.6.1).
// `tempId` names a node an earlier op in the same batch creates.
export const FigmaColorSchema = z.object({
  r: z.number(),
  g: z.number(),
  b: z.number(),
  a: z.number(),
});
export const FigmaEditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rename"), nodeId: z.string(), name: z.string() }),
  z.object({ op: z.literal("set_visible"), nodeId: z.string(), visible: z.boolean() }),
  z.object({ op: z.literal("set_locked"), nodeId: z.string(), locked: z.boolean() }),
  z.object({ op: z.literal("delete"), nodeId: z.string() }),
  z.object({ op: z.literal("duplicate"), nodeId: z.string(), tempId: z.string().optional() }),
  z.object({
    op: z.literal("reorder"),
    nodeId: z.string(),
    index: z.number().int(),
  }),
  z.object({ op: z.literal("set_text"), nodeId: z.string(), characters: z.string() }),
  z.object({ op: z.literal("set_fill"), nodeId: z.string(), color: FigmaColorSchema }),
  z.object({ op: z.literal("set_corner_radius"), nodeId: z.string(), radius: z.number() }),
  z.object({
    op: z.literal("set_geometry"),
    nodeId: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  z.object({
    op: z.literal("set_auto_layout"),
    nodeId: z.string(),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
    itemSpacing: z.number().optional(),
    padding: z
      .object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() })
      .optional(),
    primaryAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
    counterAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
  }),
  z.object({
    op: z.literal("set_layout_child"),
    nodeId: z.string(),
    horizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    vertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  }),
  z.object({ op: z.literal("apply_style"), nodeId: z.string(), styleId: z.string() }),
  z.object({
    op: z.literal("bind_variable"),
    nodeId: z.string(),
    field: z.string(),
    variableId: z.string(),
  }),
  z.object({
    op: z.literal("create_node"),
    parentId: z.string(),
    kind: z.enum(["FRAME", "TEXT", "RECTANGLE"]),
    tempId: z.string(),
    name: z.string().optional(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    characters: z.string().optional(),
  }),
  z.object({
    op: z.literal("create_component"),
    nodeId: z.string(),
    tempId: z.string().optional(),
  }),
  z.object({
    op: z.literal("create_instance"),
    componentId: z.string(),
    parentId: z.string(),
    x: z.number(),
    y: z.number(),
    tempId: z.string().optional(),
  }),
  z.object({ op: z.literal("swap_instance"), nodeId: z.string(), componentId: z.string() }),
  z.object({
    op: z.literal("set_reaction"),
    nodeId: z.string(),
    trigger: z.enum(["ON_CLICK", "ON_HOVER", "ON_PRESS", "AFTER_TIMEOUT"]),
    destinationId: z.string().nullable(), // null removes the node's reactions
    transition: FigmaTransitionSchema.optional(),
  }),
]);
export type FigmaEditOp = z.infer<typeof FigmaEditOpSchema>;

export const FigmaPendingOpSchema = z.object({
  id: z.string(), // `fpo_…`
  op: FigmaEditOpSchema,
  baseVersion: z.string(),
  // The values the op changes, as they were when it was queued (for conflict checks).
  previous: z.record(z.string(), z.unknown()),
  createdAt_ms: z.number(),
  origin: z.enum(["user", "agent"]),
  state: z.enum(["pending", "applied", "conflict", "failed"]),
  message: z.string().optional(),
});
export type FigmaPendingOp = z.infer<typeof FigmaPendingOpSchema>;

export const FigmaBudgetSchema = z.object({
  connectionId: z.string(),
  tiers: z.array(
    z.object({
      tier: z.enum(["1", "2", "3"]),
      usedLastMinute: z.number(),
      blockedUntil_ms: z.number().nullable(),
    }),
  ),
  planTier: z.string().nullable(),
  rateLimitType: z.enum(["low", "high"]).nullable(),
  upgradeUrl: z.string().nullable(),
});
export type FigmaBudget = z.infer<typeof FigmaBudgetSchema>;

function req<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...shape });
}

function res<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: FigmaErrorSchema.nullable(), ...shape }),
  });
}

const connectionId = z.string();
const fileKey = z.string();

// ── connections + OAuth (32.2) ───────────────────────────────────────────────
export const FigmaConnectionsListRequestSchema = req("figma.connections.list.request", {});
export const FigmaConnectionsListResponseSchema = res("figma.connections.list.response", {
  connections: z.array(FigmaConnectionSchema),
});
export const FigmaConnectionsRemoveRequestSchema = req("figma.connections.remove.request", {
  connectionId,
});
export const FigmaConnectionsRemoveResponseSchema = res("figma.connections.remove.response", {});
export const FigmaConnectionsTestRequestSchema = req("figma.connections.test.request", {
  connectionId,
});
export const FigmaConnectionsTestResponseSchema = res("figma.connections.test.response", {
  connection: FigmaConnectionSchema.nullable(),
});

export const FigmaOAuthBeginRequestSchema = req("figma.oauth.begin.request", {
  clientId: z.string(),
  clientSecret: z.string(), // stored by the daemon; never echoed
  // Desktop: 127.0.0.1 loopback callback served by Electron; others: paste the final URL.
  redirect: z.enum(["loopback", "paste"]),
});
export const FigmaOAuthBeginResponseSchema = res("figma.oauth.begin.response", {
  attemptId: z.string(),
  authorizeUrl: z.string(),
  redirectUri: z.string(),
});
export const FigmaOAuthCompleteRequestSchema = req("figma.oauth.complete.request", {
  attemptId: z.string(),
  // Loopback: code + state; paste: the full URL the browser landed on.
  code: z.string().optional(),
  state: z.string().optional(),
  pastedUrl: z.string().optional(),
});
export const FigmaOAuthCompleteResponseSchema = res("figma.oauth.complete.response", {
  connection: FigmaConnectionSchema.nullable(),
});
// Mobile asks a paired online desktop to run the browser step (32.2).
export const FigmaOAuthDelegateRequestSchema = req("figma.oauth.delegate.request", {
  clientId: z.string(),
  clientSecret: z.string(),
});
export const FigmaOAuthDelegateResponseSchema = res("figma.oauth.delegate.response", {
  attemptId: z.string().nullable(),
  desktopAvailable: z.boolean(),
});

// ── files, teams (32.3) ──────────────────────────────────────────────────────
export const FigmaFilesListRequestSchema = req("figma.files.list.request", {
  connectionId: connectionId.optional(),
});
export const FigmaFilesListResponseSchema = res("figma.files.list.response", {
  files: z.array(FigmaFileSchema),
});
export const FigmaFilesAddRequestSchema = req("figma.files.add.request", {
  connectionId,
  url: z.string(), // figma.com/design|file|proto/<key>/… or a bare file key
});
export const FigmaFilesAddResponseSchema = res("figma.files.add.response", {
  file: FigmaFileSchema.nullable(),
});
export const FigmaFilesRemoveRequestSchema = req("figma.files.remove.request", { fileKey });
export const FigmaFilesRemoveResponseSchema = res("figma.files.remove.response", {});
export const FigmaFilesPinRequestSchema = req("figma.files.pin.request", {
  fileKey,
  pinned: z.boolean(),
});
export const FigmaFilesPinResponseSchema = res("figma.files.pin.response", {
  file: FigmaFileSchema.nullable(),
});
export const FigmaTeamsAddRequestSchema = req("figma.teams.add.request", {
  connectionId,
  url: z.string(), // figma.com/files/team/<id>/… or a bare team id
});
export const FigmaTeamsAddResponseSchema = res("figma.teams.add.response", {
  team: FigmaTeamSchema.nullable(),
});
export const FigmaTeamsRemoveRequestSchema = req("figma.teams.remove.request", {
  connectionId,
  teamId: z.string(),
});
export const FigmaTeamsRemoveResponseSchema = res("figma.teams.remove.response", {});
export const FigmaTeamsListRequestSchema = req("figma.teams.list.request", { connectionId });
export const FigmaTeamsListResponseSchema = res("figma.teams.list.response", {
  teams: z.array(FigmaTeamSchema),
});
export const FigmaTeamsProjectsRequestSchema = req("figma.teams.projects.request", {
  connectionId,
  teamId: z.string(),
});
export const FigmaTeamsProjectsResponseSchema = res("figma.teams.projects.response", {
  projects: z.array(FigmaProjectSchema),
});
export const FigmaTeamsFilesRequestSchema = req("figma.teams.files.request", {
  connectionId,
  projectId: z.string(),
});
export const FigmaTeamsFilesResponseSchema = res("figma.teams.files.response", {
  files: z.array(FigmaProjectFileSchema),
});

// ── file content (32.5) ──────────────────────────────────────────────────────
export const FigmaFileOutlineRequestSchema = req("figma.file.outline.request", {
  fileKey,
  version: z.string().optional(), // read-only view of an older version
});
export const FigmaFileOutlineResponseSchema = res("figma.file.outline.response", {
  outline: FigmaOutlineSchema.nullable(),
});
export const FigmaFileNodesRequestSchema = req("figma.file.nodes.request", {
  fileKey,
  ids: z.array(z.string()).min(1).max(50),
  version: z.string().optional(),
  // ADR-0039 (32.9): direct children only, for reading SECTION contents without their subtrees.
  // The handler requires an explicit nonempty version with this option — a schema-level refine
  // here would widen the old contract, so the check lives server-side. Old requests omit it and
  // still receive the full tree; the response shape is unchanged.
  depth: z.literal(1).optional(),
});
export const FigmaComponentMetaSchema = z.object({
  key: z.string(),
  name: z.string(),
  // False/absent for a component defined in this file, true when it comes from a team library.
  remote: z.boolean().optional(),
});
export type FigmaComponentMeta = z.infer<typeof FigmaComponentMetaSchema>;

export const FigmaFileNodesResponseSchema = res("figma.file.nodes.response", {
  version: z.string(),
  source: FigmaSourceSchema,
  nodes: z.record(z.string(), FigmaNodeSchema.nullable()),
  // Component/style metadata referenced by the nodes (REST `components`/`styles`).
  components: z.record(z.string(), FigmaComponentMetaSchema),
  styles: z.record(
    z.string(),
    z.object({ key: z.string(), name: z.string(), styleType: z.string() }),
  ),
});
export const FigmaFileImageFillsRequestSchema = req("figma.file.imageFills.request", {
  fileKey,
  imageRefs: z.array(z.string()).min(1).max(20),
});
export const FigmaFileImageFillsResponseSchema = res("figma.file.imageFills.response", {
  images: z.record(z.string(), FigmaBytesSchema.nullable()),
});
// Fallback rasters for nodes the renderer cannot draw yet, and frame thumbnails.
export const FigmaFileRenderRequestSchema = req("figma.file.render.request", {
  fileKey,
  ids: z.array(z.string()).min(1).max(20),
  scale: z.number().min(0.1).max(4),
  format: z.enum(["png", "jpg"]).default("png"),
  version: z.string().optional(),
});
export const FigmaFileRenderResponseSchema = res("figma.file.render.response", {
  images: z.record(z.string(), FigmaBytesSchema.nullable()),
  source: FigmaSourceSchema,
});
export const FigmaFileExportRequestSchema = req("figma.file.export.request", {
  fileKey,
  nodeId: z.string(),
  format: z.enum(["png", "jpg", "svg", "pdf"]),
  scale: z.number().min(1).max(4).default(1),
});
export const FigmaFileExportResponseSchema = res("figma.file.export.response", {
  file: FigmaBytesSchema.nullable(),
  fileName: z.string().nullable(),
});
export const FigmaFileVersionsRequestSchema = req("figma.file.versions.request", { fileKey });
export const FigmaFileVersionsResponseSchema = res("figma.file.versions.response", {
  versions: z.array(FigmaVersionSchema),
});
export const FigmaFilePrototypeRequestSchema = req("figma.file.prototype.request", {
  fileKey,
  pageId: z.string().optional(),
});
export const FigmaFilePrototypeResponseSchema = res("figma.file.prototype.response", {
  prototype: FigmaPrototypeSchema.nullable(),
});
// ADR-0037: playback reads only the visible frames at the outline's immutable version.
// `.min(1)` on both fields is load-bearing: the versioned node cache treats an empty version or
// an empty frame id as absent (latest / no-op), which defeats snapshot pinning. Old RPCs keep
// their plain strings unchanged.
export const FigmaFilePlaybackRequestSchema = req("figma.file.playback.request", {
  fileKey,
  frameIds: z.array(z.string().min(1)).min(1).max(10),
  version: z.string().min(1),
});
export const FigmaFilePlaybackResponseSchema = res("figma.file.playback.response", {
  frames: z.record(z.string(), FigmaNodeSchema),
  prototype: FigmaPrototypeSchema.nullable(),
});
export const FigmaFileWatchRequestSchema = req("figma.file.watch.request", { fileKey });
export const FigmaFileWatchResponseSchema = res("figma.file.watch.response", {
  watchId: z.string(),
});
export const FigmaFileUnwatchRequestSchema = req("figma.file.unwatch.request", {
  watchId: z.string(),
});
export const FigmaFileUnwatchResponseSchema = res("figma.file.unwatch.response", {});
export const FigmaFileChangedSchema = z.object({
  type: z.literal("figma.file.changed"),
  watchId: z.string(),
  fileKey: z.string(),
  version: z.string(),
  source: FigmaSourceSchema,
  // Link only: node ids the plugin reported as changed; REST changes reload what is visible.
  nodeIds: z.array(z.string()).optional(),
});
export type FigmaFileChanged = z.infer<typeof FigmaFileChangedSchema>;

export const FigmaFontsGetRequestSchema = req("figma.fonts.get.request", {
  family: z.string(),
  style: z.string(),
});
export const FigmaFontsGetResponseSchema = res("figma.fonts.get.response", {
  font: FigmaBytesSchema.nullable(), // null: not available; the renderer falls back
});

// ── comments (32.5.4) ────────────────────────────────────────────────────────
export const FigmaCommentsListRequestSchema = req("figma.file.comments.list.request", { fileKey });
export const FigmaCommentsListResponseSchema = res("figma.file.comments.list.response", {
  comments: z.array(FigmaCommentSchema),
});
export const FigmaCommentsPostRequestSchema = req("figma.file.comments.post.request", {
  fileKey,
  message: z.string().min(1),
  parentId: z.string().optional(),
  nodeId: z.string().optional(),
  offset: z.object({ x: z.number(), y: z.number() }).optional(),
});
export const FigmaCommentsPostResponseSchema = res("figma.file.comments.post.response", {
  comment: FigmaCommentSchema.nullable(),
});
export const FigmaCommentsDeleteRequestSchema = req("figma.file.comments.delete.request", {
  fileKey,
  commentId: z.string(),
});
export const FigmaCommentsDeleteResponseSchema = res("figma.file.comments.delete.response", {});
export const FigmaCommentsReactRequestSchema = req("figma.file.comments.react.request", {
  fileKey,
  commentId: z.string(),
  emoji: z.string(),
  remove: z.boolean().default(false),
});
export const FigmaCommentsReactResponseSchema = res("figma.file.comments.react.response", {});

// ── Figma Link (32.4) ────────────────────────────────────────────────────────
export const FigmaLinkStatusRequestSchema = req("figma.link.status.request", {});
export const FigmaLinkStatusResponseSchema = res("figma.link.status.response", {
  status: FigmaLinkStatusSchema,
});
export const FigmaLinkPairRequestSchema = req("figma.link.pair.request", {
  code: z.string().regex(/^\d{6}$/),
});
export const FigmaLinkPairResponseSchema = res("figma.link.pair.response", {
  status: FigmaLinkStatusSchema,
});
export const FigmaLinkRevokeRequestSchema = req("figma.link.revoke.request", {
  // Omit to revoke every pairing key.
  pairingId: z.string().optional(),
});
export const FigmaLinkRevokeResponseSchema = res("figma.link.revoke.response", {});
export const FigmaLinkSettingsRequestSchema = req("figma.link.settings.request", {
  runScriptEnabled: z.boolean(),
});
export const FigmaLinkSettingsResponseSchema = res("figma.link.settings.response", {
  status: FigmaLinkStatusSchema,
});
export const FigmaLinkOpRequestSchema = req("figma.link.op.request", {
  fileKey,
  ops: z.array(FigmaEditOpSchema).min(1).max(100),
});
export const FigmaLinkOpResponseSchema = res("figma.link.op.response", {
  // tempId → real node id for nodes the batch created.
  createdIds: z.record(z.string(), z.string()),
  results: z.array(z.object({ ok: z.boolean(), message: z.string().optional() })),
});
export const FigmaLinkChangedSchema = z.object({
  type: z.literal("figma.link.changed"),
  status: FigmaLinkStatusSchema,
});
export type FigmaLinkChanged = z.infer<typeof FigmaLinkChangedSchema>;

// ── edit queue (32.6.1) ──────────────────────────────────────────────────────
export const FigmaPendingListRequestSchema = req("figma.pending.list.request", { fileKey });
export const FigmaPendingListResponseSchema = res("figma.pending.list.response", {
  ops: z.array(FigmaPendingOpSchema),
});
export const FigmaPendingAddRequestSchema = req("figma.pending.add.request", {
  fileKey,
  ops: z.array(FigmaEditOpSchema).min(1).max(100),
});
export const FigmaPendingAddResponseSchema = res("figma.pending.add.response", {
  ops: z.array(FigmaPendingOpSchema),
});
export const FigmaPendingRemoveRequestSchema = req("figma.pending.remove.request", {
  fileKey,
  opId: z.string(),
});
export const FigmaPendingRemoveResponseSchema = res("figma.pending.remove.response", {});
export const FigmaPendingDiscardRequestSchema = req("figma.pending.discard.request", { fileKey });
export const FigmaPendingDiscardResponseSchema = res("figma.pending.discard.response", {});
export const FigmaPendingApplyRequestSchema = req("figma.pending.apply.request", {
  fileKey,
  // Resolution for ops previously marked `conflict`.
  resolutions: z.record(z.string(), z.enum(["keep_mine", "keep_figma"])).optional(),
});
export const FigmaPendingApplyResponseSchema = res("figma.pending.apply.response", {
  ops: z.array(FigmaPendingOpSchema),
});
export const FigmaPendingChangedSchema = z.object({
  type: z.literal("figma.pending.changed"),
  fileKey: z.string(),
  count: z.number(),
});
export type FigmaPendingChanged = z.infer<typeof FigmaPendingChangedSchema>;

// ── budget (32.8) ────────────────────────────────────────────────────────────
export const FigmaBudgetGetRequestSchema = req("figma.budget.get.request", { connectionId });
export const FigmaBudgetGetResponseSchema = res("figma.budget.get.response", {
  budget: FigmaBudgetSchema.nullable(),
});

// Mobile: a desktop runs the browser step for a delegated sign-in.
export const FigmaOAuthDelegationSchema = z.object({
  type: z.literal("figma.oauth.delegation"),
  attemptId: z.string(),
  authorizeUrl: z.string(),
  redirectUri: z.string(),
});
export type FigmaOAuthDelegation = z.infer<typeof FigmaOAuthDelegationSchema>;

export const FigmaRequestSchemas = [
  FigmaConnectionsListRequestSchema,
  FigmaConnectionsRemoveRequestSchema,
  FigmaConnectionsTestRequestSchema,
  FigmaOAuthBeginRequestSchema,
  FigmaOAuthCompleteRequestSchema,
  FigmaOAuthDelegateRequestSchema,
  FigmaFilesListRequestSchema,
  FigmaFilesAddRequestSchema,
  FigmaFilesRemoveRequestSchema,
  FigmaFilesPinRequestSchema,
  FigmaTeamsAddRequestSchema,
  FigmaTeamsRemoveRequestSchema,
  FigmaTeamsListRequestSchema,
  FigmaTeamsProjectsRequestSchema,
  FigmaTeamsFilesRequestSchema,
  FigmaFileOutlineRequestSchema,
  FigmaFileNodesRequestSchema,
  FigmaFileImageFillsRequestSchema,
  FigmaFileRenderRequestSchema,
  FigmaFileExportRequestSchema,
  FigmaFileVersionsRequestSchema,
  FigmaFilePrototypeRequestSchema,
  FigmaFilePlaybackRequestSchema,
  FigmaFileWatchRequestSchema,
  FigmaFileUnwatchRequestSchema,
  FigmaFontsGetRequestSchema,
  FigmaCommentsListRequestSchema,
  FigmaCommentsPostRequestSchema,
  FigmaCommentsDeleteRequestSchema,
  FigmaCommentsReactRequestSchema,
  FigmaLinkStatusRequestSchema,
  FigmaLinkPairRequestSchema,
  FigmaLinkRevokeRequestSchema,
  FigmaLinkSettingsRequestSchema,
  FigmaLinkOpRequestSchema,
  FigmaPendingListRequestSchema,
  FigmaPendingAddRequestSchema,
  FigmaPendingRemoveRequestSchema,
  FigmaPendingDiscardRequestSchema,
  FigmaPendingApplyRequestSchema,
  FigmaBudgetGetRequestSchema,
] as const;

export const FigmaResponseSchemas = [
  FigmaConnectionsListResponseSchema,
  FigmaConnectionsRemoveResponseSchema,
  FigmaConnectionsTestResponseSchema,
  FigmaOAuthBeginResponseSchema,
  FigmaOAuthCompleteResponseSchema,
  FigmaOAuthDelegateResponseSchema,
  FigmaFilesListResponseSchema,
  FigmaFilesAddResponseSchema,
  FigmaFilesRemoveResponseSchema,
  FigmaFilesPinResponseSchema,
  FigmaTeamsAddResponseSchema,
  FigmaTeamsRemoveResponseSchema,
  FigmaTeamsListResponseSchema,
  FigmaTeamsProjectsResponseSchema,
  FigmaTeamsFilesResponseSchema,
  FigmaFileOutlineResponseSchema,
  FigmaFileNodesResponseSchema,
  FigmaFileImageFillsResponseSchema,
  FigmaFileRenderResponseSchema,
  FigmaFileExportResponseSchema,
  FigmaFileVersionsResponseSchema,
  FigmaFilePrototypeResponseSchema,
  FigmaFilePlaybackResponseSchema,
  FigmaFileWatchResponseSchema,
  FigmaFileUnwatchResponseSchema,
  FigmaFontsGetResponseSchema,
  FigmaCommentsListResponseSchema,
  FigmaCommentsPostResponseSchema,
  FigmaCommentsDeleteResponseSchema,
  FigmaCommentsReactResponseSchema,
  FigmaLinkStatusResponseSchema,
  FigmaLinkPairResponseSchema,
  FigmaLinkRevokeResponseSchema,
  FigmaLinkSettingsResponseSchema,
  FigmaLinkOpResponseSchema,
  FigmaPendingListResponseSchema,
  FigmaPendingAddResponseSchema,
  FigmaPendingRemoveResponseSchema,
  FigmaPendingDiscardResponseSchema,
  FigmaPendingApplyResponseSchema,
  FigmaBudgetGetResponseSchema,
] as const;

export const FigmaPushSchemas = [
  FigmaFileChangedSchema,
  FigmaLinkChangedSchema,
  FigmaPendingChangedSchema,
  FigmaOAuthDelegationSchema,
] as const;

export type FigmaRequest = z.infer<(typeof FigmaRequestSchemas)[number]>;
export type FigmaRequestType = FigmaRequest["type"];
export type FigmaResponse = z.infer<(typeof FigmaResponseSchemas)[number]>;
export type FigmaPush = z.infer<(typeof FigmaPushSchemas)[number]>;

/** The response type paired with a request type (`….request` → `….response`). */
export type FigmaResponseTypeFor<T extends FigmaRequestType> = T extends `${infer Prefix}.request`
  ? `${Prefix}.response`
  : never;

export type FigmaResponseFor<T extends FigmaRequestType> = Extract<
  FigmaResponse,
  { type: FigmaResponseTypeFor<T> }
>;

/** Request params as a client passes them: everything but `type` and `requestId`. */
export type FigmaRequestParams<T extends FigmaRequestType> = Omit<
  z.input<Extract<(typeof FigmaRequestSchemas)[number], { shape: { type: z.ZodLiteral<T> } }>>,
  "type" | "requestId"
>;

/** The success payload of a response, without the envelope fields. */
export type FigmaResponseData<T extends FigmaRequestType> = Omit<
  FigmaResponseFor<T>["payload"],
  "requestId" | "error"
>;

export const FIGMA_REQUEST_TYPES: readonly FigmaRequestType[] = FigmaRequestSchemas.map(
  (schema) => schema.shape.type.value,
);
