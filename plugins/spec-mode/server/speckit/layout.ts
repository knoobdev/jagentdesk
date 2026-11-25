import { createHash } from "node:crypto";
import {
  pythonJsonDump,
  pythonUtcIsoformat,
  renderMarkdownCommand,
  renderSkill,
  resolveCommandRefs,
  resolveDynamicCommandRefs,
  sortKeys,
  type InvocationPrefix,
  type InvokeSeparator,
  type SkillFlavor,
} from "./render.js";
import {
  SPECKIT_COMMANDS,
  SPECKIT_PAGE_TEMPLATES,
  SPECKIT_SCRIPT_DIRS,
  SPECKIT_SCRIPT_FILES,
  SPECKIT_VERSION,
  SPECKIT_WORKFLOW,
  type SpecKitCommand,
  type SpecKitScriptVariant,
  type SpecKitSources,
} from "./vendor.js";

/**
 * Where and how spec-kit commands are installed per provider (spec 28.1, inventory §6).
 * Providers without a command directory (generic ACP) get the rendered command as a visible
 * prompt instead (ADR-0030 decision 3), so they map to `prompt`.
 */
export type SpecKitIntegration =
  | {
      kind: "skills";
      key: "claude" | "codex" | "copilot";
      dir: string;
      flavor: SkillFlavor;
      disableModelInvocation: boolean;
    }
  | { kind: "markdown"; key: "opencode" | "pi" | "omp"; dir: string }
  | { kind: "prompt" };

const INTEGRATIONS: Record<string, SpecKitIntegration> = {
  claude: {
    kind: "skills",
    key: "claude",
    dir: ".claude/skills",
    flavor: "claude",
    disableModelInvocation: true,
  },
  codex: {
    kind: "skills",
    key: "codex",
    dir: ".agents/skills",
    flavor: "plain",
    disableModelInvocation: false,
  },
  copilot: {
    kind: "skills",
    key: "copilot",
    dir: ".github/skills",
    flavor: "copilot",
    disableModelInvocation: true,
  },
  opencode: { kind: "markdown", key: "opencode", dir: ".opencode/commands" },
  pi: { kind: "markdown", key: "pi", dir: ".pi/prompts" },
  omp: { kind: "markdown", key: "omp", dir: ".omp/commands" },
};

/** Base provider id (`AgentManager.getBaseProviderId`) → spec-kit integration. */
export function specKitIntegrationFor(baseProvider: string): SpecKitIntegration {
  return INTEGRATIONS[baseProvider] ?? { kind: "prompt" };
}

export function integrationSeparator(integration: SpecKitIntegration): InvokeSeparator {
  return integration.kind === "skills" ? "-" : ".";
}

export function integrationPrefix(integration: SpecKitIntegration): InvocationPrefix {
  return integration.kind === "skills" && integration.key === "codex" ? "$" : "/";
}

/** What the agent types to run a command: `/speckit-plan`, `$speckit-plan`, `/speckit.plan`. */
export function commandInvocation(
  integration: SpecKitIntegration,
  command: SpecKitCommand,
): string {
  return `${integrationPrefix(integration)}speckit${integrationSeparator(integration)}${command}`;
}

/** Project-relative path of a command file for an integration with a command directory. */
export function commandFilePath(
  integration: Exclude<SpecKitIntegration, { kind: "prompt" }>,
  command: SpecKitCommand,
): string {
  return integration.kind === "skills"
    ? `${integration.dir}/speckit-${command}/SKILL.md`
    : `${integration.dir}/speckit.${command}.md`;
}

export interface PlannedFile {
  /** Project-relative POSIX path. */
  path: string;
  content: string;
  mode: number;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Every command file of an integration, in spec-kit's template order. */
export function planCommandFiles(params: {
  sources: SpecKitSources;
  integration: Exclude<SpecKitIntegration, { kind: "prompt" }>;
  script: SpecKitScriptVariant;
}): PlannedFile[] {
  const { sources, integration, script } = params;
  return SPECKIT_COMMANDS.map((command) => {
    const raw = sources.commands[command];
    const content =
      integration.kind === "skills"
        ? renderSkill({
            agentKey: integration.key,
            command,
            raw,
            script,
            flavor: integration.flavor,
            disableModelInvocation: integration.disableModelInvocation,
          })
        : renderMarkdownCommand({ agentKey: integration.key, raw, script });
    return { path: commandFilePath(integration, command), content, mode: 0o644 };
  });
}

/** `shared_infra.SPECIFY_GITIGNORE_CONTENT`. */
const SPECIFY_GITIGNORE = `# Machine-local Spec Kit state — not meant to be shared.
# Managed by the Specify CLI; safe to edit (your changes are preserved on refresh).

# Local pointer to the current feature directory. Rewritten every time you
# switch features, so it is per-checkout state rather than something to share.
feature.json

# Per-machine extension config overrides.
extensions/*/local-config.yml

# Executable adapter packages and their per-checkout provenance registry.
# Execution consent is stored separately in the user's local trust registry.
integrations/packages/
integrations/packages.json
`;

function manifestJson(key: string, installedAt: string, files: PlannedFile[]): string {
  const hashes = Object.fromEntries(files.map((file) => [file.path, sha256(file.content)]));
  return `${pythonJsonDump(
    { integration: key, version: SPECKIT_VERSION, installed_at: installedAt, files: hashes },
    { ensureAscii: true },
  )}\n`;
}

/** Integration settings `specify init --integration <key> [--integration-options …]` records. */
function integrationSettings(
  integration: SpecKitIntegration,
  script: SpecKitScriptVariant,
): Record<string, unknown> {
  if (integration.kind === "prompt") return {};
  const settings: Record<string, unknown> = { script };
  if (integration.kind === "skills" && integration.disableModelInvocation) {
    settings.raw_options = "--no-model-invocation";
    settings.parsed_options = { no_model_invocation: true };
  }
  settings.invoke_separator = integrationSeparator(integration);
  return { [integration.key]: settings };
}

/**
 * The files `specify init --here --integration <key> --script <variant>` 1.3.0 writes into an
 * empty project, minus native agent events (none for the core commands) — spec 28.3 step 2.
 * The generic-ACP case writes the shared `.specify/` only (no integration is installed).
 */
export function planSpecKitInit(params: {
  sources: SpecKitSources;
  integration: SpecKitIntegration;
  script: SpecKitScriptVariant;
  now: number;
  /** Command files to skip (already present, or a user-installed skill); default keeps all. */
  keepCommandFile?: (file: PlannedFile) => boolean;
}): PlannedFile[] {
  const { sources, integration, script } = params;
  const keepCommandFile = params.keepCommandFile ?? (() => true);
  const installedAt = pythonUtcIsoformat(params.now);
  const separator = integrationSeparator(integration);
  const prefix = integrationPrefix(integration);
  const files: PlannedFile[] = [];

  const commandFiles =
    integration.kind === "prompt"
      ? []
      : planCommandFiles({ sources, integration, script }).filter(keepCommandFile);
  files.push(...commandFiles);
  if (integration.kind !== "prompt") {
    files.push({
      path: `.specify/integrations/${integration.key}.manifest.json`,
      content: manifestJson(integration.key, installedAt, commandFiles),
      mode: 0o644,
    });
  }

  const integrationKey = integration.kind === "prompt" ? null : integration.key;
  files.push({
    path: ".specify/integration.json",
    content: `${pythonJsonDump(
      {
        version: SPECKIT_VERSION,
        integration_state_schema: 1,
        installed_integrations: integrationKey ? [integrationKey] : [],
        integration_settings: integrationSettings(integration, script),
        ...(integrationKey
          ? { integration: integrationKey, default_integration: integrationKey }
          : {}),
      },
      { ensureAscii: true },
    )}\n`,
    mode: 0o644,
  });

  const shared: PlannedFile[] = [];
  const scriptDir = SPECKIT_SCRIPT_DIRS[script];
  for (const name of SPECKIT_SCRIPT_FILES[script]) {
    const raw = sources.scripts[script][name] ?? "";
    const content = resolveDynamicCommandRefs(
      resolveCommandRefs(raw, separator, prefix),
      separator,
      prefix,
    );
    shared.push({
      path: `.specify/scripts/${scriptDir}/${name}`,
      content,
      mode: name.endsWith(".sh") ? 0o755 : 0o644,
    });
  }
  for (const name of SPECKIT_PAGE_TEMPLATES) {
    shared.push({
      path: `.specify/templates/${name}`,
      content: resolveCommandRefs(sources.pageTemplates[name] ?? "", separator, prefix),
      mode: 0o644,
    });
  }
  shared.push({ path: ".specify/.gitignore", content: SPECIFY_GITIGNORE, mode: 0o644 });
  files.push(...shared);
  files.push({
    path: ".specify/integrations/speckit.manifest.json",
    content: manifestJson("speckit", installedAt, shared),
    mode: 0o644,
  });

  files.push({
    path: ".specify/workflows/speckit/workflow.yml",
    content: sources.workflowYaml,
    mode: 0o644,
  });
  files.push({
    path: ".specify/workflows/workflow-registry.json",
    content: pythonJsonDump(
      {
        schema_version: "1.0",
        workflows: {
          [SPECKIT_WORKFLOW.id]: {
            name: SPECKIT_WORKFLOW.name,
            version: SPECKIT_WORKFLOW.version,
            description: SPECKIT_WORKFLOW.description,
            source: "bundled",
            installed_at: installedAt,
            updated_at: installedAt,
          },
        },
      },
      { ensureAscii: true },
    ),
    // WorkflowRegistry.save writes through mkstemp, which leaves the file owner-only.
    mode: 0o600,
  });

  const initOptions: Record<string, unknown> = {
    allow_symlinks: false,
    feature_numbering: "sequential",
    here: true,
    script,
    speckit_version: SPECKIT_VERSION,
  };
  if (integrationKey) {
    initOptions.ai = integrationKey;
    initOptions.integration = integrationKey;
  }
  if (integration.kind === "skills") initOptions.ai_skills = true;
  files.push({
    path: ".specify/init-options.json",
    content: `${pythonJsonDump(sortKeys(initOptions), { ensureAscii: false })}\n`,
    mode: 0o644,
  });

  const constitutionTemplate = shared.find(
    (file) => file.path === ".specify/templates/constitution-template.md",
  );
  const constitution = constitutionTemplate?.content ?? "";
  files.push({ path: ".specify/memory/constitution.md", content: constitution, mode: 0o644 });
  files.push({
    path: ".specify/memory/.constitution-template.json",
    content: `${pythonJsonDump({ sha256: sha256(constitution), source: "core" }, { ensureAscii: true })}\n`,
    mode: 0o644,
  });
  return files;
}
