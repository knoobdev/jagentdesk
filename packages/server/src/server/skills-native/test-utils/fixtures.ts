import { createHash } from "node:crypto";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { FetchLike, FetchResponseLike } from "../remote-sources.js";

/** Isolated temp HOME + JAGENTDESK_HOME. Never the real home directory. */
export function makeTempRoots(): { root: string; home: string; jdHome: string } {
  const root = mkdtempSync(path.join(tmpdir(), "jad-native-skills-"));
  return { root, home: path.join(root, "home"), jdHome: path.join(root, "jd-home") };
}

export async function writeSkill(
  dir: string,
  frontmatter: string,
  body = "Do the thing.\n",
  extra: Record<string, string> = {},
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
  for (const [relative, content] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), content);
  }
}

/** Every entry below `root`: type, content hash / link target. Order-independent. */
export async function snapshotTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const absolute = path.join(dir, name);
      const relative = path.relative(root, absolute);
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) {
        out.push(`l ${relative} -> ${await fs.readlink(absolute)}`);
      } else if (stats.isDirectory()) {
        out.push(`d ${relative}`);
        await walk(absolute);
      } else {
        const digest = createHash("sha256")
          .update(await fs.readFile(absolute))
          .digest("hex");
        out.push(`f ${relative} ${digest}`);
      }
    }
  };
  await walk(root);
  return out;
}

function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function padded(data: Buffer): Buffer {
  const remainder = data.length % 512;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - remainder, 0)]);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return Buffer.from(`${length}${body}`, "utf8");
}

/** A GitHub-style tarball: pax global header with the commit, then `<top>/…` files. */
export function makeTarGz(
  files: Record<string, string>,
  options: { top?: string; commit?: string; rawEntries?: Array<[string, string]> } = {},
): Buffer {
  const parts: Buffer[] = [];
  if (options.commit) {
    const pax = paxRecord("comment", options.commit);
    parts.push(header("pax_global_header", pax.length, "g"), padded(pax));
  }
  const top = options.top ?? "repo-HEAD";
  for (const [relative, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    parts.push(header(`${top}/${relative}`, data.length, "0"), padded(data));
  }
  for (const [name, content] of options.rawEntries ?? []) {
    const data = Buffer.from(content, "utf8");
    parts.push(header(name, data.length, "0"), padded(data));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

const FAKE_ROUTE = Symbol("fakeRoute");

export interface FakeRoute {
  [FAKE_ROUTE]: true;
  status: number;
  headers: Record<string, string>;
  body: Buffer | object | string | null;
}

/** A response with an explicit status / headers (plain values mean 200). */
export function fakeRoute(options: {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | object | string | null;
}): FakeRoute {
  return {
    [FAKE_ROUTE]: true,
    status: options.status ?? 200,
    headers: options.headers ?? {},
    body: options.body ?? null,
  };
}

type RouteValue = Buffer | object | FakeRoute;
type RouteHandler = (init: { headers: Record<string, string> }) => RouteValue | undefined;

function isFakeRoute(value: unknown): value is FakeRoute {
  return typeof value === "object" && value !== null && FAKE_ROUTE in value;
}

function bodyBuffer(body: FakeRoute["body"]): Buffer {
  if (body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
}

function toResponse(value: RouteValue | undefined): FetchResponseLike {
  let route: FakeRoute;
  if (isFakeRoute(value)) route = value;
  else if (value === undefined) route = fakeRoute({ status: 404 });
  else route = fakeRoute({ body: value });
  const headers = new Map(
    Object.entries(route.headers).map(([key, headerValue]) => [key.toLowerCase(), headerValue]),
  );
  const buffer = bodyBuffer(route.body);
  return {
    ok: route.status >= 200 && route.status < 300,
    status: route.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => new Uint8Array(buffer).slice().buffer,
    json: async () =>
      route.body !== null && !Buffer.isBuffer(route.body) && typeof route.body === "object"
        ? route.body
        : JSON.parse(buffer.toString("utf8")),
    text: async () => buffer.toString("utf8"),
  };
}

/**
 * Serves fixed URLs (a value, a {@link fakeRoute}, or a function of the request
 * headers); any other URL answers 404. `routes` may be mutated between calls.
 */
export function fakeFetch(routes: Record<string, RouteValue | RouteHandler>): FetchLike & {
  calls: string[];
  requests: Array<{ url: string; headers: Record<string, string> }>;
  routes: Record<string, RouteValue | RouteHandler>;
} {
  const calls: string[] = [];
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl: FetchLike = async (url, init) => {
    const headers = init?.headers ?? {};
    calls.push(url);
    requests.push({ url, headers });
    const route = routes[url];
    return toResponse(typeof route === "function" ? route({ headers }) : route);
  };
  return Object.assign(impl, { calls, requests, routes });
}

export interface FakeRepoFile {
  content: string;
  mode?: string;
}

/**
 * Routes of a GitHub repository at `commit`: the recursive tree API response
 * (git-style blob shas) and every file on raw.githubusercontent.com.
 */
export function githubRepoRoutes(
  repo: string,
  commit: string,
  files: Record<string, FakeRepoFile | string>,
  options: { ref?: string; truncated?: boolean; etag?: string } = {},
): { treeUrl: string; tree: object; routes: Record<string, RouteValue> } {
  const tree: object[] = [];
  const routes: Record<string, RouteValue> = {};
  const dirs = new Set<string>();
  for (const [filePath, value] of Object.entries(files)) {
    const file = typeof value === "string" ? { content: value } : value;
    const data = Buffer.from(file.content, "utf8");
    tree.push({
      path: filePath,
      mode: file.mode ?? "100644",
      type: "blob",
      sha: createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex"),
      size: data.length,
    });
    routes[`https://raw.githubusercontent.com/${repo}/${commit}/${filePath}`] = data;
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join("/"));
  }
  for (const dir of dirs) {
    tree.push({ path: dir, mode: "040000", type: "tree", sha: "d".repeat(40) });
  }
  const body = { sha: commit, truncated: options.truncated ?? false, tree };
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${options.ref ?? "HEAD"}?recursive=1`;
  routes[treeUrl] = fakeRoute({
    body,
    headers: options.etag ? { ETag: options.etag } : {},
  });
  return { treeUrl, tree: body, routes };
}
