import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPluginManifest } from "./manifest.js";
import { rebrandPaseoPlugin } from "./paseo-rebrand.js";

describe("rebrandPaseoPlugin", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "paseo-rebrand-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("renames the manifest, maps the version requirement, and rewrites the SDK scope", async () => {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "catppuccin", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.client.ts"),
      [
        'import type { PluginClientContext } from "@getpaseo/plugin/client";',
        'import { useHost } from "@getpaseo/plugin/client/react-native";',
        'import { ui } from "@getpaseo/plugin/client/ui";',
        'import { serverThing } from "@getpaseo/plugin/server";',
        'import { provide } from "@getpaseo/plugin/server/provider";',
        "export default function contribute(client: PluginClientContext) {",
        "  client.addTheme({ id: 'mocha' });",
        "  return () => {};",
        "}",
      ].join("\n"),
    );

    const rebranded = await rebrandPaseoPlugin(directory);
    expect(rebranded).toBe(true);

    await expect(stat(path.join(directory, "paseo-plugin.json"))).rejects.toThrow();
    const manifest = await readPluginManifest(directory);
    expect(manifest.id).toBe("catppuccin");
    expect(manifest.requirements).toEqual({ jagentdesk: ">=0.8.0" });

    // The client entry is renamed to the fork's index.ts and every SDK subpath is mapped
    // onto an entry point the fork actually publishes (. / ./server / ./host / ./react-native).
    const source = await readFile(path.join(directory, "index.ts"), "utf8");
    expect(source).toContain('from "@jagentdesk/plugin"'); // /client -> root
    expect(source).toContain('from "@jagentdesk/plugin/react-native"'); // /client/react-native
    expect(source).toContain('from "@jagentdesk/plugin/server"'); // /server and /server/provider
    expect(source).not.toContain("/client"); // no /client/* subpath survives
    expect(source).not.toContain("getpaseo");
  });

  it("also rewrites the older @paseo scope and skips node_modules", async () => {
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "legacy" }));
    await writeFile(
      path.join(directory, "index.client.tsx"),
      'import { thing } from "@paseo/plugin";\n',
    );
    await mkdir(path.join(directory, "node_modules", "dep"), { recursive: true });
    await writeFile(
      path.join(directory, "node_modules", "dep", "index.js"),
      'require("@getpaseo/plugin");\n',
    );

    await rebrandPaseoPlugin(directory);

    expect(await readFile(path.join(directory, "index.tsx"), "utf8")).toContain(
      '"@jagentdesk/plugin"',
    );
    // A vendored dependency is left untouched.
    expect(
      await readFile(path.join(directory, "node_modules", "dep", "index.js"), "utf8"),
    ).toContain("@getpaseo/plugin");
  });

  it("bridges a Paseo client entry to the fork's single index entry", async () => {
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "gruvbox" }));
    await writeFile(
      path.join(directory, "index.client.ts"),
      'import type { PluginClientContext } from "@getpaseo/plugin/client";\nexport default function contribute(c: PluginClientContext) { c.addTheme({ id: "g" }); return () => {}; }\n',
    );

    await rebrandPaseoPlugin(directory);

    // index.client.ts becomes index.ts (the fork's entry) with the SDK scope rewritten.
    await expect(stat(path.join(directory, "index.client.ts"))).rejects.toThrow();
    const entry = await readFile(path.join(directory, "index.ts"), "utf8");
    expect(entry).toContain('from "@jagentdesk/plugin"');
    expect(entry).toContain("export default function contribute");
  });

  it("leaves a plugin that already targets JAgentDesk alone", async () => {
    await writeFile(
      path.join(directory, "jagentdesk-plugin.json"),
      JSON.stringify({ id: "native" }),
    );
    const source = 'import { x } from "@jagentdesk/plugin";\n';
    await writeFile(path.join(directory, "index.ts"), source);

    expect(await rebrandPaseoPlugin(directory)).toBe(false);
    expect(await readFile(path.join(directory, "index.ts"), "utf8")).toBe(source);
  });
});
