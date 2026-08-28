import type { FirstAgentContext } from "@jagentdesk/protocol/messages";
import type { AgentManager } from "./agent/agent-manager.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import { buildAgentBranchNameSeed } from "./agent/prompt-attachments.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";

interface BranchNameGeneratorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

/**
 * Options are kept broad for call-site compatibility, but the title/branch are
 * now derived by a deterministic ALGORITHM from the first-agent prompt — no LLM
 * call. The old implementation ran a separate small-model structured-generation
 * pass (default `haiku`) in its own agent process just to name the workspace,
 * which spun up a second provider CLI (and, via the user's ~/.claude.json, a
 * second serena MCP) and billed hidden tokens on every new agent. Naming does
 * not need a model.
 */
export interface GenerateBranchNameFromFirstAgentContextOptions {
  agentManager?: AgentManager;
  cwd: string;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  providerSnapshotManager?: Pick<ProviderSnapshotManager, "listProviders">;
  daemonConfig?: StructuredGenerationDaemonConfig | null;
  currentSelection?: {
    provider?: string | null;
    model?: string | null;
    thinkingOptionId?: string | null;
  };
  firstAgentContext: FirstAgentContext | undefined;
  logger: BranchNameGeneratorLogger;
}

export interface GeneratedWorkspaceName {
  title: string | null;
  branch: string | null;
}

const MAX_TITLE_CHARS = 80;
const MAX_BRANCH_CHARS = 60;

/** Plain source text for naming: the user prompt, else the rendered attachments. */
function namingSourceText(firstAgentContext: FirstAgentContext | undefined): string | null {
  const prompt = firstAgentContext?.prompt?.trim();
  if (prompt) {
    return prompt;
  }
  // Attachment-only context (e.g. a PR): reuse the seed builder, then strip its
  // `<user-prompt>` / `<attachments>` wrapper tags to recover plain text.
  const seed = buildAgentBranchNameSeed(firstAgentContext);
  if (!seed) {
    return null;
  }
  const stripped = seed
    .replace(/<\/?user-prompt>/g, "")
    .replace(/<\/?attachments>/g, "")
    .trim();
  return stripped || null;
}

/** First non-empty line, whitespace-collapsed, with a leading slash-command marker removed. */
function firstMeaningfulLine(source: string): string {
  const line = source.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? source;
  return line.replace(/^\/+/, "").replace(/\s+/g, " ").trim();
}

/** Truncate on a word boundary when possible, never exceeding `max`. */
function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * A valid git ref slug: strip diacritics (so Vietnamese prompts still slug),
 * lowercase, non-alphanumerics → single hyphens, no leading/trailing hyphen.
 */
function slugifyGitBranch(source: string): string {
  return (
    source
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // đ/Đ is a distinct Latin letter, not a diacritic NFKD decomposes.
      .replace(/đ/g, "d")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+/, "")
      .slice(0, MAX_BRANCH_CHARS)
      .replace(/-+$/, "")
  );
}

/** Deterministic title + branch from the first-agent context. No model call. */
export function generateBranchNameFromFirstAgentContext(
  options: GenerateBranchNameFromFirstAgentContextOptions,
): Promise<GeneratedWorkspaceName | null> {
  const source = namingSourceText(options.firstAgentContext);
  if (!source) {
    return Promise.resolve(null);
  }
  const headline = firstMeaningfulLine(source);
  if (!headline) {
    return Promise.resolve(null);
  }
  const title = truncate(headline, MAX_TITLE_CHARS);
  const branch = slugifyGitBranch(headline);
  return Promise.resolve({
    title: title || null,
    branch: branch || null,
  });
}
