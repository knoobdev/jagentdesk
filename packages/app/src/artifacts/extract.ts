// Artifact extraction (spec §21 / ADR-0019 companion): agents don't emit a dedicated "artifact"
// protocol type, so we DERIVE artifacts from the substantial fenced code blocks in their
// assistant messages — the Canvas panel then renders each (HTML/SVG/Mermaid preview, else code).
// Pure + deterministic so it can be unit-tested and reused by both host and guest surfaces.

export type ArtifactKind = "html" | "svg" | "mermaid" | "markdown" | "code";

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  language: string; // the fence language tag, "" when none
  content: string;
}

export interface ArtifactSourceItem {
  type: string;
  text?: string;
}

// Languages whose content the Canvas can render as a live preview (not just code).
const PREVIEWABLE = new Set(["html", "svg", "mermaid", "markdown", "md", "xml"]);
// A code block qualifies as an artifact when it's substantial, even without a special language.
const MIN_ARTIFACT_LINES = 12;
const MIN_ARTIFACT_CHARS = 400;

function classify(language: string, content: string): ArtifactKind | null {
  const lang = language.toLowerCase();
  if (lang === "html" || lang === "xml") return "html";
  if (lang === "svg") return "svg";
  if (lang === "mermaid") return "mermaid";
  if (lang === "md" || lang === "markdown") return "markdown";
  // Untagged / other languages: only substantial blocks become artifacts.
  const lines = content.split("\n").length;
  if (lang || lines >= MIN_ARTIFACT_LINES || content.length >= MIN_ARTIFACT_CHARS) return "code";
  return null;
}

function titleFor(kind: ArtifactKind, language: string, content: string, index: number): string {
  const firstLine =
    content
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  if (kind === "html") return firstLine.includes("<title>") ? "HTML document" : "HTML preview";
  if (kind === "svg") return "SVG image";
  if (kind === "mermaid") return "Diagram";
  if (kind === "markdown") return firstLine.replace(/^#+\s*/, "").slice(0, 60) || "Document";
  const label = language ? language : "snippet";
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} #${index + 1}`;
}

// Match ``` or ~~~ fenced blocks with an optional language tag.
const FENCE_RE = /(^|\n)([`~]{3,})[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)\n?\2[ \t]*(?=\n|$)/g;

export function extractArtifacts(items: ArtifactSourceItem[]): Artifact[] {
  const artifacts: Artifact[] = [];
  let index = 0;
  for (const item of items) {
    if (item.type !== "assistant_message" || typeof item.text !== "string") continue;
    FENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FENCE_RE.exec(item.text)) !== null) {
      const language = match[3] ?? "";
      const content = match[4] ?? "";
      if (content.trim().length === 0) continue;
      const kind = classify(language, content);
      if (!kind) continue;
      artifacts.push({
        // Stable-ish id: content is the identity, so re-renders don't reshuffle selection.
        id: `artifact-${index}-${hashString(content)}`,
        title: titleFor(kind, language, content, index),
        kind,
        language,
        content,
      });
      index += 1;
    }
  }
  return artifacts;
}

export function isPreviewableLanguage(language: string): boolean {
  return PREVIEWABLE.has(language.toLowerCase());
}

// Small, stable non-cryptographic hash (djb2) for artifact ids.
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
