import type {
  JAgentDeskAgentBackgroundWorkDetail,
  JAgentDeskAgentBackgroundWorkSource,
} from "@jagentdesk/client";

/**
 * The detail's output sources as tabs and its script (ADR-0064, spec 04 §27c "Nguồn phụ").
 * A daemon without `sources` gives the provider tab alone, as before.
 */

export const PROVIDER_TAB_ID = "provider";

export interface LastRead {
  at: string;
  content: string;
  truncated: boolean;
}

export type OutputTab =
  | { id: typeof PROVIDER_TAB_ID; kind: "provider"; available: boolean }
  | {
      id: string;
      kind: "redirect";
      label: string;
      path: string | null;
      /** False until the command creates the file. */
      available: boolean;
      lastRead: LastRead | null;
    };

export interface ScriptSource {
  label: string;
  path: string | null;
  content: string;
  truncated: boolean;
  lineCount: number;
}

export interface BackgroundWorkSources {
  tabs: OutputTab[];
  /** The tab shown first: the source with the newest data. */
  defaultTabId: string;
  script: ScriptSource | null;
  /** No source has written anything yet. */
  empty: boolean;
}

export function backgroundWorkSources(
  detail: Pick<JAgentDeskAgentBackgroundWorkDetail, "outputAvailable" | "sources">,
): BackgroundWorkSources {
  const sources = detail.sources ?? [];
  const provider = sources.find((source) => source.kind === "provider");
  const redirects = sources.filter((source) => source.kind === "redirect");
  const scriptSource = sources.find((source) => source.kind === "script" && source.script);
  const tabs: OutputTab[] = [];
  // A provider without output (Codex) gets no tab beside redirect files.
  if (detail.outputAvailable || redirects.length === 0) {
    tabs.push({ id: PROVIDER_TAB_ID, kind: "provider", available: detail.outputAvailable });
  }
  for (const source of redirects) {
    tabs.push({
      id: source.id,
      kind: "redirect",
      label: source.label,
      path: source.path ?? null,
      available: source.available === true,
      lastRead: source.lastRead ?? null,
    });
  }
  const withData = [provider, ...redirects].filter(
    (source): source is JAgentDeskAgentBackgroundWorkSource =>
      source !== undefined && (source.size ?? 0) > 0 && tabs.some((tab) => tab.id === source.id),
  );
  const newest = newestSource(withData);
  // An old daemon reports no sizes: its single provider tab is the default.
  const defaultTabId = newest?.id ?? tabs.find((tab) => tab.available)?.id ?? tabs[0].id;
  return {
    tabs,
    defaultTabId,
    script: scriptSource?.script
      ? {
          label: scriptSource.label,
          path: scriptSource.path ?? null,
          content: scriptSource.script.content,
          truncated: scriptSource.script.truncated,
          lineCount: scriptSource.script.lineCount,
        }
      : null,
    empty: detail.sources !== undefined && withData.length === 0,
  };
}

/** Latest `modifiedAt` wins; a source without one ranks below any that has one. */
function newestSource(
  sources: readonly JAgentDeskAgentBackgroundWorkSource[],
): JAgentDeskAgentBackgroundWorkSource | null {
  let best: JAgentDeskAgentBackgroundWorkSource | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const source of sources) {
    const at = source.modifiedAt ? Date.parse(source.modifiedAt) : Number.NaN;
    const rank = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (best === null || rank > bestAt) {
      best = source;
      bestAt = rank;
    }
  }
  return best;
}

const SHEBANG_LANGUAGES: Record<string, string> = {
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  dash: "sh",
  ksh: "sh",
  fish: "sh",
  node: "js",
  bun: "ts",
  deno: "ts",
  python: "py",
  python3: "py",
  ruby: "rb",
};

/** Highlighter language of a script: its extension, else its `#!` line. */
export function scriptLanguage(label: string, content: string): string | null {
  const extension = /\.([A-Za-z0-9]+)$/.exec(label)?.[1]?.toLowerCase();
  if (extension) return extension === "zsh" || extension === "bash" ? "sh" : extension;
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(content);
  if (!shebang) return null;
  const program = shebang[1].split("/").pop() ?? "";
  const interpreter = program === "env" ? (shebang[2] ?? "") : program;
  return SHEBANG_LANGUAGES[interpreter] ?? null;
}
