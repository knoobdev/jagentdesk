import { z } from "zod";
import {
  FigmaColorSchema,
  FigmaEditOpSchema,
  type FigmaNode,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { JAgentDeskToolDefinition, JAgentDeskToolResult } from "../agent/tools/types.js";
import type { FigmaContext } from "./context.js";
import { FigmaServiceError } from "./context.js";
import type { FigmaService } from "./service.js";
import { addPendingOps, loadPendingOps } from "./pending.js";
import { executeRemoteWrite, readRemoteMetadata } from "./handlers/remote.js";
import { FIGMA_REMOTE_MAX_CODE_BYTES } from "./remote/connector.js";

type FigmaColor = z.infer<typeof FigmaColorSchema>;

// figma_* agent tools (spec 32.7). REST reads run without asking; every write (Figma Link tools,
// queue writes, comments) raises the permission card first and runs only on "allow". Results are
// compact and size-capped — never raw megabyte JSON. `figma_link_run_script` exists only while
// Run script is enabled (32.4.2) and always asks.

export const FIGMA_TOOL_RESULT_MAX_CHARS = 24_000;
export const FIGMA_TOOL_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export const FIGMA_SAFE_WORKFLOW =
  "Follow the Forge safe workflow: design_preflight, get_build_checkpoint, then edit in small batches, audit_design, get_screenshot, commit_build_checkpoint. " +
  'For edits without the Figma Link plugin, prefer the official remote editor: when figma_remote_status reports connected, use figma_remote_execute (load fonts before editing text, return the created/edited node IDs); when auth is missing, tell the user to tap "Connect editing". ' +
  "A remote timeout or connection loss is never auto-retried (the side effect may have happened), and re-read the affected IDs/props with figma_remote_read before claiming the task is done.";

export interface FigmaToolPermissionRequest {
  name: string;
  kind: "tool";
  title: string;
  description: string;
  input: Record<string, unknown>;
}

export type RequestFigmaToolPermission = (
  agentId: string,
  request: FigmaToolPermissionRequest,
) => Promise<AgentPermissionResponse>;

export interface FigmaAgentTool extends JAgentDeskToolDefinition {
  requiresPermission: boolean;
}

export interface FigmaAgentToolDependencies {
  service: FigmaService;
  callerAgentId: string | null;
  requestPermission: RequestFigmaToolPermission;
}

/** One entry of the Forge tool list (figma-integration.md §9.4): `write` = needs permission. */
export interface ForgeToolSpec {
  name: string;
  write: boolean;
  desc: string;
}

// The 100 Forge tools, read/write-classified. Read-class tools run directly; write-class tools
// (including save_screenshots, which writes files, and run_script) ask permission first.
export const FIGMA_FORGE_TOOLS: readonly ForgeToolSpec[] = [
  {
    name: "list_files",
    write: false,
    desc: "List all currently connected Figma/FigJam files. Returns fileKey and fileName for each. Use the fileKey to target a specific file in other tools.",
  },
  {
    name: "get_document",
    write: false,
    desc: "Get the current Figma/FigJam page document tree. When multiple files are connected, specify fileKey.",
  },
  {
    name: "get_selection",
    write: false,
    desc: "Get the currently selected nodes in Figma/FigJam. When multiple files are connected, specify fileKey.",
  },
  {
    name: "get_layout_tree",
    write: false,
    desc: "Read absolute node transforms and layout bounds for a capture root. Separate screenshot calls are non-atomic.",
  },
  {
    name: "get_node",
    write: false,
    desc: "Get a specific Figma/FigJam node by ID. Accepts top-level IDs like '4029:12345' and instance-child IDs like 'I12740:17806;12740:17793'. Never use hyphens.",
  },
  {
    name: "get_prototype_connections",
    write: false,
    desc: "Read-only. List the prototype interactions on a node and all its descendants, including instance sublayers.",
  },
  {
    name: "trace_prototype_flow",
    write: false,
    desc: "Read-only. Follow prototype navigation breadth-first from a screen: returns the screens reached (with depth and the node that reached them) and every interaction edge with its source node, trigger,…",
  },
  {
    name: "get_styles",
    write: false,
    desc: "Get all local styles in the document. When multiple files are connected, specify fileKey.",
  },
  {
    name: "get_metadata",
    write: false,
    desc: "Get metadata about the current Figma/FigJam document including file name, pages, and current page info. When multiple files are connected, specify fileKey.",
  },
  {
    name: "get_design_context",
    write: false,
    desc: "Get the design context for the current selection or page. Returns a summarized tree structure optimized for understanding the current design context. Works in both Figma and FigJam.",
  },
  {
    name: "get_variable_defs",
    write: false,
    desc: "Get all local variable definitions including variable collections, modes, and variable values. Variables are Figma's system for design tokens (colors, numbers, strings, booleans).",
  },
  {
    name: "get_screenshot",
    write: false,
    desc: "Export a screenshot of the selected nodes or specific nodes by ID. PNG/JPG come back as viewable images plus a metadata text block; SVG/PDF come back as base64 JSON. Works in both Figma and FigJam.",
  },
  {
    name: "set_node_visibility",
    write: true,
    desc: "Show or hide specific Figma nodes. Returns previous visibility for each node so you can restore them after.",
  },
  {
    name: "set_text_content",
    write: true,
    desc: "Update the contents of a text node. Works on TEXT nodes plus FigJam STICKY and SHAPE_WITH_TEXT nodes (their text sublayer). The plugin loads the node's fonts before applying the new text.",
  },
  {
    name: "set_text_properties",
    write: true,
    desc: "Patch common text properties such as font family/style, size, line height, letter spacing, and fill color, plus alignment, auto-resize, and bounds on TEXT nodes.",
  },
  {
    name: "set_node_properties",
    write: true,
    desc: "Patch common node properties such as name, position, size, visibility, opacity, and corner radius. Accepts either a single nodeId or a nodeIds array to apply the same changes to multiple nodes in one…",
  },
  {
    name: "set_solid_fill",
    write: true,
    desc: "Replace a node's fill (or stroke) with a single solid paint. Provide a hex color and optional paint opacity — fillHex/fillOpacity are accepted as aliases. Use set_gradient_fill for gradient paints.",
  },
  {
    name: "set_gradient_fill",
    write: true,
    desc: "Replace a node's fill (or stroke) with a gradient paint. Provide ordered stops (position 0..1, hex color, optional alpha) and an optional 2x3 gradientTransform matching Figma's gradientTransform…",
  },
  {
    name: "set_effects",
    write: true,
    desc: "Replace a node's effects list (drop/inner shadows, layer/background blurs). Pass an empty array to clear all effects. Each entry mirrors the shape returned by get_node's `effects` field.",
  },
  {
    name: "set_stroke_properties",
    write: true,
    desc: "Patch stroke geometry properties: weight, align, dash pattern, cap, join. Use set_solid_fill/set_gradient_fill with target='stroke' to set the paint itself.",
  },
  {
    name: "set_auto_layout",
    write: true,
    desc: "Configure auto-layout on a frame: direction, gap, padding, alignment, sizing modes, wrap. Set layoutMode='NONE' to disable auto-layout on the frame.",
  },
  {
    name: "create_page",
    write: true,
    desc: "Create a new page in the Figma document, optionally naming it and switching the editor to it. Returns the new page's ID, which can be passed as parentId to create_frame / create_text / create_shape /…",
  },
  {
    name: "create_frame",
    write: true,
    desc: "Create a new frame, optionally inside a specified parent. You can set name, size, position, and a solid fill. When multiple files are connected, specify fileKey.",
  },
  {
    name: "create_section",
    write: true,
    desc: "Create a new section — a named container with its own background, resizable independently of its contents. Works in Figma and FigJam. When multiple files are connected, specify fileKey.",
  },
  {
    name: "create_text",
    write: true,
    desc: "Create a new text node, optionally inside a specified parent. You can set its content, font, size, alignment, color, position, and bounds. Works in both Figma and FigJam.",
  },
  {
    name: "create_shape",
    write: true,
    desc: "Create a rectangle, ellipse, or line, optionally inside a specified parent. You can set its size, position, rotation, fill, and stroke. Works in both Figma and FigJam.",
  },
  {
    name: "create_shape_with_text",
    write: true,
    desc: "Create a FigJam shape that carries its own text label (SHAPE_WITH_TEXT), e.g. ROUNDED_RECTANGLE, DIAMOND, or ENG_DATABASE.",
  },
  {
    name: "create_image",
    write: true,
    desc: "Create an image-backed rectangle from a local file path, remote URL, or data URI. You can set its parent, position, size, corner radius, and fit mode. Works in both Figma and FigJam.",
  },
  {
    name: "create_svg",
    write: true,
    desc: "Insert raw SVG markup or a workspace-local SVG file as editable Figma vector layers using figma.createNodeFromSvg. You can set its parent, position, size, and semantic name.",
  },
  {
    name: "import_html_layers",
    write: true,
    desc: "Import a DOM serialization (JSON produced by html-figma's browser htmlToFigma()) as editable Figma layers inside a new wrapper frame — frames, text, rectangles, and SVG vectors in one call.",
  },
  {
    name: "create_sticky",
    write: true,
    desc: "Create a new sticky note in FigJam. You can set its text content, position, and whether it uses the wide shape (isWideWidth). Only available in FigJam.",
  },
  {
    name: "create_connector",
    write: true,
    desc: "Create a connector between two nodes in FigJam. You can specify start/end node IDs or absolute positions, plus the attachment side on each node (startAnchor/endAnchor: top, bottom, left, right,…",
  },
  {
    name: "duplicate_nodes",
    write: true,
    desc: "Duplicate one or more nodes in place. The duplicates remain under the same parent as the originals. Works in both Figma and FigJam. When multiple files are connected, specify fileKey.",
  },
  {
    name: "duplicate_with_offset",
    write: true,
    desc: "Duplicate nodes and move each duplicate by a fixed offset in one call. Returns the mapping from source node IDs to duplicate node IDs. Works in both Figma and FigJam.",
  },
  {
    name: "fit_to_content",
    write: true,
    desc: "Resize a SECTION so it tightly wraps its children with optional padding: children are shifted so their bounding box starts at the padding, then the section is resized to bbox + 2×padding.",
  },
  {
    name: "distribute_horizontally",
    write: true,
    desc: "Space three or more nodes with equal horizontal gaps, keeping the leftmost and rightmost nodes fixed. Works in both Figma and FigJam. When multiple files are connected, specify fileKey.",
  },
  {
    name: "distribute_vertically",
    write: true,
    desc: "Space three or more nodes with equal vertical gaps, keeping the topmost and bottommost nodes fixed. Works in both Figma and FigJam. When multiple files are connected, specify fileKey.",
  },
  {
    name: "align_to_grid",
    write: true,
    desc: "Snap each node's x/y position to a grid of the given size. Works in both Figma and FigJam. When multiple files are connected, specify fileKey.",
  },
  {
    name: "place_below",
    write: true,
    desc: "Move a node directly below a reference node with an optional gap and start/center alignment across the reference's width. Works in both Figma and FigJam.",
  },
  {
    name: "place_right_of",
    write: true,
    desc: "Move a node directly to the right of a reference node with an optional gap and start/center alignment across the reference's height. Works in both Figma and FigJam.",
  },
  {
    name: "reparent_nodes",
    write: true,
    desc: "Move one or more nodes into a different parent container. Works in both Figma and FigJam. When multiple files are connected, specify fileKey.",
  },
  {
    name: "group_nodes",
    write: true,
    desc: "Wrap a list of nodes in a new group. Nodes must share a common parent (or supply parentId explicitly). Returns the new group's node ID.",
  },
  {
    name: "ungroup_node",
    write: true,
    desc: "Ungroup a group or frame — its children move up to its parent and the wrapper is removed. Returns the IDs of the orphaned children in their new parent.",
  },
  {
    name: "set_selection",
    write: false,
    desc: "Set the current page selection to a list of node IDs. Pass an empty array to clear the selection. Works in Figma design editor, Dev Mode, and FigJam.",
  },
  {
    name: "scroll_and_zoom_into_view",
    write: false,
    desc: "Scroll and zoom the Figma/FigJam viewport so the given nodes are framed in view. Works in Figma design editor, Dev Mode, and FigJam.",
  },
  {
    name: "delete_nodes",
    write: true,
    desc: "Delete one or more nodes. This is destructive and requires confirm: true. Page and document nodes cannot be deleted through this tool. Works in both Figma and FigJam.",
  },
  {
    name: "run_script",
    write: true,
    desc: "Run Plugin API JavaScript in the Figma plugin sandbox. The code is the body of an async function with `figma` in scope; `return` a JSON-serializable value.",
  },
  {
    name: "get_motion_styles",
    write: false,
    desc: "List all available animation presets in Figma (Motion API beta). When multiple files are connected, specify fileKey.",
  },
  {
    name: "get_node_motion",
    write: false,
    desc: "Read a node's current animationStyles, animations, manualKeyframeTracks, and timelines (Motion API beta). When multiple files are connected, specify fileKey.",
  },
  {
    name: "apply_animation_style",
    write: true,
    desc: "Apply a preset animation style to a node (Motion API beta). When multiple files are connected, specify fileKey.",
  },
  {
    name: "remove_animation_style",
    write: true,
    desc: "Remove an applied animation style from a node (Motion API beta). If no animationStyleId is provided, removes all styles. When multiple files are connected, specify fileKey.",
  },
  {
    name: "apply_manual_keyframe_track",
    write: true,
    desc: "Applies or replaces the manual Motion keyframe track for a property, paint, or effect field on a node. When multiple files are connected, specify fileKey.",
  },
  {
    name: "remove_manual_keyframe_track",
    write: true,
    desc: "Removes the manual Motion keyframe track for a property, paint, or effect field on a node. When multiple files are connected, specify fileKey.",
  },
  {
    name: "set_timeline_duration",
    write: true,
    desc: "Sets the duration (in seconds) for a timeline. When multiple files are connected, specify fileKey.",
  },
  {
    name: "save_screenshots",
    write: true,
    desc: "Export screenshots for multiple nodes and save them directly to the local filesystem. Returns metadata only (no base64). When multiple files are connected, specify fileKey.",
  },
  {
    name: "design_preflight",
    write: false,
    desc: "Before building: verify target node IDs and exact requested font faces. Does not create product nodes. Loading a font does not prove rendered glyphs; audit after building.",
  },
  {
    name: "audit_design",
    write: false,
    desc: "Read-only bounded structural audit: missing fonts, zero-size text, unstyled text, broken instance mains, dead native reaction targets, clipping candidates and optional token scales.",
  },
  {
    name: "get_build_checkpoint",
    write: false,
    desc: "Read a build's stable node registry and revision before updating or retrying after disconnect. Returns whether saved nodes still exist.",
  },
  {
    name: "commit_build_checkpoint",
    write: true,
    desc: "Record a validated batch's node IDs in document plugin data using expectedRevision and a unique operationId. Same last operation/content replays without mutation; conflicts require reconciliation.",
  },
  {
    name: "create_component",
    write: true,
    desc: "Convert an existing node (usually a FRAME) into a reusable COMPONENT in place.",
  },
  {
    name: "create_instance",
    write: true,
    desc: "Create an INSTANCE of a COMPONENT (or the default variant of a COMPONENT_SET), optionally inside a parent and with variant properties.",
  },
  {
    name: "combine_as_variants",
    write: true,
    desc: "Combine sibling COMPONENT nodes into a COMPONENT_SET (variants). Name components 'Prop=Value' first for proper variant properties.",
  },
  {
    name: "get_local_components",
    write: false,
    desc: "List components and component sets defined in this file (all pages).",
  },
  {
    name: "swap_component",
    write: true,
    desc: "Swap the main component of an INSTANCE, keeping position and size.",
  },
  {
    name: "detach_instance",
    write: true,
    desc: "Detach instances into plain frames; visual properties are kept.",
  },
  {
    name: "create_variable_collection",
    write: true,
    desc: "Create a local variable collection. Free plans allow one mode per collection; use name prefixes like 'light/…' and 'dark/…' there.",
  },
  {
    name: "add_variable_mode",
    write: true,
    desc: "Add a mode (e.g. Dark) to a collection. Fails with 'Limited to 1 modes only' on free plans; do not retry.",
  },
  {
    name: "create_variable",
    write: true,
    desc: "Create a variable in a collection. Use slash names ('color/accent', 'space/md'). The value sets the default mode.",
  },
  {
    name: "set_variable_value",
    write: true,
    desc: "Set a variable's value for one mode, either a literal value or an alias to another variable.",
  },
  {
    name: "bind_variable_to_node",
    write: true,
    desc: "Bind a variable to a node property. COLOR: fillColor, strokeColor. FLOAT: width, height, opacity, cornerRadius and per-corner radii, strokeWeight, itemSpacing, counterAxisSpacing, padding*, min/max…",
  },
  {
    name: "delete_variable",
    write: true,
    desc: "Delete one variable (variableId) or a whole collection (collectionId). Provide exactly one.",
  },
  {
    name: "export_tokens",
    write: false,
    desc: "Export local variables (every mode, aliases resolved to var() in CSS) and solid paint styles as JSON or CSS custom properties.",
  },
  {
    name: "create_paint_style",
    write: true,
    desc: "Create a local paint style with one solid color.",
  },
  {
    name: "create_text_style",
    write: true,
    desc: "Create a local text style. The font must be available to Figma.",
  },
  {
    name: "create_effect_style",
    write: true,
    desc: "Create a local effect style: drop/inner shadow or layer/background blur.",
  },
  {
    name: "create_grid_style",
    write: true,
    desc: "Create a local layout grid style (GRID, COLUMNS, or ROWS).",
  },
  {
    name: "update_paint_style",
    write: true,
    desc: "Update a paint style's name, color, or description.",
  },
  { name: "delete_style", write: true, desc: "Delete a local style by ID." },
  {
    name: "apply_style_to_node",
    write: true,
    desc: "Link a node to a local paint, text, effect, or grid style.",
  },
  { name: "get_reactions", write: false, desc: "Read prototype reactions on a node." },
  {
    name: "set_reactions",
    write: true,
    desc: "Set prototype reactions on a node. Each reaction is {trigger:{type:'ON_CLICK'|…}, actions:[{type:'NODE', destinationId, navigation:'NAVIGATE'|'OVERLAY'|…, transition:{type:'DISSOLVE', duration:0.3,…",
  },
  {
    name: "remove_reactions",
    write: true,
    desc: "Remove reactions by zero-based index, or all when indices is omitted.",
  },
  {
    name: "set_layout_child",
    write: true,
    desc: "Set how nodes size and position inside their auto-layout parent: layoutSizingHorizontal/Vertical FIXED|HUG|FILL (FILL needs an auto-layout parent; HUG applies to auto-layout frames and text),…",
  },
  {
    name: "set_constraints",
    write: true,
    desc: "Set resize constraints relative to the parent (non-auto-layout parents).",
  },
  { name: "rotate_nodes", write: true, desc: "Rotate nodes to an absolute angle in degrees." },
  { name: "reorder_nodes", write: true, desc: "Change z-order within the parent." },
  { name: "set_blend_mode", write: true, desc: "Set the blend mode of nodes." },
  { name: "lock_nodes", write: true, desc: "Lock nodes against accidental edits." },
  { name: "unlock_nodes", write: true, desc: "Unlock nodes." },
  {
    name: "find_replace_text",
    write: true,
    desc: "Find and replace text in every TEXT node of a subtree (default: current page). Fonts are loaded automatically.",
  },
  {
    name: "scan_text_nodes",
    write: false,
    desc: "List TEXT nodes in a subtree with their content and font.",
  },
  {
    name: "search_nodes",
    write: false,
    desc: "Find nodes by name substring (case-insensitive) and/or type in a subtree.",
  },
  {
    name: "scan_nodes_by_types",
    write: false,
    desc: "Find all nodes of the given types in a subtree, regardless of name.",
  },
  {
    name: "batch_rename_nodes",
    write: true,
    desc: "Rename nodes with find/replace (optionally regex) and/or a prefix and suffix.",
  },
  {
    name: "get_fonts",
    write: false,
    desc: "List fonts used in a subtree (default: current page) by usage count.",
  },
  { name: "navigate_to_page", write: false, desc: "Switch the current page by ID or exact name." },
  { name: "rename_page", write: true, desc: "Rename a page found by ID or exact name." },
  {
    name: "delete_page",
    write: true,
    desc: "Delete a page by ID or exact name. The last page cannot be deleted.",
  },
  {
    name: "get_viewport",
    write: false,
    desc: "Read the viewport center, zoom, and visible bounds.",
  },
  {
    name: "get_annotations",
    write: false,
    desc: "Read Dev Mode annotations in a subtree (default: current page).",
  },
];

class ToolFailure extends Error {}

type ToolOutput = string | { text: string; images?: { data: string; mimeType: string }[] };

interface ToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  /** Present for writes: what the permission card shows. */
  permission?: (
    input: z.infer<z.ZodObject<Shape>>,
  ) => Omit<FigmaToolPermissionRequest, "name" | "kind">;
  /** Runs before the permission card: refuse a tool whose prerequisite is missing. */
  precheck?: (input: z.infer<z.ZodObject<Shape>>, ctx: FigmaContext) => void;
  run: (input: z.infer<z.ZodObject<Shape>>, ctx: FigmaContext) => Promise<ToolOutput>;
}

function define<Shape extends z.ZodRawShape>(
  deps: FigmaAgentToolDependencies,
  spec: ToolSpec<Shape>,
): FigmaAgentTool {
  const schema = z.object(spec.inputSchema);
  const suffix = spec.permission ? " Requires the user's approval." : " Read-only, auto-approved.";
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description + suffix,
    inputSchema: spec.inputSchema,
    requiresPermission: spec.permission !== undefined,
    async handler(raw: unknown) {
      try {
        const input = schema.parse(raw);
        spec.precheck?.(input, deps.service.ctx);
        if (spec.permission) {
          if (!deps.callerAgentId) {
            throw new ToolFailure(`${spec.name} is only available to agent-scoped tool sessions.`);
          }
          const ask = spec.permission(input);
          const decision = await deps.requestPermission(deps.callerAgentId, {
            name: spec.name,
            kind: "tool",
            ...ask,
          });
          if (decision.behavior !== "allow") throw new ToolFailure("Denied by user.");
        }
        const output = await spec.run(input, deps.service.ctx);
        if (typeof output === "string") return text(output);
        const content: JAgentDeskToolResult["content"] = [{ type: "text", text: cap(output.text) }];
        for (const image of output.images ?? []) {
          content.push({ type: "image", data: image.data, mimeType: image.mimeType });
        }
        return { content };
      } catch (error) {
        const message =
          error instanceof FigmaServiceError ||
          error instanceof ToolFailure ||
          error instanceof z.ZodError
            ? error.message
            : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  };
}

function text(markdown: string): JAgentDeskToolResult {
  return { content: [{ type: "text", text: cap(markdown) }] };
}

function cap(markdown: string): string {
  if (markdown.length <= FIGMA_TOOL_RESULT_MAX_CHARS) return markdown;
  return `${markdown.slice(0, FIGMA_TOOL_RESULT_MAX_CHARS)}\n… truncated ${
    markdown.length - FIGMA_TOOL_RESULT_MAX_CHARS
  } of ${markdown.length} chars`;
}

const HEAVY_NODE_KEYS = new Set([
  "vectorPaths",
  "fillGeometry",
  "strokeGeometry",
  "geometry",
  "exportSettings",
  "thumbnailUrl",
  "thumbnail_url",
]);

/** Compact a REST/Link value: drop bulky render keys, then cap. Never returns raw megabyte JSON. */
function compact(value: unknown): string {
  const json =
    typeof value === "string"
      ? value
      : (JSON.stringify(value, (key, v) => (HEAVY_NODE_KEYS.has(key) ? undefined : v)) ?? "null");
  return cap(json);
}

async function connectionForFile(ctx: FigmaContext, fileKey: string): Promise<string> {
  const file = await ctx.store.getFile(fileKey);
  if (!file) {
    throw new FigmaServiceError(
      "not_found",
      `File ${fileKey} is not added in JAgentDesk (Figma → add by URL).`,
    );
  }
  return file.connectionId;
}

async function restGet<T>(
  ctx: FigmaContext,
  fileKey: string,
  pathName: string,
  query: Record<string, string | number | boolean | undefined>,
  tier: "1" | "2" | "3",
): Promise<T> {
  const connectionId = await connectionForFile(ctx, fileKey);
  return ctx.rest.getJson<T>({ connectionId, path: pathName, query, tier });
}

async function restSend<T>(
  ctx: FigmaContext,
  fileKey: string,
  method: "POST" | "PUT" | "DELETE",
  pathName: string,
  body: unknown,
  tier: "1" | "2" | "3",
): Promise<T> {
  const connectionId = await connectionForFile(ctx, fileKey);
  return ctx.rest.sendJson<T>({ connectionId, method, path: pathName, body, tier });
}

// ── CSS from node properties (32.5.2 / 32.7 figma_inspect_css) ───────────────

function colorToCss(color: FigmaColor): string {
  const channel = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const r = channel(color.r);
  const g = channel(color.g);
  const b = channel(color.b);
  const a = Math.round(Math.min(1, Math.max(0, color.a)) * 100) / 100;
  if (a >= 1) {
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
export const __test_colorToCss = colorToCss;

function paintToCss(paint: Record<string, unknown>): string | null {
  if (paint.visible === false) return null;
  if (paint.type === "SOLID" && paint.color) return colorToCss(paint.color as FigmaColor);
  if (paint.type === "GRADIENT_LINEAR") {
    const stops =
      (paint.gradientStops as { color: FigmaColor; position: number }[] | undefined) ?? [];
    const parts = stops.map((s) => `${colorToCss(s.color)} ${Math.round(s.position * 100)}%`);
    return parts.length > 0 ? `linear-gradient(${parts.join(", ")})` : null;
  }
  if (paint.type === "IMAGE") return "url(<image fill>)";
  return null;
}

function firstVisiblePaint(
  node: FigmaNode,
  key: "fills" | "strokes",
): Record<string, unknown> | null {
  const paints = node[key];
  if (!Array.isArray(paints)) return null;
  for (const paint of paints) {
    if (
      paint &&
      typeof paint === "object" &&
      (paint as Record<string, unknown>).visible !== false
    ) {
      return paint as Record<string, unknown>;
    }
  }
  return null;
}

function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

const TEXT_ALIGN: Record<string, string> = {
  LEFT: "left",
  CENTER: "center",
  RIGHT: "right",
  JUSTIFIED: "justify",
};
const AXIS_ALIGN: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
};
const FONT_WEIGHT: Record<string, number> = {
  Thin: 100,
  ExtraLight: 200,
  Light: 300,
  Regular: 400,
  Medium: 500,
  SemiBold: 600,
  Bold: 700,
  ExtraBold: 800,
  Black: 900,
};

/** Compute a CSS rule from a Figma node's properties (best effort, inspect-oriented). */
export function figmaNodeToCss(node: FigmaNode): string {
  const rules = [
    ...appearanceRules(node),
    ...radiusRules(node),
    ...paintRules(node),
    ...effectRules(node),
    ...(node.type === "TEXT" ? textRules(node) : []),
    ...layoutRules(node),
  ];
  if (rules.length === 0) return `/* ${node.id} ${node.name}: nothing expressible as CSS */`;
  const selector = node.name.trim().replace(/[^\w-]+/g, "-") || node.id.replace(":", "-");
  return `.${selector} {\n  /* ${node.id} ${node.type} */\n${rules.map((r) => `  ${r}`).join("\n")}\n}`;
}

function appearanceRules(node: FigmaNode): string[] {
  const rules: string[] = [];
  if (node.visible === false) rules.push("display: none;");
  if (typeof node.opacity === "number" && node.opacity !== 1) {
    rules.push(`opacity: ${Math.round(node.opacity * 100) / 100};`);
  }
  const bounds = node.absoluteBoundingBox as { width?: number; height?: number } | undefined;
  if (typeof bounds?.width === "number") rules.push(`width: ${px(bounds.width)};`);
  if (typeof bounds?.height === "number") rules.push(`height: ${px(bounds.height)};`);
  return rules;
}

function radiusRules(node: FigmaNode): string[] {
  const radius = node.cornerRadius;
  if (typeof radius === "number") return [`border-radius: ${px(radius)};`];
  if (Array.isArray(node.rectangleCornerRadii)) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii as number[];
    return [`border-radius: ${px(tl)} ${px(tr)} ${px(br)} ${px(bl)};`];
  }
  return [];
}

function paintRules(node: FigmaNode): string[] {
  const rules: string[] = [];
  const fill = firstVisiblePaint(node, "fills");
  const fillCss = fill ? paintToCss(fill) : null;
  if (fillCss) {
    if (node.type === "TEXT") rules.push(`color: ${fillCss};`);
    else if (fillCss.startsWith("url(")) rules.push(`background-image: ${fillCss};`);
    else rules.push(`background-color: ${fillCss};`);
  }
  const stroke = firstVisiblePaint(node, "strokes");
  const strokeCss = stroke ? paintToCss(stroke) : null;
  if (strokeCss && typeof node.strokeWeight === "number" && node.strokeWeight > 0) {
    rules.push(`border: ${px(node.strokeWeight)} solid ${strokeCss};`);
  }
  return rules;
}

function effectRules(node: FigmaNode): string[] {
  if (!Array.isArray(node.effects)) return [];
  const rules: string[] = [];
  const shadows: string[] = [];
  let layerBlur: number | null = null;
  let backBlur: number | null = null;
  for (const effect of node.effects as Record<string, unknown>[]) {
    if (effect.visible === false) continue;
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      const offset = (effect.offset as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
      const spread = typeof effect.spread === "number" ? ` ${px(effect.spread)}` : "";
      shadows.push(
        `${effect.type === "INNER_SHADOW" ? "inset " : ""}${px(offset.x)} ${px(offset.y)} ${px(
          (effect.radius as number | undefined) ?? 0,
        )}${spread} ${colorToCss(effect.color as FigmaColor)}`,
      );
    } else if (effect.type === "LAYER_BLUR") {
      layerBlur = (effect.radius as number | undefined) ?? 0;
    } else if (effect.type === "BACKGROUND_BLUR") {
      backBlur = (effect.radius as number | undefined) ?? 0;
    }
  }
  if (shadows.length > 0) rules.push(`box-shadow: ${shadows.join(", ")};`);
  if (layerBlur !== null) rules.push(`filter: blur(${px(layerBlur)});`);
  if (backBlur !== null) rules.push(`backdrop-filter: blur(${px(backBlur)});`);
  return rules;
}

function textRules(node: FigmaNode): string[] {
  return [...textFontRules(node), ...textStyleRules(node)];
}

function textFontRules(node: FigmaNode): string[] {
  const rules: string[] = [];
  const style = node.style as Record<string, unknown> | undefined;
  const fontName = node.fontName as { family?: string; style?: string } | undefined;
  if (fontName?.family) rules.push(`font-family: "${fontName.family}";`);
  else if (typeof style?.fontFamily === "string") rules.push(`font-family: "${style.fontFamily}";`);
  if (fontName?.style?.toLowerCase().includes("italic")) rules.push("font-style: italic;");
  const weight =
    (fontName?.style && FONT_WEIGHT[fontName.style]) ??
    (typeof style?.fontWeight === "number" ? style.fontWeight : undefined);
  if (weight) rules.push(`font-weight: ${weight};`);
  return rules;
}

function textStyleRules(node: FigmaNode): string[] {
  const rules: string[] = [];
  const style = node.style as Record<string, unknown> | undefined;
  if (typeof style?.fontSize === "number") rules.push(`font-size: ${px(style.fontSize)};`);
  if (typeof style?.textAlignHorizontal === "string" && TEXT_ALIGN[style.textAlignHorizontal]) {
    rules.push(`text-align: ${TEXT_ALIGN[style.textAlignHorizontal]};`);
  }
  if (style?.textDecoration === "UNDERLINE") rules.push("text-decoration: underline;");
  if (style?.textDecoration === "STRIKETHROUGH") rules.push("text-decoration: line-through;");
  if (style?.textCase === "UPPER") rules.push("text-transform: uppercase;");
  if (style?.textCase === "LOWER") rules.push("text-transform: lowercase;");
  return rules;
}

function layoutRules(node: FigmaNode): string[] {
  if (node.layoutMode !== "HORIZONTAL" && node.layoutMode !== "VERTICAL") return [];
  const rules: string[] = [];
  rules.push(
    "display: flex;",
    `flex-direction: ${node.layoutMode === "HORIZONTAL" ? "row" : "column"};`,
  );
  if (typeof node.itemSpacing === "number") rules.push(`gap: ${px(node.itemSpacing)};`);
  const top = node.paddingTop;
  const right = node.paddingRight;
  const bottom = node.paddingBottom;
  const left = node.paddingLeft;
  if ([top, right, bottom, left].some((v) => typeof v === "number" && v !== 0)) {
    rules.push(
      `padding: ${px((top as number) ?? 0)} ${px((right as number) ?? 0)} ${px(
        (bottom as number) ?? 0,
      )} ${px((left as number) ?? 0)};`,
    );
  }
  if (typeof node.primaryAxisAlignItems === "string" && AXIS_ALIGN[node.primaryAxisAlignItems]) {
    rules.push(`justify-content: ${AXIS_ALIGN[node.primaryAxisAlignItems]};`);
  }
  if (typeof node.counterAxisAlignItems === "string" && AXIS_ALIGN[node.counterAxisAlignItems]) {
    rules.push(`align-items: ${AXIS_ALIGN[node.counterAxisAlignItems]};`);
  }
  return rules;
}

// ── REST read tools (32.7 "Đọc REST", auto-run) ──────────────────────────────

function restReadTools(deps: FigmaAgentToolDependencies): FigmaAgentTool[] {
  const fileKeyInput = z.string().min(1).describe("Figma file key from the file URL");
  return [
    define(deps, {
      name: "figma_list_files",
      title: "List Figma files",
      description:
        "Files added in JAgentDesk: fileKey, name, version, whether Figma Link is open for them.",
      inputSchema: {},
      async run(_input, ctx) {
        const files = await ctx.store.listFiles();
        if (files.length === 0) return "No Figma files added yet.";
        return cap(
          files
            .map(
              (f) =>
                `- ${f.fileKey}: ${f.name}${f.pinned ? " ★" : ""}${f.linked ? " [live via Figma Link]" : ""}${
                  f.lastVersion ? ` (v${f.lastVersion})` : ""
                }`,
            )
            .join("\n"),
        );
      },
    }),
    define(deps, {
      name: "figma_get_file_outline",
      title: "Get Figma file outline",
      description:
        "Pages and their top-level frames (id, name, bounds) — the map before drilling into nodes.",
      inputSchema: { fileKey: fileKeyInput },
      async run(input, ctx) {
        const file = await restGet<Record<string, unknown>>(
          ctx,
          input.fileKey,
          `/v1/files/${input.fileKey}`,
          { depth: 2 },
          "1",
        );
        const pages = (file?.document as { children?: FigmaNode[] } | undefined)?.children ?? [];
        const lines: string[] = [`# ${file?.name ?? input.fileKey} (v${file?.version ?? "?"})`];
        for (const page of pages) {
          lines.push(`\n## ${page.name} (${page.id})`);
          for (const frame of page.children ?? []) {
            const b = frame.absoluteBoundingBox as
              | { x?: number; y?: number; width?: number; height?: number }
              | undefined;
            lines.push(
              `- ${frame.name} [${frame.id}] ${b?.width !== undefined ? `${Math.round(b.width)}×${Math.round(b.height!)} @${Math.round(b.x!)},${Math.round(b.y!)}` : ""}`,
            );
          }
        }
        return cap(lines.join("\n"));
      },
    }),
    define(deps, {
      name: "figma_get_nodes",
      title: "Get Figma nodes",
      description:
        "Node subtrees by id (geometry trimmed) — use figma_inspect_css for the CSS of a node.",
      inputSchema: {
        fileKey: fileKeyInput,
        ids: z.array(z.string()).min(1).max(20).describe("Node ids like '4029:12345'"),
      },
      async run(input, ctx) {
        const json = await restGet<{ nodes?: Record<string, { document?: FigmaNode } | null> }>(
          ctx,
          input.fileKey,
          `/v1/files/${input.fileKey}/nodes`,
          { ids: input.ids.join(",") },
          "1",
        );
        return cap(
          input.ids
            .map((id) => {
              const document = json?.nodes?.[id]?.document;
              return document
                ? `## ${id} ${document.name}\n${JSON.stringify(document, keyDrop())}`
                : `## ${id}\n(missing)`;
            })
            .join("\n\n"),
        );
      },
    }),
    define(deps, {
      name: "figma_render_nodes",
      title: "Render Figma nodes",
      description:
        "Rasterize nodes to PNG/JPG images (up to 10 per call) — the result carries image content.",
      inputSchema: {
        fileKey: fileKeyInput,
        ids: z.array(z.string()).min(1).max(10),
        scale: z.number().min(0.1).max(4).optional(),
        format: z.enum(["png", "jpg"]).optional(),
      },
      async run(input, ctx) {
        const connectionId = await connectionForFile(ctx, input.fileKey);
        const json = await ctx.rest.getJson<{
          err?: string | null;
          images?: Record<string, string>;
        }>({
          connectionId,
          path: `/v1/images/${input.fileKey}`,
          query: {
            ids: input.ids.join(","),
            scale: input.scale ?? 2,
            format: input.format ?? "png",
          },
          tier: "1",
        });
        if (json.err) throw new ToolFailure(`Figma render failed: ${json.err}`);
        const entries = Object.entries(json.images ?? {});
        const lines: string[] = [];
        const images: { data: string; mimeType: string }[] = [];
        for (const [id, url] of entries) {
          if (!url) {
            lines.push(`- ${id}: no render`);
            continue;
          }
          const bytes = await ctx.rest.getBytes(url);
          if (bytes.data.length > FIGMA_TOOL_IMAGE_MAX_BYTES) {
            lines.push(
              `- ${id}: ${bytes.mimeType}, ${(bytes.data.length / 1024 / 1024).toFixed(1)} MB (too large to attach)`,
            );
            continue;
          }
          lines.push(`- ${id}: attached below`);
          images.push({ data: bytes.data.toString("base64"), mimeType: bytes.mimeType });
        }
        return { text: lines.join("\n") || "(nothing rendered)", images };
      },
    }),
    define(deps, {
      name: "figma_get_comments",
      title: "Get Figma comments",
      description: "Review comments of a file, newest first (id, author, message, node, resolved).",
      inputSchema: { fileKey: fileKeyInput },
      async run(input, ctx) {
        const json = await restGet<{ comments?: Record<string, unknown>[] }>(
          ctx,
          input.fileKey,
          `/v1/files/${input.fileKey}/comments`,
          {},
          "2",
        );
        const comments = json?.comments ?? [];
        if (comments.length === 0) return "(no comments)";
        return cap(
          comments
            .slice(0, 100)
            .map((c) => {
              const user = (c.user as { handle?: string } | undefined)?.handle ?? "?";
              const node = c.node_id ? ` on ${c.node_id}` : "";
              const resolved = c.resolved_at ? " [resolved]" : "";
              return `- ${c.id} ${user}${node}${resolved}: ${String(c.message).replace(/\s+/g, " ").slice(0, 300)}`;
            })
            .join("\n"),
        );
      },
    }),
    define(deps, {
      name: "figma_get_versions",
      title: "Get Figma versions",
      description: "Named versions of a file, newest first (id, label, author, date).",
      inputSchema: { fileKey: fileKeyInput },
      async run(input, ctx) {
        const json = await restGet<{ versions?: Record<string, unknown>[] }>(
          ctx,
          input.fileKey,
          `/v1/files/${input.fileKey}/versions`,
          { page_size: 30 },
          "2",
        );
        const versions = json?.versions ?? [];
        if (versions.length === 0) return "(no versions)";
        return cap(
          versions
            .map((v) => {
              const author = (v.author as { handle?: string } | undefined)?.handle ?? "?";
              return `- ${v.id} ${v.label ?? "(unlabelled)"} by ${author} ${String(v.created_at ?? "").slice(0, 10)}`;
            })
            .join("\n"),
        );
      },
    }),
    define(deps, {
      name: "figma_get_components",
      title: "Get Figma components",
      description:
        "Published components of a file: key and name — feed keys to create_instance/swap.",
      inputSchema: { fileKey: fileKeyInput },
      async run(input, ctx) {
        const json = await restGet<{ meta?: { components?: Record<string, unknown>[] } }>(
          ctx,
          input.fileKey,
          `/v1/files/${input.fileKey}/components`,
          {},
          "3",
        );
        const list = json?.meta?.components ?? [];
        return cap(
          list
            .map(
              (c) =>
                `- ${c.key}: ${c.name}${c.description ? ` — ${String(c.description).slice(0, 120)}` : ""}`,
            )
            .join("\n") || "(none)",
        );
      },
    }),
    define(deps, {
      name: "figma_get_styles",
      title: "Get Figma styles",
      description: "Local styles of a file: id, type and name — feed ids to apply_style.",
      inputSchema: { fileKey: fileKeyInput },
      async run(input, ctx) {
        const json = await restGet<{ meta?: { styles?: Record<string, unknown>[] } }>(
          ctx,
          input.fileKey,
          `/v1/files/${input.fileKey}/styles`,
          {},
          "3",
        );
        const list = json?.meta?.styles ?? [];
        return cap(
          list.map((s) => `- ${s.styleId ?? s.key} (${s.styleType}): ${s.name}`).join("\n") ||
            "(none)",
        );
      },
    }),
    define(deps, {
      name: "figma_inspect_css",
      title: "Inspect Figma node as CSS",
      description:
        "CSS computed from the node's properties: fills, strokes, radius, effects, text styles and auto-layout.",
      inputSchema: {
        fileKey: fileKeyInput,
        ids: z.array(z.string()).min(1).max(10),
      },
      async run(input, ctx) {
        const json = await restGet<{ nodes?: Record<string, { document?: FigmaNode } | null> }>(
          ctx,
          input.fileKey,
          `/v1/files/${input.fileKey}/nodes`,
          { ids: input.ids.join(",") },
          "1",
        );
        return cap(
          input.ids
            .map((id) => {
              const document = json?.nodes?.[id]?.document;
              return document ? figmaNodeToCss(document) : `/* ${id}: not found */`;
            })
            .join("\n\n"),
        );
      },
    }),
    define(deps, {
      name: "figma_get_prototype",
      title: "Get Figma prototype",
      description:
        "Prototype reactions (trigger → action) and flow starting points for a node subtree.",
      inputSchema: {
        fileKey: fileKeyInput,
        ids: z
          .array(z.string())
          .min(1)
          .max(20)
          .optional()
          .describe("Screens to scan; omit to scan all top-level frames of the file"),
      },
      async run(input, ctx) {
        const lines: string[] = [];
        const collect = (node: FigmaNode) => {
          const reactions = node.reactions;
          if (Array.isArray(reactions) && reactions.length > 0) {
            for (const r of reactions as Record<string, unknown>[]) {
              lines.push(
                `- ${node.id} ${node.name}: ${compact(r.trigger ?? {})} → ${compact(r.action ?? {})}`,
              );
            }
          }
          if (Array.isArray(node.flowStartPoints)) {
            for (const f of node.flowStartPoints as { name?: string }[]) {
              lines.push(`- flow start: ${node.id} "${f?.name ?? node.name}"`);
            }
          }
          for (const child of node.children ?? []) collect(child);
        };
        if (input.ids) {
          const json = await restGet<{
            nodes?: Record<string, { document?: FigmaNode } | null>;
          }>(
            ctx,
            input.fileKey,
            `/v1/files/${input.fileKey}/nodes`,
            { ids: input.ids.join(",") },
            "1",
          );
          for (const id of input.ids) {
            const document = json?.nodes?.[id]?.document;
            if (document) collect(document);
          }
        } else {
          const file = await restGet<{ document?: FigmaNode }>(
            ctx,
            input.fileKey,
            `/v1/files/${input.fileKey}`,
            {},
            "1",
          );
          for (const page of file?.document?.children ?? []) collect(page);
        }
        return cap(lines.join("\n") || "(no prototype interactions found)");
      },
    }),
  ];
}

function keyDrop(): (key: string, value: unknown) => unknown {
  return (key, value) => (HEAVY_NODE_KEYS.has(key) ? undefined : value);
}

// ── Figma Link tools: every Forge tool as figma_link_<tool> (32.7) ───────────

function linkTools(deps: FigmaAgentToolDependencies): FigmaAgentTool[] {
  const inputSchema = {
    fileKey: z.string().min(1).describe("File key of a file open in the Figma Link plugin"),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Arguments for the Forge tool (same names it takes in figma-mcp-forge)"),
  };
  const tools: FigmaAgentTool[] = [];
  for (const spec of FIGMA_FORGE_TOOLS) {
    const name = `figma_link_${spec.name}`;
    const isRunScript = spec.name === "run_script";
    tools.push(
      define(deps, {
        name,
        title: `Figma Link: ${spec.name}`,
        description:
          `${spec.desc} Runs through the Figma Link plugin in the open file. Args: ${spec.name === "list_files" ? "none" : "pass the Forge tool's arguments in `args`"}.` +
          (spec.write ? ` ${FIGMA_SAFE_WORKFLOW}` : ""),
        inputSchema,
        permission: spec.write
          ? (input: { fileKey: string; args?: Record<string, unknown> }) => ({
              title: `${isRunScript ? "Run script" : `Edit via Figma Link (${spec.name})`} in ${input.fileKey}`,
              description: compact(input.args ?? {}),
              input: { fileKey: input.fileKey, tool: spec.name, args: input.args ?? {} },
            })
          : undefined,
        async run(input, ctx) {
          if (!ctx.link.isLinked(input.fileKey)) {
            throw new ToolFailure(
              `Figma Link is not connected for ${input.fileKey} — open the file in Figma and run the plugin.`,
            );
          }
          const result = await ctx.link.callTool(input.fileKey, spec.name, input.args ?? {});
          return compact(result);
        },
        precheck: isRunScript
          ? (_input, ctx) => {
              if (!ctx.link.status().runScriptEnabled) {
                throw new ToolFailure(
                  "figma_link_run_script is disabled — enable Run script in Figma Link settings (32.4.2).",
                );
              }
            }
          : undefined,
      }),
    );
  }
  return tools;
}

// ── queue + comment tools ────────────────────────────────────────────────────

function queueAndCommentTools(deps: FigmaAgentToolDependencies): FigmaAgentTool[] {
  return [
    define(deps, {
      name: "figma_queue_ops",
      title: "Queue Figma edits",
      description: `Queue edit operations for a file that has no Figma Link yet; they apply when the plugin connects. ${FIGMA_SAFE_WORKFLOW}`,
      inputSchema: {
        fileKey: z.string().min(1),
        ops: z.array(FigmaEditOpSchema).min(1).max(100),
      },
      permission: (input: { fileKey: string; ops: { op: string }[] }) => ({
        title: `Queue ${input.ops.length} Figma change(s) in ${input.fileKey}`,
        description: input.ops.map((o) => o.op).join(", "),
        input: { fileKey: input.fileKey, ops: input.ops },
      }),
      async run(input, ctx) {
        const created = await addPendingOps(ctx, input.fileKey, input.ops, "agent");
        const remaining = await loadPendingOps(ctx, input.fileKey);
        return `Queued ${created.length} change(s): ${created.map((c) => c.id).join(", ")}. ${remaining.length} pending total for ${input.fileKey}.`;
      },
    }),
    define(deps, {
      name: "figma_queue_list",
      title: "List queued Figma edits",
      description:
        "The edit queue of a file: op id, state, op and message. Read-only, auto-approved.",
      inputSchema: { fileKey: z.string().min(1) },
      async run(input, ctx) {
        const ops = await loadPendingOps(ctx, input.fileKey);
        if (ops.length === 0) return `No pending changes for ${input.fileKey}.`;
        return cap(
          ops
            .map(
              (o) =>
                `- ${o.id} [${o.state}] ${o.op.op} ${"nodeId" in o.op ? o.op.nodeId : ""} (${o.origin}, base v${o.baseVersion})${
                  o.message ? `: ${o.message}` : ""
                }`,
            )
            .join("\n"),
        );
      },
    }),
    define(deps, {
      name: "figma_post_comment",
      title: "Comment on a Figma file",
      description:
        "Post a review comment on a file, optionally pinned to a node position (client_meta).",
      inputSchema: {
        fileKey: z.string().min(1),
        message: z.string().min(1),
        nodeId: z.string().optional().describe("Node the comment points at"),
        x: z.number().optional(),
        y: z.number().optional(),
      },
      permission: (input: { fileKey: string; message: string; nodeId?: string }) => ({
        title: `Comment on ${input.fileKey}`,
        description: input.message.slice(0, 500),
        input: { ...input },
      }),
      async run(input, ctx) {
        const body: Record<string, unknown> = { message: input.message };
        if (input.nodeId && input.x !== undefined && input.y !== undefined) {
          body.client_meta = { node_id: input.nodeId, x: input.x, y: input.y };
        } else if (input.x !== undefined && input.y !== undefined) {
          body.client_meta = { x: input.x, y: input.y };
        }
        const comment = await restSend<Record<string, unknown>>(
          ctx,
          input.fileKey,
          "POST",
          `/v1/files/${input.fileKey}/comments`,
          body,
          "2",
        );
        return `Comment ${comment?.id ?? "?"} posted on ${input.fileKey}.`;
      },
    }),
  ];
}

// ── remote write tools (spec 32.7 / ADR-0040) ─────────────────────────────────
// Provider-independent writes through the official Figma MCP server on the Codex
// app-server transport: no chat provider/model switch, no Desktop, no plugin.
// Status and read are neutral; every execute raises the JAD permission card first.

function remoteTools(deps: FigmaAgentToolDependencies): FigmaAgentTool[] {
  return [
    define(deps, {
      name: "figma_remote_status",
      title: "Figma remote editing status",
      description:
        "State of the official Figma remote write connector: disconnected / connecting / needs_auth / connected / unavailable / error, with the account identity when readable. Neutral: never starts the helper, never opens OAuth.",
      inputSchema: {},
      async run(_input, ctx) {
        if (!ctx.remote) throw new ToolFailure("This daemon has no Figma remote write connector.");
        const status = await ctx.remote.getStatus();
        const identity = status.identityText ? ` — ${status.identityText}` : "";
        const message = status.message ? ` — ${status.message}` : "";
        return `Figma remote editing: ${status.state}${message}${identity}`;
      },
    }),
    define(deps, {
      name: "figma_remote_read",
      title: "Read Figma metadata (remote)",
      description:
        "Read file/frame/node metadata through the official Figma remote MCP server (get_metadata). Use after a remote write to verify the affected node IDs and properties before claiming the task done.",
      inputSchema: {
        fileKey: z.string().min(1),
        nodeId: z.string().min(1).optional().describe("Optional node id to scope the read"),
      },
      async run(input, ctx) {
        const result = await readRemoteMetadata(ctx, input.fileKey, input.nodeId);
        return compact(result);
      },
    }),
    define(deps, {
      name: "figma_remote_execute",
      title: "Edit Figma remotely (use_figma)",
      description: `Apply Figma Plugin-API code through the official Figma remote MCP server (use_figma skill figma-use). Edits the original file from chat without Figma Desktop or the Link plugin, and never switches the chat provider or model. ${FIGMA_SAFE_WORKFLOW}`,
      inputSchema: {
        fileKey: z.string().min(1).describe("File key of a file added to JAgentDesk"),
        code: z
          .string()
          .min(1)
          .describe(`Plugin API code, at most ${FIGMA_REMOTE_MAX_CODE_BYTES} UTF-8 bytes`),
        description: z
          .string()
          .min(1)
          .max(1000)
          .describe("Short human-readable summary of the edit (shown on the permission card)"),
      },
      precheck: (input) => {
        const bytes = Buffer.byteLength(input.code, "utf8");
        if (bytes > FIGMA_REMOTE_MAX_CODE_BYTES)
          throw new ToolFailure(
            `use_figma code is ${bytes} UTF-8 bytes — the limit is ${FIGMA_REMOTE_MAX_CODE_BYTES}.`,
          );
      },
      permission: (input: { fileKey: string; code: string; description: string }) => ({
        title: `Edit ${input.fileKey} with Figma use_figma`,
        description: `${input.description}\n\n${input.code.slice(0, 2000)}`,
        input: { fileKey: input.fileKey, description: input.description, code: input.code },
      }),
      async run(input, ctx) {
        const outcome = await executeRemoteWrite(ctx, {
          fileKey: input.fileKey,
          code: input.code,
          description: input.description,
        });
        const reply = compact(outcome.result);
        if (outcome.result.isError) return `${reply}\nThe remote tool reported an error.`;
        return outcome.readbackAvailable
          ? `${reply}\nMetadata readback verified. Re-read the affected node IDs/props with figma_remote_read before claiming the change is what the user asked for.`
          : `${reply}\nTool replied but the metadata readback failed — outcome UNVERIFIED; do not claim success until verified by a read.`;
      },
    }),
  ];
}

export function createFigmaAgentTools(deps: FigmaAgentToolDependencies): FigmaAgentTool[] {
  return [
    ...restReadTools(deps),
    ...linkTools(deps),
    ...queueAndCommentTools(deps),
    ...remoteTools(deps),
  ];
}

/** Names that must run without a permission card (spec 32.7's auto-run groups). */
export const FIGMA_READ_TOOL_NAMES: readonly string[] = [
  ...restReadTools({
    service: null as never,
    callerAgentId: null,
    requestPermission: async () => ({ behavior: "allow" as const }),
  }).map((t) => t.name),
  ...FIGMA_FORGE_TOOLS.filter((t) => !t.write).map((t) => `figma_link_${t.name}`),
  "figma_queue_list",
  "figma_remote_status",
  "figma_remote_read",
];
