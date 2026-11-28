import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GuestFaviconFetcher, MAX_FAVICON_BYTES, type FaviconSession } from "./favicons.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR4nGP4z8DwnxLMMGrAqAGjBgwXAwDZ0P8Bz1nqTgAAAABJRU5ErkJggg==",
  "base64",
);
const IDENTITY = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "Accept-Language": "ja-JP,ja;q=0.9",
  "Sec-CH-UA-Platform": '"Windows"',
};

interface SeenRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
}

const seen: SeenRequest[] = [];
let failNext = 0;
let server: http.Server;
let origin = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    const pathname = new URL(path, "http://x").pathname;
    seen.push({ path, headers: req.headers });
    if (failNext > 0) {
      failNext -= 1;
      res.statusCode = 503;
      res.end();
      return;
    }
    if (pathname === "/favicon.ico") {
      res.setHeader("content-type", "application/octet-stream");
      res.end(PNG);
    } else if (pathname === "/icon.png") {
      res.setHeader("content-type", "image/png");
      res.end(PNG);
    } else if (pathname === "/moved.png") {
      res.statusCode = 302;
      res.setHeader("location", "/icon.png");
      res.end();
    } else if (pathname === "/page.html") {
      res.setHeader("content-type", "text/html");
      res.end("<html></html>");
    } else if (pathname === "/huge.png") {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.alloc(MAX_FAVICON_BYTES + 1));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Stands in for the guest's Electron session; requests reach a real local server. */
function guestSession(): FaviconSession {
  return { fetch: (input, init) => fetch(input, init) };
}

function fetcher(): GuestFaviconFetcher {
  return new GuestFaviconFetcher({ identityHeaders: () => IDENTITY });
}

function requestsTo(path: string): SeenRequest[] {
  return seen.filter((request) => request.path === path);
}

describe("GuestFaviconFetcher", () => {
  it("fetches the icon with the tab's identity headers and returns a data: URL", async () => {
    const dataUrl = await fetcher().resolve(guestSession(), `${origin}/icon.png`);
    expect(dataUrl).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    const request = requestsTo("/icon.png").at(-1);
    expect(request?.headers["user-agent"]).toBe(IDENTITY["User-Agent"]);
    expect(request?.headers["accept-language"]).toBe(IDENTITY["Accept-Language"]);
    expect(request?.headers["sec-ch-ua-platform"]).toBe(IDENTITY["Sec-CH-UA-Platform"]);
    expect(request?.headers.accept).toMatch(/^image\/avif/);
  });

  it("keeps the identity across a redirect", async () => {
    const before = requestsTo("/icon.png").length;
    expect(await fetcher().resolve(guestSession(), `${origin}/moved.png`)).toMatch(
      /^data:image\/png;base64,/,
    );
    const redirected = requestsTo("/icon.png").slice(before);
    expect(redirected).toHaveLength(1);
    expect(redirected[0]?.headers["user-agent"]).toBe(IDENTITY["User-Agent"]);
  });

  it("accepts an .ico served as a generic binary", async () => {
    expect(await fetcher().resolve(guestSession(), `${origin}/favicon.ico`)).toMatch(
      /^data:image\/x-icon;base64,/,
    );
  });

  it("drops a response that is not an image, too large, or an error", async () => {
    const icons = fetcher();
    expect(await icons.resolve(guestSession(), `${origin}/page.html`)).toBeNull();
    expect(await icons.resolve(guestSession(), `${origin}/huge.png`)).toBeNull();
    expect(await icons.resolve(guestSession(), `${origin}/missing.png`)).toBeNull();
  });

  it("uses a page-declared data: icon as is and fetches nothing for other schemes", async () => {
    const session: FaviconSession = {
      fetch: () => Promise.reject(new Error("must not fetch")),
    };
    const inline = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(await fetcher().resolve(session, inline)).toBe(inline);
    expect(await fetcher().resolve(session, "file:///etc/hosts")).toBeNull();
    expect(await fetcher().resolve(session, "chrome://favicon/x")).toBeNull();
  });

  it("fetches an icon once per session, and again after a failure", async () => {
    const icons = fetcher();
    const session = guestSession();
    const path = "/icon.png?once";
    seen.length = 0;
    await Promise.all([
      icons.resolve(session, `${origin}${path}`),
      icons.resolve(session, `${origin}${path}`),
    ]);
    expect(requestsTo(path)).toHaveLength(1);
    await icons.resolve(guestSession(), `${origin}${path}`);
    expect(requestsTo(path)).toHaveLength(2);

    failNext = 1;
    expect(await icons.resolve(session, `${origin}/icon.png?flaky`)).toBeNull();
    expect(await icons.resolve(session, `${origin}/icon.png?flaky`)).toMatch(/^data:image\/png/);
  });
});
