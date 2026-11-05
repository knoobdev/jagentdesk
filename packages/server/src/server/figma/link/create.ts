import type pino from "pino";
import type { SecretStore } from "../../database/secret-store.js";
import { FigmaLinkServer } from "./bridge.js";

/**
 * Construct the Figma Link bridge and bind the loopback port (spec 32.4).
 * A port collision (another dev's daemon already holds 1995) is surfaced in
 * `status().server === "port_in_use"` instead of throwing — the rest of the
 * Figma service works over REST without the link.
 */
export async function createFigmaLinkBridge(options: {
  secrets: SecretStore;
  jagentdeskHome: string;
  logger: pino.Logger;
}): Promise<FigmaLinkServer> {
  const link = new FigmaLinkServer({
    secrets: options.secrets,
    dataDir: options.jagentdeskHome,
    logger: options.logger,
  });
  const started = await link.start();
  if (!started.ok) {
    options.logger.warn({ port: started.error }, "figma link could not bind the loopback port");
  }
  return link;
}
