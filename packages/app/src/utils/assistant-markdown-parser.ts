import MarkdownIt from "markdown-it";
import { enableStreamingMarkdown } from "@/utils/streaming-markdown";

// `streaming: true` treats unfinished formatting at the growing message tail as provisional so
// delimiters and link destinations don't flash while tokens stream in; completed messages parse normally.
export function createAssistantMarkdownParser({ streaming = false } = {}): MarkdownIt {
  const parser = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
  });
  const defaultValidateLink = parser.validateLink.bind(parser);

  parser.validateLink = (url: string) =>
    url.trim().toLowerCase().startsWith("file://") || defaultValidateLink(url);

  if (streaming) {
    enableStreamingMarkdown(parser);
  }

  return parser;
}
