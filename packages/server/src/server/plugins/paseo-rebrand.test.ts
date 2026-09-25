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

    // The split entry keeps its name (the runtime loads index.client.* / index.server.*);
    // only the SDK scope changes, every subpath is preserved.
    const source = await readFile(path.join(directory, "index.client.ts"), "utf8");
    expect(source).toContain('from "@jagentdesk/plugin/client"');
    expect(source).toContain('from "@jagentdesk/plugin/client/react-native"');
    expect(source).toContain('from "@jagentdesk/plugin/client/ui"');
    expect(source).toContain('from "@jagentdesk/plugin/server"');
    expect(source).toContain('from "@jagentdesk/plugin/server/provider"');
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

    expect(await readFile(path.join(directory, "index.client.tsx"), "utf8")).toContain(
      '"@jagentdesk/plugin"',
    );
    // A vendored dependency is left untouched.
    expect(
      await readFile(path.join(directory, "node_modules", "dep", "index.js"), "utf8"),
    ).toContain("@getpaseo/plugin");
  });

  it("keeps split client and server entries in place", async () => {
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "monitor" }));
    await writeFile(
      path.join(directory, "index.client.tsx"),
      'import type { PluginClientContext } from "@getpaseo/plugin/client";\nexport default function contribute(c: PluginClientContext) { return () => {}; }\n',
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      'import type { PluginServerContext } from "@getpaseo/plugin/server";\nexport default function contribute(s: PluginServerContext) { return () => {}; }\n',
    );

    await rebrandPaseoPlugin(directory);

    // Renaming the client entry to index.tsx used to make the runtime evaluate client code on
    // the server ("client.addSettingsScreen is not a function") and skip index.server.ts.
    await expect(stat(path.join(directory, "index.tsx"))).rejects.toThrow();
    expect(await readFile(path.join(directory, "index.client.tsx"), "utf8")).toContain(
      '"@jagentdesk/plugin/client"',
    );
    expect(await readFile(path.join(directory, "index.server.ts"), "utf8")).toContain(
      '"@jagentdesk/plugin/server"',
    );
  });

  it("renames the SDK's branded runtime exports in files that import the SDK", async () => {
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "monitor" }));
    await writeFile(
      path.join(directory, "index.client.tsx"),
      [
        'import { usePaseo, getPaseoClient } from "@getpaseo/plugin/client";',
        "const usePaseoLocalHelper = 1;",
        'export default function contribute() { usePaseo(); getPaseoClient("s"); return () => usePaseoLocalHelper; }',
      ].join("\n"),
    );
    await writeFile(path.join(directory, "notes.ts"), "export const usePaseo = 1;\n");

    await rebrandPaseoPlugin(directory);

    const entry = await readFile(path.join(directory, "index.client.tsx"), "utf8");
    expect(entry).toContain("import { useJAgentDesk, getJAgentDeskClient }");
    expect(entry).toContain("useJAgentDesk();");
    // A plugin's own identifier that merely starts with the name is left alone.
    expect(entry).toContain("usePaseoLocalHelper");
    // A file that does not import the SDK keeps its own names.
    expect(await readFile(path.join(directory, "notes.ts"), "utf8")).toContain("usePaseo = 1");
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
