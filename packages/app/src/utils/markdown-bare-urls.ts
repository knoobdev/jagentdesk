import type MarkdownIt from "markdown-it";

// Paseo #7859: recognize scheme URLs as one unit, including ports, user info and IPv6.
// Quotes, unbalanced parentheses and trailing sentence punctuation stay outside the link.
const URL_CHARACTER = String.raw`[^\s<>()"'\x60]`;
const URL_GROUP = String.raw`\(${URL_CHARACTER}*\)`;
const BARE_URL = String.raw`https?://(?:${URL_CHARACTER}|${URL_GROUP})*(?:[^\s<>()"'\x60.,;:!?]|${URL_GROUP})`;

export function recognizeBareUrls(parser: MarkdownIt): void {
  parser.core.ruler.before("linkify", "scheme_urls", (state) => {
    if (!state.md.options.linkify) return;
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const children: typeof block.children = [];
      let linkDepth = 0;
      for (const token of block.children) {
        if (token.type === "link_open") linkDepth++;
        if (token.type === "link_close") linkDepth--;
        if (token.type !== "text" || linkDepth > 0) {
          children.push(token);
          continue;
        }
        let offset = 0;
        for (const match of token.content.matchAll(new RegExp(BARE_URL, "g"))) {
          const url = parser
            .normalizeLink(match[0])
            .replace(/^(https?:\/\/(?:[^/?#]*@)?)%5B([^/?#]+)%5D/i, "$1[$2]");
          if (!parser.validateLink(url)) continue;
          if (match.index > offset) {
            const text = new state.Token("text", "", 0);
            text.content = token.content.slice(offset, match.index);
            children.push(text);
          }
          const open = new state.Token("link_open", "a", 1);
          open.attrSet("href", url);
          open.markup = "linkify";
          open.info = "auto";
          const text = new state.Token("text", "", 0);
          text.content = match[0];
          const close = new state.Token("link_close", "a", -1);
          close.markup = "linkify";
          close.info = "auto";
          children.push(open, text, close);
          offset = match.index + match[0].length;
        }
        if (offset === 0) children.push(token);
        else if (offset < token.content.length) {
          const text = new state.Token("text", "", 0);
          text.content = token.content.slice(offset);
          children.push(text);
        }
      }
      block.children = children;
    }
  });
}
