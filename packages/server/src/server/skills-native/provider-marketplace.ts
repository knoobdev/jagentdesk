import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  SkillCatalogItem,
  SkillPluginInstallResult,
  SkillScope,
} from "@jagentdesk/protocol/native-skills";

/**
 * Provider plugin marketplaces (spec 22.5 `provider-marketplace`). The daemon
 * only READS the manifests the provider CLIs already saved on this machine and
 * installs by running that provider's own CLI (ADR-0022 decision 5). Locations
 * verified on disk (2026-09-29):
 *
 * - Claude: `~/.claude/plugins/known_marketplaces.json` → each
 *   `installLocation/.claude-plugin/marketplace.json`; installed state in
 *   `~/.claude/plugins/installed_plugins.json`. Install:
 *   `claude plugin install <plugin>@<marketplace> --scope user|project`.
 * - Codex: `[marketplaces.<name>] source = "<dir>"` in `~/.codex/config.toml`
 *   → `<dir>/.agents/plugins/marketplace.json`, plus the curated clone at
 *   `~/.codex/.tmp/plugins/.agents/plugins/marketplace.json`; installed state is
 *   `[plugins."<plugin>@<marketplace>"]` in config.toml. Install:
 *   `codex plugin add <plugin>@<marketplace>`.
 *
 * Copilot and Cursor marketplaces have no verified on-disk manifest yet.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string | null },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export interface MarketplacePlugin {
  provider: "claude" | "codex";
  marketplace: string;
  name: string;
  description: string;
  category: string | null;
  installed: boolean;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function manifestPlugins(manifest: unknown): Record<string, unknown>[] {
  const plugins = asRecord(manifest)?.["plugins"];
  return Array.isArray(plugins)
    ? plugins.map(asRecord).filter((p): p is Record<string, unknown> => p !== null)
    : [];
}

// ── Claude ───────────────────────────────────────────────────────────────────
async function claudeInstalledKeys(homeDir: string): Promise<Set<string>> {
  const installed = asRecord(
    await readJson(path.join(homeDir, ".claude", "plugins", "installed_plugins.json")),
  );
  return new Set(Object.keys(asRecord(installed?.["plugins"]) ?? {}));
}

export async function listClaudeMarketplacePlugins(homeDir: string): Promise<MarketplacePlugin[]> {
  const known = asRecord(
    await readJson(path.join(homeDir, ".claude", "plugins", "known_marketplaces.json")),
  );
  if (!known) return [];
  const installed = await claudeInstalledKeys(homeDir);
  const plugins: MarketplacePlugin[] = [];
  for (const [marketplace, value] of Object.entries(known)) {
    const location = str(asRecord(value)?.["installLocation"]);
    if (!location) continue;
    const manifest = await readJson(path.join(location, ".claude-plugin", "marketplace.json"));
    for (const plugin of manifestPlugins(manifest)) {
      const name = str(plugin["name"]);
      if (!name) continue;
      plugins.push({
        provider: "claude",
        marketplace,
        name,
        description: str(plugin["description"]) ?? "",
        category: str(plugin["category"]),
        installed: installed.has(`${name}@${marketplace}`),
      });
    }
  }
  return plugins;
}

// ── Codex ────────────────────────────────────────────────────────────────────
interface CodexConfigSummary {
  marketplaceSources: Map<string, string>;
  enabledPlugins: Set<string>;
}

function unquoteToml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed.replace(/^'|'$/g, "");
}

/** Only the two table kinds this module needs; everything else is ignored. */
export function summarizeCodexConfig(toml: string): CodexConfigSummary {
  const summary: CodexConfigSummary = { marketplaceSources: new Map(), enabledPlugins: new Set() };
  let section: { kind: "marketplace" | "plugin"; name: string } | null = null;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[(marketplaces|plugins)\.(.+)\]$/.exec(line);
    if (header) {
      const kind = header[1] === "marketplaces" ? "marketplace" : "plugin";
      section = { kind, name: unquoteToml(header[2] ?? "") };
      continue;
    }
    if (line.startsWith("[")) {
      section = null;
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!section || !assignment) continue;
    const [, key, value] = assignment;
    if (section.kind === "marketplace" && key === "source") {
      summary.marketplaceSources.set(section.name, unquoteToml(value ?? ""));
    } else if (section.kind === "plugin" && key === "enabled" && value?.trim() === "true") {
      summary.enabledPlugins.add(section.name);
    }
  }
  return summary;
}

async function codexPluginDescription(
  root: string,
  plugin: Record<string, unknown>,
): Promise<string> {
  const relative = str(asRecord(plugin["source"])?.["path"]);
  if (!relative) return "";
  const pluginDir = path.resolve(root, relative);
  if (path.relative(root, pluginDir).startsWith("..")) return "";
  const manifest = asRecord(await readJson(path.join(pluginDir, ".codex-plugin", "plugin.json")));
  const iface = asRecord(manifest?.["interface"]);
  return str(manifest?.["description"]) ?? str(iface?.["shortDescription"]) ?? "";
}

async function codexMarketplaceRoots(homeDir: string, summary: CodexConfigSummary) {
  const roots = new Map<string, string>();
  for (const [name, source] of summary.marketplaceSources) {
    if (path.isAbsolute(source)) roots.set(name, source);
  }
  const curatedRoot = path.join(homeDir, ".codex", ".tmp", "plugins");
  const curated = asRecord(
    await readJson(path.join(curatedRoot, ".agents", "plugins", "marketplace.json")),
  );
  const curatedName = str(curated?.["name"]);
  if (curatedName && !roots.has(curatedName)) roots.set(curatedName, curatedRoot);
  return roots;
}

export async function listCodexMarketplacePlugins(homeDir: string): Promise<MarketplacePlugin[]> {
  let toml = "";
  try {
    toml = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
  } catch {
    // No config: only the curated clone (if any) is listed.
  }
  const summary = summarizeCodexConfig(toml);
  const plugins: MarketplacePlugin[] = [];
  for (const [marketplace, root] of await codexMarketplaceRoots(homeDir, summary)) {
    const manifest = await readJson(path.join(root, ".agents", "plugins", "marketplace.json"));
    for (const plugin of manifestPlugins(manifest)) {
      const name = str(plugin["name"]);
      if (!name) continue;
      plugins.push({
        provider: "codex",
        marketplace,
        name,
        description: await codexPluginDescription(root, plugin),
        category: str(plugin["category"]),
        installed: summary.enabledPlugins.has(`${name}@${marketplace}`),
      });
    }
  }
  return plugins;
}

// ── Install ──────────────────────────────────────────────────────────────────
export function pluginInstallCommand(
  provider: "claude" | "codex",
  selector: string,
  scope: SkillScope,
): string[] {
  if (provider === "claude") {
    return [
      "claude",
      "plugin",
      "install",
      selector,
      "--scope",
      scope === "project" ? "project" : "user",
    ];
  }
  return ["codex", "plugin", "add", selector];
}

export function pluginToCatalogItem(plugin: MarketplacePlugin): SkillCatalogItem {
  const selector = `${plugin.name}@${plugin.marketplace}`;
  return {
    itemId: selector,
    kind: "plugin",
    name: plugin.name,
    description: plugin.description,
    source: {
      kind: "provider-marketplace",
      provider: plugin.provider,
      marketplace: plugin.marketplace,
    },
    origin: plugin.marketplace,
    revision: null,
    files: [],
    hasScripts: false,
    body: null,
    provider: plugin.provider,
    category: plugin.category,
    installCommand: pluginInstallCommand(plugin.provider, selector, "global"),
    installed: plugin.installed,
    installedSkillId: null,
    invalidReason: null,
  };
}

export async function runPluginInstall(
  runner: CommandRunner,
  provider: "claude" | "codex",
  selector: string,
  scope: SkillScope,
  cwd: string | null,
): Promise<SkillPluginInstallResult> {
  const command = pluginInstallCommand(provider, selector, scope);
  const [bin, ...args] = command;
  const result = await runner(bin!, args, { cwd });
  return {
    provider,
    command,
    cwd,
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
