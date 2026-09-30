import { parseGithubSource, type MarketplacePlugin } from "@/marketplace/catalog";

export interface MarketplaceInstallClient {
  installSourcePlugin(
    source: string,
    options?: { ref?: string; pluginPath?: string },
  ): Promise<unknown>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Install the npm release paseo.cafe security-scanned when the entry has one: it ships its
// dependencies and build output. Fall back to the Git source, which some plugins need (a
// monorepo helper that is only vendored in the repository).
export async function installMarketplacePlugin(
  client: MarketplaceInstallClient,
  plugin: Pick<MarketplacePlugin, "url" | "npm">,
): Promise<void> {
  const { source, ref, pluginPath } = parseGithubSource(plugin.url);
  const npmPackage = plugin.npm?.package;
  const npmVersion = plugin.npm?.version;
  if (!npmPackage || !npmVersion) {
    await client.installSourcePlugin(source, { ref, pluginPath });
    return;
  }
  try {
    await client.installSourcePlugin(`npm:${npmPackage}@${npmVersion}`, {});
  } catch (npmError) {
    try {
      await client.installSourcePlugin(source, { ref, pluginPath });
    } catch (gitError) {
      throw new Error(`npm: ${message(npmError)}\nGit: ${message(gitError)}`, {
        cause: gitError,
      });
    }
  }
}
