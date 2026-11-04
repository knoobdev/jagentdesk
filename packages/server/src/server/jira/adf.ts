import type { JiraRichText } from "@jagentdesk/protocol/jira/rpc-schemas";
import {
  attachmentMarkdown,
  escapeLineStart,
  escapeMarkdownText,
  linkDestination,
  MENTION_SCHEME,
  parseMarkdown,
  urlLink,
  type BlockNode,
  type InlineMark,
  type InlineNode,
  type RichTextAttachment,
} from "./markdown-tokens.js";

// Atlassian Document Format (Jira Cloud v3) ↔ Markdown. Node names follow
// https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/.

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

// ── ADF → Markdown ──────────────────────────────────────────────────────

class AdfReader {
  readonly unsupported = new Set<string>();

  constructor(private readonly attachments: readonly RichTextAttachment[]) {}

  blocks(nodes: AdfNode[] | undefined, indent = ""): string {
    return (nodes ?? [])
      .map((node) => this.block(node, indent))
      .filter((text) => text.length > 0)
      .join("\n\n");
  }

  // oxlint-disable-next-line complexity
  block(node: AdfNode, indent: string): string {
    switch (node.type) {
      case "paragraph":
        return indent + escapeLineStart(this.inline(node.content));
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
        return `${indent}${"#".repeat(level)} ${this.inline(node.content)}`;
      }
      case "bulletList":
        return this.list(node, indent, () => "- ");
      case "orderedList": {
        const start = Number(node.attrs?.order ?? 1);
        return this.list(node, indent, (index) => `${start + index}. `);
      }
      case "codeBlock": {
        const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
        const text = (node.content ?? []).map((child) => child.text ?? "").join("");
        return [`${indent}\`\`\`${language}`, ...text.split("\n").map((l) => indent + l)]
          .concat(`${indent}\`\`\``)
          .join("\n");
      }
      case "blockquote":
        return prefixLines(this.blocks(node.content), `${indent}> `);
      case "rule":
        return `${indent}---`;
      case "table":
        return this.table(node, indent);
      case "panel":
        this.unsupported.add("panel");
        return prefixLines(this.blocks(node.content), `${indent}> `);
      case "expand":
      case "nestedExpand": {
        this.unsupported.add("expand");
        const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
        return [
          title ? `${indent}**${escapeMarkdownText(title)}**` : "",
          this.blocks(node.content, indent),
        ]
          .filter(Boolean)
          .join("\n\n");
      }
      case "mediaSingle":
      case "mediaGroup":
        this.unsupported.add("media");
        return (node.content ?? [])
          .map((child) => {
            if (child.type !== "caption") return indent + this.mediaLabel(child);
            const caption = this.inline(child.content);
            return caption ? `${indent}*${caption}*` : "";
          })
          .filter((line) => line.length > 0)
          .join("\n\n");
      case "media":
        this.unsupported.add("media");
        return indent + this.mediaLabel(node);
      case "taskList":
      case "decisionList":
        this.unsupported.add(node.type);
        return (node.content ?? [])
          .map((item) => {
            const done = item.attrs?.state === "DONE" || item.attrs?.state === "DECIDED";
            return `${indent}- [${done ? "x" : " "}] ${this.inline(item.content)}`;
          })
          .join("\n");
      case "layoutSection":
      case "layoutColumn":
      case "syncBlock":
      case "bodiedSyncBlock":
        this.unsupported.add(node.type);
        return this.blocks(node.content, indent);
      case "extension":
      case "bodiedExtension":
      case "multiBodiedExtension":
        this.unsupported.add("macro");
        return `${indent}[macro: ${String(node.attrs?.extensionKey ?? "unknown")}]`;
      case "blockCard":
      case "embedCard":
        this.unsupported.add("card");
        return indent + cardLink(node);
      default:
        this.unsupported.add(node.type);
        return node.content ? this.blocks(node.content, indent) : "";
    }
  }

  private list(node: AdfNode, indent: string, marker: (index: number) => string): string {
    return (node.content ?? [])
      .map((item, index) => {
        const bullet = marker(index);
        const pad = " ".repeat(bullet.length);
        const children = item.content ?? [];
        const parts = children.map((child, childIndex) => {
          if (childIndex === 0 && child.type === "paragraph") {
            return `${indent}${bullet}${this.inline(child.content)}`;
          }
          return this.block(child, indent + pad);
        });
        if (children[0]?.type !== "paragraph") parts.unshift(`${indent}${bullet}`);
        return parts.join("\n");
      })
      .join("\n");
  }

  private table(node: AdfNode, indent: string): string {
    const rows = node.content ?? [];
    const cellText = (cell: AdfNode): string => {
      const blocks = cell.content ?? [];
      const spans = Number(cell.attrs?.colspan ?? 1) > 1 || Number(cell.attrs?.rowspan ?? 1) > 1;
      const simple = blocks.length <= 1 && blocks.every((block) => block.type === "paragraph");
      if (spans || !simple) this.unsupported.add("complex table");
      return blocks
        .map((block) =>
          block.type === "paragraph" ? this.inline(block.content) : this.block(block, ""),
        )
        .join(" ")
        .replace(/\n/g, " ");
    };
    const matrix = rows.map((row) => (row.content ?? []).map(cellText));
    const headerRow = rows[0]?.content?.every((cell) => cell.type === "tableHeader") === true;
    if (!headerRow) this.unsupported.add("table without header row");
    const width = Math.max(1, ...matrix.map((row) => row.length));
    const pad = (row: string[]) => [...row, ...Array(width - row.length).fill("")];
    const header = pad(matrix[0] ?? []);
    const lines = [
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      ...matrix.slice(1).map((row) => `| ${pad(row).join(" | ")} |`),
    ];
    return lines.map((line) => indent + line).join("\n");
  }

  // Media nodes point at the issue's attachments by file name (`alt`); external media by URL.
  private mediaLabel(node: AdfNode): string {
    const url = typeof node.attrs?.url === "string" ? node.attrs.url : "";
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
    if (node.attrs?.type === "external" && /^https?:\/\//i.test(url)) {
      return `![${escapeMarkdownText(alt)}](${linkDestination(url)})`;
    }
    const mapped = alt ? attachmentMarkdown(alt, this.attachments) : null;
    if (mapped) return mapped;
    const name = alt || String(node.attrs?.id ?? "file");
    return `[attachment: ${escapeMarkdownText(name)}]`;
  }

  // oxlint-disable-next-line complexity
  inline(nodes: AdfNode[] | undefined): string {
    let out = "";
    for (const node of nodes ?? []) {
      switch (node.type) {
        case "text":
          out += this.markedText(node);
          break;
        case "hardBreak":
          out += "\\\n";
          break;
        case "mention": {
          const text = String(node.attrs?.text ?? "").replace(/^@/, "");
          const ref = encodeURIComponent(String(node.attrs?.id ?? ""));
          out += `[@${escapeMarkdownText(text)}](${MENTION_SCHEME}${ref})`;
          break;
        }
        case "emoji":
          out += String(node.attrs?.text ?? node.attrs?.shortName ?? "");
          break;
        case "date": {
          this.unsupported.add("date");
          const ms = Number(node.attrs?.timestamp ?? 0);
          out += Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
          break;
        }
        case "status":
          this.unsupported.add("status");
          out += `[${String(node.attrs?.text ?? "")}]`;
          break;
        case "inlineCard":
          this.unsupported.add("card");
          out += cardLink(node);
          break;
        case "mediaInline":
          this.unsupported.add("media");
          out += this.mediaLabel(node);
          break;
        default:
          this.unsupported.add(node.type);
          out += node.text ?? this.inline(node.content);
      }
    }
    return out;
  }

  private markedText(node: AdfNode): string {
    const marks = node.marks ?? [];
    const isCode = marks.some((mark) => mark.type === "code");
    let text = isCode ? codeSpan(node.text ?? "") : escapeMarkdownText(node.text ?? "");
    let href: string | null = null;
    for (const mark of marks) {
      switch (mark.type) {
        case "strong":
          text = `**${text}**`;
          break;
        case "em":
          text = `*${text}*`;
          break;
        case "strike":
          text = `~~${text}~~`;
          break;
        case "link":
          href = typeof mark.attrs?.href === "string" ? mark.attrs.href : null;
          break;
        case "code":
          break;
        default:
          this.unsupported.add(mark.type);
      }
    }
    return href ? `[${text}](${href})` : text;
  }
}

// Smart links (inline/block/embed cards): the URL as a link. A card may carry resolved `data`
// (JSON-LD) instead of a URL.
function cardLink(node: AdfNode): string {
  const data = node.attrs?.data as { url?: unknown } | undefined;
  const raw = node.attrs?.url ?? data?.url;
  const url = typeof raw === "string" ? raw.trim() : "";
  return url ? urlLink(url) : "";
}

function codeSpan(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  return `${fence}${text}${fence}`;
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`.trimEnd())
    .join("\n");
}

function isAdfDoc(value: unknown): value is AdfDoc {
  return typeof value === "object" && value !== null && (value as AdfNode).type === "doc";
}

/**
 * ADF (or a plain string, which some v3 fields still return) → Markdown for the wire. Media
 * nodes become `jira-attachment:` references to `attachments` (the issue's attachment list).
 */
export function adfToRichText(
  value: unknown,
  attachments: readonly RichTextAttachment[] = [],
): JiraRichText {
  if (value === null || value === undefined) {
    return { markdown: "", editable: true, unsupported: [] };
  }
  if (typeof value === "string") {
    return { markdown: escapeMarkdownText(value), editable: true, unsupported: [] };
  }
  if (!isAdfDoc(value)) {
    return { markdown: "", editable: false, unsupported: ["unknown format"] };
  }
  const reader = new AdfReader(attachments);
  const markdown = reader.blocks(value.content);
  const unsupported = [...reader.unsupported].sort();
  return { markdown, editable: unsupported.length === 0, unsupported };
}

// ── Markdown → ADF ──────────────────────────────────────────────────────

function adfMarks(marks: InlineMark[]): AdfNode["marks"] {
  const hasCode = marks.some((mark) => mark.type === "code");
  // ADF allows `code` only together with `link`.
  const kept = hasCode ? marks.filter((m) => m.type === "code" || m.type === "link") : marks;
  return kept.map((mark) =>
    mark.type === "link" ? { type: "link", attrs: { href: mark.href } } : { type: mark.type },
  );
}

function adfInline(nodes: InlineNode[]): AdfNode[] {
  return nodes.map((node): AdfNode => {
    if (node.type === "hardBreak") return { type: "hardBreak" };
    if (node.type === "mention") {
      return { type: "mention", attrs: { id: node.ref, text: `@${node.text}` } };
    }
    const marks = adfMarks(node.marks);
    return marks && marks.length > 0
      ? { type: "text", text: node.text, marks }
      : { type: "text", text: node.text };
  });
}

function adfParagraph(content: InlineNode[]): AdfNode {
  const inline = adfInline(content);
  return inline.length > 0 ? { type: "paragraph", content: inline } : { type: "paragraph" };
}

function adfListItems(items: BlockNode[][]): AdfNode[] {
  return items.map((blocks) => ({
    type: "listItem",
    content: blocks.length > 0 ? blocks.map(adfBlock) : [{ type: "paragraph" }],
  }));
}

function adfBlock(block: BlockNode): AdfNode {
  switch (block.type) {
    case "paragraph":
      return adfParagraph(block.content);
    case "heading":
      return { type: "heading", attrs: { level: block.level }, content: adfInline(block.content) };
    case "bulletList":
      return { type: "bulletList", content: adfListItems(block.items) };
    case "orderedList":
      return {
        type: "orderedList",
        attrs: { order: block.start },
        content: adfListItems(block.items),
      };
    case "codeBlock":
      return {
        type: "codeBlock",
        ...(block.language ? { attrs: { language: block.language } } : {}),
        ...(block.text.length > 0 ? { content: [{ type: "text", text: block.text }] } : {}),
      };
    case "blockquote":
      return { type: "blockquote", content: block.content.map(adfBlock) };
    case "rule":
      return { type: "rule" };
    case "table": {
      const row = (cells: InlineNode[][], cellType: string): AdfNode => ({
        type: "tableRow",
        content: cells.map((cell) => ({ type: cellType, content: [adfParagraph(cell)] })),
      });
      return {
        type: "table",
        content: [
          row(block.header, "tableHeader"),
          ...block.rows.map((cells) => row(cells, "tableCell")),
        ],
      };
    }
  }
}

export function markdownToAdf(markdown: string): AdfDoc {
  return { version: 1, type: "doc", content: parseMarkdown(markdown).map(adfBlock) };
}
