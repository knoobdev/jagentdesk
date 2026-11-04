import type { JiraRichText } from "@jagentdesk/protocol/jira/rpc-schemas";
import {
  attachmentMarkdown,
  escapeMarkdownText,
  linkDestination,
  MENTION_SCHEME,
  parseMarkdown,
  urlLink,
  type BlockNode,
  type InlineNode,
  type RichTextAttachment,
} from "./markdown-tokens.js";

// Jira Data Center wiki markup ↔ Markdown (description, comment and worklog text on REST v2).
// Syntax reference: Jira "Text Formatting Notation Help".

// ── Wiki → Markdown ─────────────────────────────────────────────────────

const BLOCK_MACRO = /^\{(code|noformat|quote|panel|color)(?::[^}]*)?\}(.*)$/;

class WikiReader {
  readonly unsupported = new Set<string>();

  constructor(private readonly attachments: readonly RichTextAttachment[]) {}

  // oxlint-disable-next-line complexity
  read(source: string): string {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const out: string[] = [];
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length > 0) out.push(paragraph.map((l) => this.inline(l)).join("\\\n"));
      paragraph = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const trimmed = line.trim();
      const macro = BLOCK_MACRO.exec(trimmed);
      if (macro) {
        flush();
        const name = macro[1] ?? "";
        const { body, end } = this.collectMacro(lines, index, name, macro[2] ?? "");
        index = end;
        out.push(this.renderMacro(name, trimmed, body));
        continue;
      }
      if (trimmed.length === 0) {
        flush();
        continue;
      }
      const heading = /^h([1-6])\.\s+(.*)$/.exec(trimmed);
      if (heading) {
        flush();
        out.push(`${"#".repeat(Number(heading[1]))} ${this.inline(heading[2] ?? "")}`);
        continue;
      }
      if (trimmed.startsWith("bq. ")) {
        flush();
        out.push(`> ${this.inline(trimmed.slice(4))}`);
        continue;
      }
      if (/^-{4,}$/.test(trimmed)) {
        flush();
        out.push("---");
        continue;
      }
      if (/^[*#-]+\s/.test(trimmed)) {
        flush();
        const items: string[] = [];
        while (index < lines.length && /^[*#-]+\s/.test((lines[index] ?? "").trim())) {
          items.push(this.listLine((lines[index] ?? "").trim()));
          index += 1;
        }
        index -= 1;
        out.push(items.join("\n"));
        continue;
      }
      if (trimmed.startsWith("|")) {
        flush();
        const rows: string[] = [];
        while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
          rows.push((lines[index] ?? "").trim());
          index += 1;
        }
        index -= 1;
        out.push(this.table(rows));
        continue;
      }
      paragraph.push(line);
    }
    flush();
    return out.join("\n\n");
  }

  private collectMacro(
    lines: string[],
    start: number,
    name: string,
    rest: string,
  ): { body: string[]; end: number } {
    const close = `{${name}}`;
    const body: string[] = [];
    const sameLineEnd = rest.indexOf(close);
    if (sameLineEnd >= 0) return { body: [rest.slice(0, sameLineEnd)], end: start };
    if (rest.length > 0) body.push(rest);
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const at = line.indexOf(close);
      if (at >= 0) {
        if (at > 0) body.push(line.slice(0, at));
        return { body, end: index };
      }
      body.push(line);
    }
    return { body, end: lines.length - 1 };
  }

  private renderMacro(name: string, opener: string, body: string[]): string {
    if (name === "code" || name === "noformat") {
      const language = name === "code" ? (/^\{code:([^}|]+)/.exec(opener)?.[1] ?? "") : "";
      return ["```" + language, ...body, "```"].join("\n");
    }
    if (name === "panel" || name === "color") this.unsupported.add(name);
    const inner = new WikiReader(this.attachments);
    const text = inner.read(body.join("\n"));
    for (const item of inner.unsupported) this.unsupported.add(item);
    if (name === "color") return text;
    return text
      .split("\n")
      .map((line) => `> ${line}`.trimEnd())
      .join("\n");
  }

  private listLine(line: string): string {
    const marker = /^([*#-]+)\s+(.*)$/.exec(line);
    const symbols = marker?.[1] ?? "*";
    const depth = symbols.length - 1;
    const ordered = symbols.endsWith("#");
    return `${"  ".repeat(depth * (ordered ? 2 : 1))}${ordered ? "1." : "-"} ${this.inline(marker?.[2] ?? "")}`;
  }

  private table(rows: string[]): string {
    const parse = (row: string) => {
      const header = row.startsWith("||");
      const cells = row
        .replace(/^\|\|?/, "")
        .replace(/\|\|?$/, "")
        .split(/\|\|?/)
        .map((cell) => this.inline(cell.trim()));
      return { header, cells };
    };
    const parsed = rows.map(parse);
    if (!parsed[0]?.header) this.unsupported.add("table without header row");
    const width = Math.max(1, ...parsed.map((row) => row.cells.length));
    const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill("")];
    const head = pad(parsed[0]?.cells ?? []);
    return [
      `| ${head.join(" | ")} |`,
      `| ${head.map(() => "---").join(" | ")} |`,
      ...parsed.slice(1).map((row) => `| ${pad(row.cells).join(" | ")} |`),
    ].join("\n");
  }

  // `!name.png!`, `!name.png|thumbnail!`, `!https://host/x.png!`.
  private image(spec: string): string {
    this.unsupported.add("media");
    const name = (spec.split("|")[0] ?? "").trim();
    if (/^https?:\/\//i.test(name)) return `![](${linkDestination(name)})`;
    return (
      attachmentMarkdown(name, this.attachments) ?? `[attachment: ${escapeMarkdownText(name)}]`
    );
  }

  // `[^file.pdf]` and `[label|^file.pdf]`.
  private fileLink(name: string, label: string | null): string {
    this.unsupported.add("media");
    const mapped = attachmentMarkdown(name.trim(), this.attachments);
    if (!mapped) return `[attachment: ${escapeMarkdownText(name.trim())}]`;
    if (label === null) return mapped;
    return mapped.replace(/^!?\[[^\]]*\]/, () => `[${escapeMarkdownText(label)}]`);
  }

  inline(text: string): string {
    const placeholders: string[] = [];
    const hold = (value: string) => {
      placeholders.push(value);
      return `\uE000${placeholders.length - 1}\uE000`;
    };
    let out = text
      .replace(/\{\{(.+?)\}\}/g, (_m, code: string) => hold(`\`${code}\``))
      .replace(/\[~([^\]]+)\]/g, (_m, user: string) =>
        hold(`[@${escapeMarkdownText(user)}](${MENTION_SCHEME}${encodeURIComponent(user)})`),
      )
      .replace(/\[\^([^\]]+)\]/g, (_m, name: string) => hold(this.fileLink(name, null)))
      .replace(/\[([^|\]]+)\|([^\]]+)\]/g, (_m, label: string, url: string) =>
        hold(
          url.startsWith("^")
            ? this.fileLink(url.slice(1), label)
            : `[${escapeMarkdownText(label)}](${linkDestination(url)})`,
        ),
      )
      .replace(/\[((?:https?|mailto):[^\]]+)\]/g, (_m, url: string) => hold(urlLink(url)))
      .replace(/!([^!\s][^!]*)!/g, (_m, spec: string) => hold(this.image(spec)));
    out = escapeMarkdownText(out)
      .replace(/(^|[\s(])\\\*(\S(?:.*?\S)?)\\\*(?=$|[\s).,;:!?])/g, "$1**$2**")
      .replace(/(^|[\s(])\\_(\S(?:.*?\S)?)\\_(?=$|[\s).,;:!?])/g, "$1*$2*")
      .replace(/(^|[\s(])-(\S(?:.*?\S)?)-(?=$|[\s).,;:!?])/g, "$1~~$2~~")
      .replace(
        /(^|[\s(])\+(\S(?:.*?\S)?)\+(?=$|[\s).,;:!?])/g,
        (_m, lead: string, body: string) => {
          this.unsupported.add("underline");
          return `${lead}${body}`;
        },
      )
      .replace(/(^|[\s(])\?\?(\S(?:.*?\S)?)\?\?(?=$|[\s).,;:!?])/g, "$1*$2*")
      .replace(/\\\\\\\\/g, "\\\n");
    return out.replace(
      /\uE000(\d+)\uE000/g,
      (_m, index: string) => placeholders[Number(index)] ?? "",
    );
  }
}

/** Wiki markup → Markdown; `!file!` and `[^file]` map to `attachments` (the issue's list). */
export function wikiToRichText(
  value: unknown,
  attachments: readonly RichTextAttachment[] = [],
): JiraRichText {
  if (typeof value !== "string" || value.length === 0) {
    return { markdown: "", editable: true, unsupported: [] };
  }
  const reader = new WikiReader(attachments);
  const markdown = reader.read(value);
  const unsupported = [...reader.unsupported].sort();
  return { markdown, editable: unsupported.length === 0, unsupported };
}

// ── Markdown → wiki ─────────────────────────────────────────────────────

function wikiEscape(text: string): string {
  return text.replace(/([*_{}[\]|!^~+?-])/g, "\\$1");
}

function wikiInline(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "hardBreak") return "\\\\ ";
      if (node.type === "mention") return `[~${node.ref}]`;
      const code = node.marks.some((mark) => mark.type === "code");
      let text = code ? `{{${node.text}}}` : wikiEscape(node.text);
      for (const mark of node.marks) {
        if (mark.type === "strong") text = `*${text}*`;
        if (mark.type === "em") text = `_${text}_`;
        if (mark.type === "strike") text = `-${text}-`;
      }
      const link = node.marks.find((mark) => mark.type === "link");
      return link && link.type === "link" ? `[${text}|${link.href}]` : text;
    })
    .join("");
}

function wikiList(items: BlockNode[][], prefix: string): string {
  return items
    .map((blocks) =>
      blocks
        .map((block, index) => {
          if (block.type === "bulletList") return wikiList(block.items, `${prefix}*`);
          if (block.type === "orderedList") return wikiList(block.items, `${prefix}#`);
          const text = wikiBlock(block);
          return index === 0 ? `${prefix} ${text}` : text;
        })
        .join("\n"),
    )
    .join("\n");
}

function wikiBlock(block: BlockNode): string {
  switch (block.type) {
    case "paragraph":
      return wikiInline(block.content);
    case "heading":
      return `h${block.level}. ${wikiInline(block.content)}`;
    case "bulletList":
      return wikiList(block.items, "*");
    case "orderedList":
      return wikiList(block.items, "#");
    case "codeBlock":
      return [block.language ? `{code:${block.language}}` : "{code}", block.text, "{code}"].join(
        "\n",
      );
    case "blockquote":
      return ["{quote}", block.content.map(wikiBlock).join("\n\n"), "{quote}"].join("\n");
    case "rule":
      return "----";
    case "table":
      return [
        `||${block.header.map(wikiInline).join("||")}||`,
        ...block.rows.map((row) => `|${row.map(wikiInline).join("|")}|`),
      ].join("\n");
  }
}

export function markdownToWiki(markdown: string): string {
  return parseMarkdown(markdown).map(wikiBlock).join("\n\n");
}
