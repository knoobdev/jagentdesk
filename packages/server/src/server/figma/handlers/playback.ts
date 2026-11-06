import type { FigmaNode, FigmaPrototype } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError } from "../context.js";
import {
  collectOverlayDestinations,
  normalizeOverlaySettings,
  normalizePrototypeFile,
} from "../prototype.js";
import { contentHandlers } from "./content.js";
import type { FigmaHandlerMap } from "./types.js";

type Flows = FigmaPrototype["flows"];
type Overlays = FigmaPrototype["overlays"];

// Scoped playback (32.5.3, ADR-0037). The player asks for the frames it is about to show plus
// the pinned version the outline was read at, and everything here is built from that request:
// subtrees come from the (fileKey, version, id) node cache the canvas already fills, so a
// revisit never re-hits REST; interactions are normalized from the loaded subtrees alone, so
// the whole document is never fetched to discover edges inside the shown frames; flows are the
// one fact that lives on the pages, so they come from the cached outline, not the graph.
// Overlay settings are Plugin-API-only (figma-integration.md §5.2), so they are fetched per
// requested overlay destination through Link and are optional: REST playback works without it.

export const playbackHandlers: FigmaHandlerMap<"figma.file.playback.request"> = {
  "figma.file.playback.request": async (request, ctx, session) => {
    const version = request.version.trim();
    if (version === "")
      throw new FigmaServiceError(
        "invalid_input",
        "Playback needs the pinned file version — read the outline first.",
      );
    const ids = [...new Set(request.frameIds.map((id) => id.trim()).filter((id) => id !== ""))];
    if (ids.length === 0)
      throw new FigmaServiceError("invalid_input", "Playback needs at least one frame.");

    // Shared cache with the canvas: a replay of the same version reads the frame subtrees from
    // disk, and ids Figma answered `null` for are never asked again (32.8). Batching is the
    // nodes handler's job.
    const loaded = await contentHandlers["figma.file.nodes.request"](
      {
        type: "figma.file.nodes.request",
        requestId: request.requestId,
        fileKey: request.fileKey,
        ids,
        version,
      },
      ctx,
      session,
    );
    const frames: Record<string, FigmaNode> = {};
    const missing: string[] = [];
    for (const id of ids) {
      const node = loaded.nodes[id];
      if (!node) missing.push(id);
      else frames[id] = node;
    }
    if (missing.length > 0)
      throw new FigmaServiceError(
        "not_found",
        `Frame${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${
          missing.length > 1 ? "are" : "is"
        } not in this file.`,
      );

    // Edges between the shown frames, read off the loaded subtrees only.
    const { interactions } = normalizePrototypeFile({
      document: { children: Object.values(frames) },
    });

    // Flow starting points live on the pages (figma-integration.md §5.1), so the outline —
    // itself cached per (fileKey, version) — carries them. A failing outline degrades to no
    // flows: playback of the requested frames must not die on metadata it does not need.
    let flows: Flows = [];
    try {
      const { outline } = await contentHandlers["figma.file.outline.request"](
        {
          type: "figma.file.outline.request",
          requestId: request.requestId,
          fileKey: request.fileKey,
          version,
        },
        ctx,
        session,
      );
      flows = (outline?.pages ?? []).flatMap((page) =>
        page.flowStartingPoints.map((start) => ({ ...start, pageId: page.id })),
      );
    } catch (error) {
      ctx.logger.info(
        { fileKey: request.fileKey, err: error instanceof Error ? error.message : String(error) },
        "figma playback flows from outline failed, continuing without flows",
      );
    }

    // Only requested frames that are actually opened as overlays need Plugin-API settings;
    // other destinations in the file are none of this session's business. Any Link failure —
    // disconnected mid-call, plugin error — degrades exactly like the unlinked case.
    const destinations = new Set(collectOverlayDestinations(interactions));
    const overlayIds = ids.filter((id) => destinations.has(id));
    const overlays: Overlays = [];
    let overlaySettingsAvailable = false;
    if (overlayIds.length > 0 && ctx.link.isLinked(request.fileKey)) {
      try {
        for (const id of overlayIds) {
          const result = await ctx.link.callTool(request.fileKey, "get_node", { nodeId: id });
          const overlay = normalizeOverlaySettings(id, result);
          if (overlay) overlays.push(overlay);
        }
        overlaySettingsAvailable = true;
      } catch (error) {
        ctx.logger.info(
          { fileKey: request.fileKey, err: error instanceof Error ? error.message : String(error) },
          "figma playback overlay metadata via link failed, continuing without it",
        );
        overlays.length = 0;
        overlaySettingsAvailable = false;
      }
    }

    return {
      frames,
      prototype: { flows, interactions, overlays, overlaySettingsAvailable },
    };
  },
};
