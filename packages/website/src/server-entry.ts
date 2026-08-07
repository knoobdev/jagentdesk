import startEntry from "@tanstack/react-start/server-entry";
import { getDoc } from "~/docs";
import { buildLlmsTxt } from "~/llms";

function markdownResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}

function docSlugFromMarkdownPath(pathname: string): string | null {
  if (pathname === "/docs.md") return "";
  const match = pathname.match(/^\/docs\/(.+)\.md$/);
  return match ? match[1] : null;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const altRedirectMatch = url.pathname.match(/^\/docs\/alternatives\/(.+?)\/?$/);
    if (altRedirectMatch) {
      url.pathname = `/alternatives/${altRedirectMatch[1]}`;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/llms.txt") {
      return markdownResponse(buildLlmsTxt());
    }

    const slug = docSlugFromMarkdownPath(url.pathname);
    if (slug !== null) {
      const doc = getDoc(slug);
      if (!doc) return new Response("Not found", { status: 404 });
      return markdownResponse(doc.content);
    }

    return startEntry.fetch(request);
  },
};
