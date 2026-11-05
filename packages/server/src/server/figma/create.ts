import path from "node:path";
import type pino from "pino";
import { FileSecretStore } from "../database/secret-store.js";
import { FigmaOAuth } from "./oauth.js";
import { FigmaService } from "./service.js";
import {
  unavailableCache,
  unavailableLink,
  unavailableRest,
  unavailableStore,
} from "./unavailable.js";

// Builds the daemon's Figma service (spec 32). Each work package swaps ONE placeholder below for
// its real part (store W3, tokens W2, rest W3, cache W4, link W6) — change only your own line.
export async function createFigmaService(options: {
  jagentdeskHome: string;
  logger: pino.Logger;
}): Promise<FigmaService> {
  const dir = path.join(options.jagentdeskHome, "figma");
  const secrets = new FileSecretStore(dir);
  return new FigmaService({
    jagentdeskHome: options.jagentdeskHome,
    logger: options.logger,
    secrets,
    parts: {
      store: unavailableStore,
      tokens: new FigmaOAuth({ secrets, logger: options.logger }),
      rest: unavailableRest,
      cache: unavailableCache,
      link: unavailableLink,
    },
  });
}
