import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveBuiltinPluginsRoot } from "./index.js";

const resources = path.join(path.sep, "Applications", "JAgentDesk.app", "Contents", "Resources");
const serverDist = ["node_modules", "@jagentdesk", "server", "dist", "server"];
const moduleUrl = pathToFileURL(
  path.join(resources, "app.asar", ...serverDist, "server", "plugins", "builtin", "index.js"),
);
const packedRoot = path.join(resources, "app.asar", ...serverDist, "builtin-plugins");
const unpackedRoot = path.join(resources, "app.asar.unpacked", ...serverDist, "builtin-plugins");

describe("resolveBuiltinPluginsRoot", () => {
  it("hands esbuild the unpacked plugin sources inside the desktop package", () => {
    const existing = new Set([packedRoot, unpackedRoot]);
    expect(resolveBuiltinPluginsRoot(moduleUrl, (file) => existing.has(file))).toBe(unpackedRoot);
  });

  it("keeps the asar path when the package has no unpacked copy", () => {
    const existing = new Set([packedRoot]);
    expect(resolveBuiltinPluginsRoot(moduleUrl, (file) => existing.has(file))).toBe(packedRoot);
  });

  it("leaves a plain checkout path alone", () => {
    const checkoutModule = pathToFileURL(
      path.join(
        path.sep,
        "repo",
        "packages",
        "server",
        "dist",
        "server",
        "server",
        "plugins",
        "builtin",
        "index.js",
      ),
    );
    const checkoutRoot = path.join(
      path.sep,
      "repo",
      "packages",
      "server",
      "dist",
      "server",
      "builtin-plugins",
    );
    expect(resolveBuiltinPluginsRoot(checkoutModule, (file) => file === checkoutRoot)).toBe(
      checkoutRoot,
    );
  });
});
