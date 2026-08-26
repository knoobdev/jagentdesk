import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compilePlugin } from "./compiler.js";
import { readPluginManifest } from "./manifest.js";

// Repo root: packages/server/src/server/plugins -> up five.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../../..");
const LOCAL_PLUGIN_DIR = path.join(REPO_ROOT, "plugin-examples", "local-plugin");

// End-to-end proof that the shipped example plugin actually compiles through the
// daemon's real esbuild + @babel/parser pipeline, and that the runtime split
// (*.client.tsx vs *.server.ts) strips opposite-runtime code as designed.
describe("local-plugin example compiles through the daemon plugin pipeline", () => {
  it("reads the rebranded jagentdesk-plugin.json manifest", async () => {
    const manifest = await readPluginManifest(LOCAL_PLUGIN_DIR);
    expect(manifest.id).toBe("local-example");
  });

  it("compiles to client + server bundles with the runtime split applied", async () => {
    const { clientBundle, serverBundle } = await compilePlugin(
      path.join(LOCAL_PLUGIN_DIR, "index.ts"),
    );

    // Both bundles are produced and non-trivial.
    expect(clientBundle.length).toBeGreaterThan(0);
    expect(serverBundle.length).toBeGreaterThan(0);

    // The server-only increment handler ("plugin subprocess") lives in the server
    // bundle and is stripped from the client bundle.
    expect(serverBundle).toContain("plugin subprocess");
    expect(clientBundle).not.toContain("plugin subprocess");

    // The client-only panel ("Plugin counter") lives in the client bundle and is
    // stripped from the server bundle.
    expect(clientBundle).toContain("Plugin counter");
    expect(serverBundle).not.toContain("Plugin counter");

    // The SDK specifiers are left external (resolved by the host/subprocess), not
    // bundled — and no legacy paseo scope leaks in.
    expect(clientBundle).not.toContain("@paseo/plugin");
    expect(serverBundle).not.toContain("@paseo/plugin");
  });
});
