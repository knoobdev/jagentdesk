import path from "node:path";
import type pino from "pino";
import { FileSecretStore } from "../database/secret-store.js";
import { FigmaService } from "./service.js";
import { createFigmaLinkBridge } from "./link/create.js";
import {
  unavailableCache,
  unavailableRest,
  unavailableStore,
  unavailableTokens,
} from "./unavailable.js";

// Builds the daemon's Figma service (spec 32). Each work package swaps ONE placeholder below for
// its real part (store W3, tokens W2, rest W3, cache W4, link W6) — change only your own line.
export async function createFigmaService(options: {
  jagentdeskHome: string;
  logger: pino.Logger;
}): Promise<FigmaService> {
  const dir = path.join(options.jagentdeskHome, "figma");
  const secrets = new FileSecretStore(dir);
  const link = await createFigmaLinkBridge({
    secrets,
    jagentdeskHome: options.jagentdeskHome,
    logger: options.logger,
  });
  const service = new FigmaService({
    jagentdeskHome: options.jagentdeskHome,
    logger: options.logger,
    secrets,
    parts: {
      store: unavailableStore,
      tokens: unavailableTokens,
      rest: unavailableRest,
      cache: unavailableCache,
      link,
    },
  });
  // Every bridge transition (hello, pair, revoke, plugin_status, disconnect) republishes status.
  link.attachPush((status) => service.ctx.push({ type: "figma.link.changed", status }));
  return service;
}
