import { FigmaServiceError } from "../context.js";
import type { FigmaHandlerMap } from "./types.js";

// Figma Link status, pairing, settings and edit ops (32.4, 32.6). Owner: W6.
// The bridge (../link/bridge.ts) owns every decision; these handlers stay thin
// and surface its FigmaServiceError codes (link_unavailable, link_unpaired,
// link_version_mismatch, pairing_required) through the session's error envelope.

export type LinkRequestType =
  | "figma.link.status.request"
  | "figma.link.pair.request"
  | "figma.link.revoke.request"
  | "figma.link.settings.request"
  | "figma.link.op.request";

export const linkHandlers: FigmaHandlerMap<LinkRequestType> = {
  "figma.link.status.request": async (_request, ctx) => {
    return { status: ctx.link.status() };
  },

  // Redeems a pairing code the plugin showed; returns the post-pairing status
  // so the app can drop its code prompt without a second round trip.
  "figma.link.pair.request": async (request, ctx) => {
    return { status: await ctx.link.pair(request.code) };
  },

  "figma.link.revoke.request": async (request, ctx) => {
    await ctx.link.revoke(request.pairingId);
    return {};
  },

  "figma.link.settings.request": async (request, ctx) => {
    return { status: await ctx.link.setRunScriptEnabled(request.runScriptEnabled) };
  },

  "figma.link.op.request": async (request, ctx) => {
    if (!ctx.link.isLinked(request.fileKey)) {
      throw new FigmaServiceError(
        "link_unavailable",
        `No Figma Link plugin is connected for ${request.fileKey}`,
      );
    }
    const { createdIds, results } = await ctx.link.applyOps(request.fileKey, request.ops);
    return { createdIds, results };
  },
};
