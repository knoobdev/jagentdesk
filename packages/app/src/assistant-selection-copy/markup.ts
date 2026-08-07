export const MARKDOWN_COPY_TAG_ATTRIBUTE = "data-jagentdesk-markdown-tag";
export const MARKDOWN_COPY_IGNORE_ATTRIBUTE = "data-jagentdesk-markdown-ignore";
export const MARKDOWN_COPY_UNWRAP_ATTRIBUTE = "data-jagentdesk-markdown-unwrap";
export const MARKDOWN_COPY_LIST_START_ATTRIBUTE = "data-jagentdesk-markdown-list-start";
export const MARKDOWN_COPY_LANGUAGE_ATTRIBUTE = "data-jagentdesk-markdown-language";
export const MARKDOWN_COPY_ALIGN_ATTRIBUTE = "data-jagentdesk-markdown-align";

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
