export const MARKDOWN_COPY_TAG_ATTRIBUTE = "data-jagentdesk-markdown-tag";
export const MARKDOWN_COPY_IGNORE_ATTRIBUTE = "data-jagentdesk-markdown-ignore";
export const MARKDOWN_COPY_LIST_MARKER_ATTRIBUTE = "data-jagentdesk-markdown-list-marker";
export const MARKDOWN_COPY_UNWRAP_ATTRIBUTE = "data-jagentdesk-markdown-unwrap";
export const MARKDOWN_COPY_LIST_START_ATTRIBUTE = "data-jagentdesk-markdown-list-start";
export const MARKDOWN_COPY_LANGUAGE_ATTRIBUTE = "data-jagentdesk-markdown-language";
export const MARKDOWN_COPY_ALIGN_ATTRIBUTE = "data-jagentdesk-markdown-align";
export const MARKDOWN_COPY_SRC_ATTRIBUTE = "data-jagentdesk-markdown-src";
export const MARKDOWN_COPY_ALT_ATTRIBUTE = "data-jagentdesk-markdown-alt";

/**
 * Trailing line breaks, with any indentation that followed the last one.
 *
 * Both ways of copying code strip these, for the same reason: pasting a trailing
 * newline into a terminal runs the last line. A fence body always ends in one, and
 * ends in several when the author left blank lines before the closing fence; a
 * selection picks one up whenever it overshoots the end of a rendered line.
 */
export const TRAILING_CODE_LINE_BREAKS = /(\r?\n[ \t]*)+$/;

export const markdownCopyDataSet = {
  blockquote: { jagentdeskMarkdownTag: "blockquote" },
  br: { jagentdeskMarkdownTag: "br" },
  code: { jagentdeskMarkdownTag: "code" },
  h1: { jagentdeskMarkdownTag: "h1" },
  h2: { jagentdeskMarkdownTag: "h2" },
  h3: { jagentdeskMarkdownTag: "h3" },
  h4: { jagentdeskMarkdownTag: "h4" },
  h5: { jagentdeskMarkdownTag: "h5" },
  h6: { jagentdeskMarkdownTag: "h6" },
  hr: { jagentdeskMarkdownTag: "hr" },
  ignore: { jagentdeskMarkdownIgnore: "true" },
  li: { jagentdeskMarkdownTag: "li" },
  listMarker: { jagentdeskMarkdownIgnore: "true", jagentdeskMarkdownListMarker: "true" },
  ol: { jagentdeskMarkdownTag: "ol" },
  p: { jagentdeskMarkdownTag: "p" },
  pre: { jagentdeskMarkdownTag: "pre" },
  s: { jagentdeskMarkdownTag: "s" },
  strong: { jagentdeskMarkdownTag: "strong" },
  em: { jagentdeskMarkdownTag: "em" },
  table: { jagentdeskMarkdownTag: "table" },
  tbody: { jagentdeskMarkdownTag: "tbody" },
  td: { jagentdeskMarkdownTag: "td" },
  th: { jagentdeskMarkdownTag: "th" },
  thead: { jagentdeskMarkdownTag: "thead" },
  tr: { jagentdeskMarkdownTag: "tr" },
  ul: { jagentdeskMarkdownTag: "ul" },
  unwrap: { jagentdeskMarkdownUnwrap: "true" },
} as const;

export type MarkdownCopyInlineTag = "br" | "code" | "em" | "s" | "strong";

export function markdownCopyOrderedListDataSet(start: unknown) {
  return {
    ...markdownCopyDataSet.ol,
    jagentdeskMarkdownListStart: String(start ?? 1),
  } as const;
}

export function markdownCopyCodeBlockDataSet(language: string | null | undefined) {
  const fenceLanguage = language?.trim().split(/\s+/)[0];
  return {
    ...markdownCopyDataSet.pre,
    ...(fenceLanguage ? { jagentdeskMarkdownLanguage: fenceLanguage } : {}),
  } as const;
}

/**
 * An image copies as the Markdown it came from. The rendered `img` points at a preview
 * URL for data and workspace images, and carries no alt text of its own.
 */
export function markdownCopyImageDataSet(source: string, alt: string | undefined) {
  return {
    jagentdeskMarkdownTag: "img",
    jagentdeskMarkdownSrc: source,
    ...(alt ? { jagentdeskMarkdownAlt: alt } : {}),
  } as const;
}

export function markdownCopyTableCellDataSet(tag: "td" | "th", style: unknown) {
  const alignment =
    typeof style === "string"
      ? style.match(/(?:^|;)\s*text-align\s*:\s*(left|right|center)/i)?.[1]
      : null;
  return {
    ...markdownCopyDataSet[tag],
    ...(alignment ? { jagentdeskMarkdownAlign: alignment.toLowerCase() } : {}),
  } as const;
}
