import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";

// ADR-0055 removed the Figma feature. Its encrypted credentials (the FileSecretStore key and
// sealed secrets) and its render cache sat under $JAGENTDESK_HOME/figma with nothing left to read
// them, so the daemon deletes them at start. Saved connections, pinned files and team lists stay
// on disk: the ADR keeps user data. Remove this module after 2027-05-25.
const RETIRED_ENTRIES = ["secret.key", "secrets.json", "cache"] as const;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Deletes stored Figma credentials and the Figma cache. Returns whether anything was removed. */
export async function removeRetiredFigmaData(options: {
  jagentdeskHome: string;
  logger: Pick<pino.Logger, "info" | "warn">;
}): Promise<boolean> {
  const dir = path.join(options.jagentdeskHome, "figma");
  let removed = false;
  try {
    for (const name of RETIRED_ENTRIES) {
      const target = path.join(dir, name);
      if (!(await exists(target))) continue;
      // lstat + rm without following links: a symlinked entry loses only the link.
      await fs.rm(target, { recursive: true, force: true });
      removed = true;
    }
  } catch (error) {
    // Never block daemon start on this cleanup; the next start retries.
    options.logger.warn(
      { code: (error as NodeJS.ErrnoException).code },
      "Could not remove stored Figma credentials (feature removed, ADR-0055)",
    );
    return removed;
  }
  if (removed) {
    options.logger.info("Removed stored Figma credentials and cache (feature removed, ADR-0055)");
  }
  return removed;
}
