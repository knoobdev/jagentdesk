import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PluginIdSchema } from "@jagentdesk/protocol/messages";
import { resolveCliVersion } from "../../version.js";

const OVERVIEW = `<!--
OVERVIEW.md is required to list your plugin in the registry. Keep it beside
jagentdesk-plugin.json in your repository at the pinned commit and in your npm package.
Replace this comment with useful facts before publishing.

This overview is for people choosing a plugin in JAgentDesk, on the plugin page under
its install command. README assumes a GitHub audience and includes technical
details, installation instructions, and badges. Long, AI-generated READMEs leave
people reading past that material to understand what the plugin does.

Write these parts in order, including only what helps someone decide to install:

1. Describe what your plugin is and does in plain terms first.
2. Explain how it works only when it is not obvious.
3. Explain setup when needed: settings, accounts, tokens, providers, tools, or
   other plugins. Include applicable daemon version and operating system
   requirements. Setup guidance is allowed; installation instructions are not.
4. Explain capabilities and settings worth understanding, what each option does,
   what the plugin reads or sends and where, permissions, and known limits.

Length follows complexity; a theme needs one paragraph. Choose headings only
when they help. Use sentence case and plain factual language, with no em dashes.
Omit installation commands, badges, changelog, contributing or license sections,
marketing, and unsupported claims. Avoid implementation filler such as empty
cleanup functions, theme-token field lists, or lists of absent features.

To translate the overview, add a whole copy beside this file named for the
language, such as OVERVIEW.zh-CN.md. Readers in that language see it instead.
-->
`;

const TSCONFIG = {
  compilerOptions: {
    target: "ES2020",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: ["ES2023", "DOM"],
    jsx: "react-jsx",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
  },
  include: ["**/*.ts", "**/*.tsx"],
};

const ENTRY = `import type { PluginContext } from "@jagentdesk/plugin";
import { MainSurface } from "./main.client";

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", MainSurface);
  return () => {};
}
`;

const CLIENT_SURFACE = `import type { PluginSurfaceProps } from "@jagentdesk/plugin";
import React, { useMemo } from "react";
import { Text, View } from "react-native";

export function MainSurface({ theme, layout }: PluginSurfaceProps) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      text: { color: theme.colors.foreground },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.text}>Hello from my plugin</Text>
    </View>
  );
}
`;

export interface PluginScaffold {
  id: string;
  directory: string;
}

export async function scaffoldPluginDirectory(
  targetDirectory: string,
  requestedId?: string,
): Promise<PluginScaffold> {
  const directory = path.resolve(targetDirectory);
  const id = PluginIdSchema.parse(requestedId ?? path.basename(directory));
  await mkdir(directory, { recursive: true });
  const existing = await readdir(directory);
  if (existing.length > 0) {
    throw new Error(`Plugin directory must be empty: ${directory}`);
  }

  const packageJson = {
    name: id,
    private: true,
    version: "0.0.0",
    // Publishing an npm plugin package ships only what the host loads.
    files: [
      "jagentdesk-plugin.json",
      "OVERVIEW.md",
      "OVERVIEW.*.md",
      "index.ts",
      "main.client.tsx",
    ],
    scripts: { typecheck: "tsc --noEmit" },
    devDependencies: {
      "@jagentdesk/plugin": resolveCliVersion(),
      "@tanstack/react-query": "^5.90.11",
      "@types/react": "~19.2.0",
      react: "19.1.0",
      "react-native": "0.81.5",
      typescript: "^5.9.3",
      zod: "^4.4.3",
    },
  };
  const files = new Map<string, string>([
    [
      "jagentdesk-plugin.json",
      `${JSON.stringify(
        {
          id,
          $comment:
            'Add "name": "My plugin" to set a display name. Add "icon": "assets/icon.png" for a PNG inside the package. Add image or video paths (relative to this manifest) or HTTPS URLs to media. Include local assets in package.json files.',
          media: [],
        },
        null,
        2,
      )}\n`,
    ],
    ["OVERVIEW.md", OVERVIEW],
    ["package.json", `${JSON.stringify(packageJson, null, 2)}\n`],
    ["tsconfig.json", `${JSON.stringify(TSCONFIG, null, 2)}\n`],
    ["index.ts", ENTRY],
    ["main.client.tsx", CLIENT_SURFACE],
  ]);
  await Promise.all(
    [...files].map(([filename, contents]) =>
      writeFile(path.join(directory, filename), contents, { flag: "wx" }),
    ),
  );
  return { id, directory };
}
