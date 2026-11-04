import { JIRA_ATTACHMENT_SCHEME } from "@jagentdesk/protocol/jira/rpc-schemas";
import MarkdownIt from "markdown-it";

// Markdown → a small block/inline tree that both target formats (ADF for Cloud, wiki markup for
// Data Center) render from. Users and agents write Markdown (spec 29.3); Jira stores ADF or wiki.
//
// Mentions use a link with the `jira-mention:` scheme: `[@Display Name](jira-mention:<ref>)`,
// where ref is the accountId (Cloud) or username (Data Center). The read path emits the same form,
// so a description with mentions round-trips.

export const MENTION_SCHEME = "jira-mention:";

export type InlineMark =
  | { type: "strong" }
  | { type: "em" }
  | { type: "strike" }
  | { type: "code" }
  | { type: "link"; href: string };

export type InlineNode =
  | { type: "text"; text: string; marks: InlineMark[] }
  | { type: "hardBreak" }
  | { type: "mention"; ref: string; text: string };

export type BlockNode =
  | { type: "paragraph"; content: InlineNode[] }
  | { type: "heading"; level: number; content: InlineNode[] }
  | { type: "bulletList"; items: BlockNode[][] }
  | { type: "orderedList"; start: number; items: BlockNode[][] }
  | { type: "codeBlock"; language: string | null; text: string }
  | { type: "blockquote"; content: BlockNode[] }
  | { type: "rule" }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][] };

const parser = new MarkdownIt("default", { html: false, linkify: false });

type Token = ReturnType<typeof parser.parse>[number];

class TokenCursor {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}
  peek(): Token | undefined {
    return this.tokens[this.index];
  }
  next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error("Unexpected end of Markdown tokens");
    this.index += 1;
    return token;
  }
  done(): boolean {
    return this.index >= this.tokens.length;
  }
}

export function parseMarkdown(markdown: string): BlockNode[] {
  const cursor = new TokenCursor(parser.parse(markdown, {}));
  return readBlocks(cursor, null);
}

function readBlocks(cursor: TokenCursor, closeType: string | null): BlockNode[] {
  const blocks: BlockNode[] = [];
  while (!cursor.done()) {
    const token = cursor.peek();
    if (!token) break;
    if (closeType && token.type === closeType) {
      cursor.next();
      return blocks;
    }
    const block = readBlock(cursor);
    if (block) blocks.push(block);
  }
  return blocks;
}

// oxlint-disable-next-line complexity
function readBlock(cursor: TokenCursor): BlockNode | null {
  const token = cursor.next();
  switch (token.type) {
    case "paragraph_open": {
      const inline = cursor.next();
      cursor.next(); // paragraph_close
      return { type: "paragraph", content: readInline(inline.children ?? []) };
    }
    case "heading_open": {
      const inline = cursor.next();
      cursor.next();
      return {
        type: "heading",
        level: Number(token.tag.slice(1)),
        content: readInline(inline.children ?? []),
      };
    }
    case "bullet_list_open":
      return { type: "bulletList", items: readListItems(cursor, "bullet_list_close") };
    case "ordered_list_open": {
      const start = Number(token.attrGet("start") ?? "1");
      return {
        type: "orderedList",
        start: Number.isFinite(start) ? start : 1,
        items: readListItems(cursor, "ordered_list_close"),
      };
    }
    case "blockquote_open":
      return { type: "blockquote", content: readBlocks(cursor, "blockquote_close") };
    case "fence":
    case "code_block": {
      const info = token.info.trim().split(/\s+/)[0] ?? "";
      return {
        type: "codeBlock",
        language: info.length > 0 ? info : null,
        text: token.content.replace(/\n$/, ""),
      };
    }
    case "hr":
      return { type: "rule" };
    case "table_open":
      return readTable(cursor);
    default:
      return null;
  }
}

function readListItems(cursor: TokenCursor, closeType: string): BlockNode[][] {
  const items: BlockNode[][] = [];
  while (!cursor.done()) {
    const token = cursor.next();
    if (token.type === closeType) break;
    if (token.type === "list_item_open") {
      items.push(readBlocks(cursor, "list_item_close"));
    }
  }
  return items;
}

function readTable(cursor: TokenCursor): BlockNode {
  const header: InlineNode[][] = [];
  const rows: InlineNode[][][] = [];
  let current: InlineNode[][] | null = null;
  let inHead = false;
  while (!cursor.done()) {
    const token = cursor.next();
    if (token.type === "table_close") break;
    if (token.type === "thead_open") inHead = true;
    if (token.type === "thead_close") inHead = false;
    if (token.type === "tr_open") current = [];
    if (token.type === "tr_close" && current && !inHead) rows.push(current);
    if (token.type === "inline") {
      const cell = readInline(token.children ?? []);
      if (inHead) header.push(cell);
      else current?.push(cell);
    }
  }
  return { type: "table", header, rows };
}

// oxlint-disable-next-line complexity
function readInline(tokens: Token[]): InlineNode[] {
  const nodes: InlineNode[] = [];
  const marks: InlineMark[] = [];
  let mention: { ref: string; text: string } | null = null;
  for (const token of tokens) {
    if (mention && token.type !== "link_close") {
      mention.text += token.content;
      continue;
    }
    switch (token.type) {
      case "text":
        if (token.content.length > 0) pushText(nodes, token.content, marks);
        break;
      case "code_inline":
        pushText(nodes, token.content, [...marks, { type: "code" }]);
        break;
      case "softbreak":
        pushText(nodes, " ", marks);
        break;
      case "hardbreak":
        nodes.push({ type: "hardBreak" });
        break;
      case "strong_open":
        marks.push({ type: "strong" });
        break;
      case "em_open":
        marks.push({ type: "em" });
        break;
      case "s_open":
        marks.push({ type: "strike" });
        break;
      case "strong_close":
        popMark(marks, "strong");
        break;
      case "em_close":
        popMark(marks, "em");
        break;
      case "s_close":
        popMark(marks, "strike");
        break;
      case "link_open": {
        const href = token.attrGet("href") ?? "";
        if (href.startsWith(MENTION_SCHEME)) {
          mention = { ref: decodeURIComponent(href.slice(MENTION_SCHEME.length)), text: "" };
        } else {
          marks.push({ type: "link", href });
        }
        break;
      }
      case "link_close":
        if (mention) {
          nodes.push({ type: "mention", ref: mention.ref, text: mention.text.replace(/^@/, "") });
          mention = null;
        } else {
          popMark(marks, "link");
        }
        break;
      case "image":
        pushText(nodes, token.content || (token.attrGet("src") ?? ""), [
          ...marks,
          { type: "link", href: token.attrGet("src") ?? "" },
        ]);
        break;
      default:
        if (token.content) pushText(nodes, token.content, marks);
    }
  }
  return nodes;
}

function popMark(marks: InlineMark[], type: InlineMark["type"]): void {
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    if (marks[index]?.type === type) {
      marks.splice(index, 1);
      return;
    }
  }
}

function sameMarks(a: InlineMark[], b: InlineMark[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pushText(nodes: InlineNode[], text: string, marks: InlineMark[]): void {
  const last = nodes[nodes.length - 1];
  if (last && last.type === "text" && sameMarks(last.marks, marks)) {
    last.text += text;
    return;
  }
  nodes.push({ type: "text", text, marks: marks.map((mark) => ({ ...mark })) });
}

// Characters that would start Markdown syntax when they appear in plain text.
export function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_[\]~<>|])/g, "\\$1");
}

/** A Markdown link whose text is the URL itself (smart links, bare wiki links). */
export function urlLink(url: string): string {
  return `[${escapeMarkdownText(url)}](${linkDestination(url)})`;
}

/** A URL as a Markdown link destination: characters that would end it are percent-encoded. */
export function linkDestination(url: string): string {
  return url.trim().replace(/[\s()<>]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    return `%${code}`;
  });
}

/** An issue attachment that rich text may reference by file name (ADF media, wiki `!x!`). */
export interface RichTextAttachment {
  id: string;
  filename: string;
  mimeType: string;
  created_ms: number;
}

/**
 * Markdown for a file referenced from rich text: `![name](jira-attachment:<id>)` for an image of
 * the issue's attachments, `[name](jira-attachment:<id>)` for another file, matched by file name
 * (Cloud ADF media carry a Media Services id, not the REST attachment id; the `alt` is the file
 * name). The newest attachment wins when several share a name. Null when none matches.
 */
export function attachmentMarkdown(
  name: string,
  attachments: readonly RichTextAttachment[],
): string | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const exact = attachments.filter((a) => a.filename === wanted);
  const matches =
    exact.length > 0
      ? exact
      : attachments.filter((a) => a.filename.toLowerCase() === wanted.toLowerCase());
  const match = matches.reduce<RichTextAttachment | null>(
    (best, a) => (best === null || a.created_ms >= best.created_ms ? a : best),
    null,
  );
  if (!match) return null;
  const label = escapeMarkdownText(match.filename);
  const target = `${JIRA_ATTACHMENT_SCHEME}${encodeURIComponent(match.id)}`;
  return match.mimeType.startsWith("image/") ? `![${label}](${target})` : `[${label}](${target})`;
}

export function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+[.)]\s)/, "$1\\$2");
}
