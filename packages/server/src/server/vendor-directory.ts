import { fileURLToPath } from "node:url";
import path from "node:path";

// Source: src/server → ../../vendor; build: dist/server/server → ../vendor. Built-in features
// compile elsewhere, so they locate the daemon's vendored assets through this module.
const VENDOR_ROOTS = ["../../vendor", "../vendor"];

/** Candidate directories for a vendored asset, in lookup order. */
export function vendorDirectoryCandidates(name: string): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return VENDOR_ROOTS.map((root) => path.resolve(here, root, name));
}
