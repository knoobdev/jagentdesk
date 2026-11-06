import type { FigmaNode, FigmaPrototype } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError } from "../context.js";
import { normalizePrototypeFile } from "../prototype.js";
import { contentHandlers } from "./content.js";
import type { FigmaHandlerMap } from "./types.js";

// Scoped playback (32.5.3, ADR-0037). The client already owns the outline, its version, and
// the flow starting points the page nodes carry, so playback reads ONLY the requested frame
// subtrees through the (fileKey, version, id) node cache the canvas fills: a revisit never
// re-hits REST, and supplying the version costs no Tier-3 meta and no whole-document GET
// (even depth=2) — an outline cache miss would add a request and its Link path prefers the
// live plugin document, which can mix live flow metadata into a historical read.
//
// `request.version` is always a pinned snapshot. Overlay settings exist only on the Plugin API
// (figma-integration.md §5.2) and answer for whatever version is open in Figma right now;
// isLinked alone does not prove they match the snapshot, so they are not merged here: the
// player gets overlays [] / overlaySettingsAvailable false. The live `figma.file.prototype`
// RPC (handlers/comments.ts) retains Link overlay semantics for the current document.

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

    // Shared cache with the canvas (ADR-0037): a replay of the same version reads the frame
    // subtrees from disk, and ids Figma answered `null` for are never asked again (32.8).
    // Batching is the nodes handler's job.
    const loaded = await contentHandlers["figma.file.nodes.request"](
      {
        type: "figma.file.nodes.request",
        requestId: request.requestId,
        fileKey: request.fileKey,
        ids,
        version,
        ...(request.prepareTextOutlines ? { prepareTextOutlines: true } : {}),
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

    // Edges between the shown frames, read off the loaded subtrees alone — no full graph,
    // no overlay destinations the player did not ask for.
    const { interactions } = normalizePrototypeFile({
      document: { children: Object.values(frames) },
    });

    const prototype: FigmaPrototype = {
      flows: [], // the client's outline owns flow starting points
      interactions,
      overlays: [], // live Plugin-API metadata, unverifiable against a pinned version
      overlaySettingsAvailable: false,
    };
    return { frames, prototype };
  },
};
