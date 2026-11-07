import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  FigmaContent,
  figmaContent,
  type ContentDeps,
  readFontNames,
  defaultGoogleFontsDownload,
} from "./content.js";
import { filesHandlers } from "./files.js";
import type { FigmaHandlerMap, FigmaRequestOf } from "./types.js";
import type { ContentRequestType } from "./content.js";
import { FigmaServiceError } from "../context.js";
import {
  makeFile,
  makeFigmaApi,
  type FakeFigmaApi,
} from "../test-support/fake-figma-content-api.js";

// Unit tests for the content handlers (spec 32.5, 32.8) against a fake Figma API: outline
// mapping, batched nodes, bytes-not-URLs renders/exports, image fills, versions, fonts, and
// the 60 s watch poller. No test touches api.figma.com.

const FILE = "1abcDEF";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SESSION = { sessionKey: "sess-1", canRunLoopback: false };

function restFrame(id: string, name: string, x: number, y: number): Record<string, unknown> {
  return {
    id,
    name,
    type: "FRAME",
    absoluteBoundingBox: { x, y, width: 100, height: 200 },
    backgroundColor: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
  };
}

/** The GET /v1/files/:key?depth=2 shape these handlers read (figma-integration.md §3.1). */
function fileJson(version: string): Record<string, unknown> {
  return {
    name: "Marketing Site",
    version,
    lastModified: "2026-03-01T10:00:00Z",
    editorType: "figma",
    document: {
      id: "0:0",
      type: "DOCUMENT",
      name: "Document",
      children: [
        {
          id: "0:1",
          name: "Cover",
          type: "CANVAS",
          backgroundColor: { r: 0, g: 0, b: 0, a: 1 },
          children: [
            restFrame("1:2", "Hero", 20, 40),
            { id: "1:3", name: "Stray node", type: "RECTANGLE" }, // no absoluteBoundingBox
          ],
          // Flow starting points are carried by the CANVAS node (Get file nodes, §5.1).
          flowStartingPoints: [
            { nodeId: "1:2", name: "Hero" },
            { nodeId: "9:9", name: "Ghost" },
          ],
        },
        { id: "0:2", name: "Team", type: "CANVAS", children: [] },
      ],
    },
  };
}

/**
 * The GET /v1/files/:key/meta shape these handlers read: every field nested under `file`
 * (developers.figma.com file-endpoints — Get file metadata).
 */
function metaJson(version: string): Record<string, unknown> {
  return {
    file: {
      name: "Marketing Site",
      version,
      last_touched_at: "2026-03-01T10:00:00Z",
      thumbnail_url: "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/thumb-1abcDEF.png",
      editorType: "figma",
    },
  };
}

function linkedDocument(): FigmaNode {
  return {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "0:1",
        name: "Cover",
        type: "CANVAS",
        children: [restFrame("1:2", "Hero", 5, 6)],
        flowStartingPoints: [{ nodeId: "1:2", name: "Hero" }],
      },
    ],
  } as unknown as FigmaNode;
}

function utf16be(value: string): Buffer {
  return Buffer.from(value, "utf16le").swap16();
}

/** Minimal valid sfnt: one `name` table (plus optional empty extra tables) in a TTF header. */
function buildTtf(names: Record<number, string>, extraTables: string[] = []): Buffer {
  const entries = Object.entries(names).map(([nameId, value]) => ({
    nameId: Number(nameId),
    bytes: utf16be(value),
  }));
  const storageStart = 6 + entries.length * 12;
  let storageSize = 0;
  const records: Array<{ nameId: number; bytes: Buffer; offset: number }> = [];
  for (const entry of entries) {
    records.push({ ...entry, offset: storageSize });
    storageSize += entry.bytes.length;
  }
  const tables: Array<{ tag: string; data: Buffer }> = [
    { tag: "name", data: Buffer.alloc(0) },
    ...extraTables.map((tag) => ({ tag, data: Buffer.alloc(0) })),
  ];
  const nameTable = Buffer.alloc(storageStart + storageSize);
  nameTable.writeUInt16BE(0, 0);
  nameTable.writeUInt16BE(records.length, 2);
  nameTable.writeUInt16BE(storageStart, 4);
  records.forEach((record, index) => {
    const at = 6 + index * 12;
    nameTable.writeUInt16BE(3, at); // platform Windows
    nameTable.writeUInt16BE(1, at + 2);
    nameTable.writeUInt16BE(0x0409, at + 4);
    nameTable.writeUInt16BE(record.nameId, at + 6);
    nameTable.writeUInt16BE(record.bytes.length, at + 8);
    nameTable.writeUInt16BE(record.offset, at + 10);
  });
  let storageAt = storageStart;
  for (const record of records) {
    record.bytes.copy(nameTable, storageAt);
    storageAt += record.bytes.length;
  }
  tables[0].data = nameTable;
  const headerSize = 12 + tables.length * 16;
  const total = headerSize + tables.reduce((n, table) => n + table.data.length, 0);
  const font = Buffer.alloc(total);
  font.writeUInt32BE(0x0001_0000, 0);
  font.writeUInt16BE(tables.length, 4);
  let dataAt = headerSize;
  tables.forEach((table, index) => {
    const at = 12 + index * 16;
    font.write(table.tag, at, 4, "latin1");
    font.writeUInt32BE(0, at + 4);
    font.writeUInt32BE(dataAt, at + 8);
    font.writeUInt32BE(table.data.length, at + 12);
    table.data.copy(font, dataAt);
    dataAt += table.data.length;
  });
  return font;
}

interface Fixture {
  api: FakeFigmaApi;
  content: FigmaContent;
  handlers: FigmaHandlerMap<ContentRequestType>;
  home: string;
}

let home: string;
let fixture: Fixture;

function build(deps: ContentDeps = {}): Fixture {
  const api = makeFigmaApi({ home, logger: pino({ level: "silent" }) });
  api.store.addFile(makeFile(FILE));
  // The current version is resolved through Tier-3 meta and cached; prime it once per file.
  api.rest.respond(`/v1/files/${FILE}/meta`, metaJson("v1"));
  const content = new FigmaContent(deps);
  return { api, content, handlers: content.handlers(), home };
}

/** REST file fetch keyed by the version the handler asked for. */
function respondFile(version = "v1"): void {
  fixture.api.rest.respond(`/v1/files/${FILE}`, () => fileJson(version));
}

beforeEach(() => {
  vi.useFakeTimers();
  home = mkdtempSync(path.join(os.tmpdir(), "jad-figma-content-"));
  fixture = build();
});

afterEach(() => {
  fixture.content.watches.dispose();
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe("page-scoped outlines", () => {
  const request = (options: { pagesOnly?: boolean; pageId?: string; version?: string }) =>
    fixture.handlers["figma.file.outline.request"](
      { type: "figma.file.outline.request", requestId: "page", fileKey: FILE, ...options },
      fixture.api.ctx,
      SESSION,
    );
  const respondPage = (version = "v1", type = "CANVAS") => {
    fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, {
      version,
      nodes: {
        "0:1": {
          document: {
            id: "0:1",
            name: "<page>",
            type,
            children: [restFrame("1:2", "<frame>", 20, 40)],
            flowStartingPoints: [],
          },
        },
      },
    });
  };
  it("reads only the page index and distinguishes unloaded pages from empty ones", async () => {
    respondFile();
    const result = await request({ pagesOnly: true });
    expect(result.outline?.pages[0]).toMatchObject({ childrenLoaded: false, frames: [] });
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)[0]?.query).toEqual({
      depth: 1,
      version: "v1",
    });
  });
  it("loads only the requested page, caches it separately, and keeps legacy outlines complete", async () => {
    respondFile();
    respondPage();
    const result = await request({ pageId: "0:1", version: "v1" });
    expect(result.outline?.pages.map((page) => page.id)).toEqual(["0:1"]);
    expect(result.outline?.pages[0]).toMatchObject({
      childrenLoaded: true,
      frames: [{ id: "1:2" }],
    });
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`)[0]?.query).toEqual({
      ids: "0:1",
      depth: 2,
      version: "v1",
    });
    expect(await request({ pageId: "0:1", version: "v1" })).toEqual(result);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`)).toHaveLength(1);
    const full = await request({ version: "v1" });
    expect(full.outline?.pages.map((page) => page.id)).toEqual(["0:1", "0:2"]);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`).map((call) => call.query?.depth)).toEqual([
      1, 3,
    ]);
  });
  it("reuses a cached legacy snapshot without mutating it or calling REST again", async () => {
    respondFile();
    const full = await request({ version: "v1" });
    const before = fixture.api.rest.calls.length;
    const index = await request({ version: "v1", pagesOnly: true });
    const page = await request({ version: "v1", pageId: "0:1" });
    expect(
      index.outline?.pages.every((entry) => !entry.frames.length && entry.childrenLoaded === false),
    ).toBe(true);
    expect(page.outline?.pages[0]?.frames).toEqual(full.outline?.pages[0]?.frames);
    expect(full.outline?.pages[0]?.childrenLoaded).toBeUndefined();
    expect(fixture.api.rest.calls).toHaveLength(before);
  });
  it.each([
    { pageId: "0:1" },
    { pageId: "0:1", version: " " },
    { pagesOnly: true, pageId: "0:1", version: "v1" },
    { pagesOnly: true, version: " " },
  ])("rejects invalid scope before a network read: %j", async (options) => {
    await expect(request(options)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fixture.api.rest.calls).toEqual([]);
  });
  it("rejects an unknown page before requesting any node tree", async () => {
    respondFile();
    await expect(request({ pageId: "0:9", version: "v1" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`)).toEqual([]);
  });
  it("rejects page content from another version", async () => {
    respondFile();
    respondPage("v2");
    await expect(request({ pageId: "0:1", version: "v1" })).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("rejects non-page node content", async () => {
    respondFile();
    respondPage("v1", "SECTION");
    await expect(request({ pageId: "0:1", version: "v1" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  // ── snapshot validation (ADR-0043): a cached entry or a fresh answer that does not carry
  // the exact requested (fileKey, version) must never be served as that snapshot. ──
  const staleOutline = (version: string) => ({
    fileKey: FILE,
    name: "Marketing Site",
    version,
    lastModified_ms: 0,
    editorType: "figma",
    source: "rest",
    pages: [{ id: "0:1", name: "Stale", frames: [], flowStartingPoints: [] }],
  });

  it("does not serve a cached full outline that belongs to another snapshot", async () => {
    respondFile();
    await fixture.api.ctx.cache.putJson(`file/${FILE}/outline-d3@v1`, { data: staleOutline("v2") });
    const result = await request({ version: "v1" });
    expect(result.outline?.version).toBe("v1");
    expect(result.outline?.pages.map((page) => page.id)).toEqual(["0:1", "0:2"]);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(1);
  });

  it("rejects a fresh full outline answered from another version", async () => {
    fixture.api.rest.respond(`/v1/files/${FILE}`, () => fileJson("v2"));
    await expect(request({ version: "v1" })).rejects.toMatchObject({ code: "conflict" });
    respondFile();
    const result = await request({ version: "v1" });
    expect(result.outline?.version).toBe("v1");
  });

  it("recomputes a page index cached under a mismatched snapshot", async () => {
    respondFile();
    await fixture.api.ctx.cache.putJson(`file/${FILE}/page-index@v1`, {
      data: staleOutline("v2"),
    });
    const result = await request({ version: "v1", pagesOnly: true });
    expect(result.outline?.version).toBe("v1");
    expect(result.outline?.pages[0]).toMatchObject({ id: "0:1", childrenLoaded: false });
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(1);
  });

  it("recomputes a page outline cached under a mismatched snapshot", async () => {
    respondFile();
    respondPage();
    await fixture.api.ctx.cache.putJson(`file/${FILE}/page-outline/0:1@v1`, {
      data: staleOutline("v2"),
    });
    const result = await request({ pageId: "0:1", version: "v1" });
    expect(result.outline?.version).toBe("v1");
    expect(result.outline?.pages[0]).toMatchObject({
      childrenLoaded: true,
      frames: [{ id: "1:2" }],
    });
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`)).toHaveLength(1);
  });

  it("rejects page index content from another version", async () => {
    fixture.api.rest.respond(`/v1/files/${FILE}`, () => fileJson("v2"));
    await expect(request({ version: "v1", pagesOnly: true })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it.each([
    {}, // no document at all
    { name: "x", version: "v1", document: {} }, // document without children
    { name: "x", version: "v1", document: { id: "0:0", type: "DOCUMENT" } },
  ])("rejects a malformed file answer without caching it: %j", async (body) => {
    fixture.api.rest.respond(`/v1/files/${FILE}`, () => body);
    await expect(request({ version: "v1" })).rejects.toMatchObject({ code: "figma_error" });
    // The malformed answer must not poison the cache: a good answer after it is served fresh.
    respondFile();
    const result = await request({ version: "v1" });
    expect(result.outline?.pages.map((page) => page.id)).toEqual(["0:1", "0:2"]);
  });

  it("keeps a genuine empty children array a valid empty file", async () => {
    fixture.api.rest.respond(`/v1/files/${FILE}`, () => ({
      name: "Empty",
      version: "v1",
      lastModified: "2026-03-01T10:00:00Z",
      editorType: "figma",
      document: { id: "0:0", type: "DOCUMENT", name: "Document", children: [] },
    }));
    const result = await request({ version: "v1" });
    expect(result.outline?.version).toBe("v1");
    expect(result.outline?.pages).toEqual([]);
  });

  it("rejects a page answer without a children array instead of faking a loaded page", async () => {
    respondFile();
    fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, {
      version: "v1",
      nodes: {
        "0:1": {
          document: { id: "0:1", name: "<page>", type: "CANVAS", flowStartingPoints: [] },
        },
      },
    });
    await expect(request({ pageId: "0:1", version: "v1" })).rejects.toMatchObject({
      code: "figma_error",
    });
    expect(await fixture.api.ctx.cache.getJson(`file/${FILE}/page-outline/0:1@v1`)).toBeNull();
  });
});

describe("preview export grouping boundaries", () => {
  it("never groups different pinned versions into the same upstream export", async () => {
    vi.useRealTimers();
    fixture.api.rest.respond(`/v1/images/${FILE}`, ({ query }) => ({
      images: { "1:2": `<render-${query.version}>` },
    }));
    fixture.api.rest.provideBytes("<render-v1>", { mimeType: "image/png", data: PNG });
    fixture.api.rest.provideBytes("<render-v2>", {
      mimeType: "image/png",
      data: Buffer.from("<version-2-bytes>"),
    });
    const request = (version: string) =>
      fixture.handlers["figma.file.render.request"](
        {
          type: "figma.file.render.request",
          requestId: version,
          fileKey: FILE,
          ids: ["1:2"],
          version,
          scale: 0.25,
          format: "png",
          useAbsoluteBounds: true,
        },
        fixture.api.ctx,
      );
    const [first, second] = await Promise.all([request("v1"), request("v2")]);
    expect(first.images["1:2"]?.dataBase64).toBe(PNG.toString("base64"));
    expect(second.images["1:2"]?.dataBase64).toBe(
      Buffer.from("<version-2-bytes>").toString("base64"),
    );
    expect(
      fixture.api.rest
        .callsTo(`/v1/images/${FILE}`)
        .map((call) => call.query?.version)
        .sort(),
    ).toEqual(["v1", "v2"]);
  });
});

describe("cached-only render reads", () => {
  it("returns exact cache hits and null misses without metadata, render, or Link calls", async () => {
    await fixture.api.ctx.cache.putBytes(`render-rest/${FILE}/1:2@0.25x@png@absolute@v1`, {
      mimeType: "image/png",
      data: PNG,
    });
    await fixture.api.ctx.cache.putBytes(`render-rest/${FILE}/1:3@0.25x@png@v1`, {
      mimeType: "image/png",
      data: PNG,
    });
    const result = await fixture.handlers["figma.file.render.request"](
      {
        type: "figma.file.render.request",
        requestId: "cached",
        fileKey: FILE,
        ids: ["1:2", "1:3", "1:4"],
        scale: 0.25,
        format: "png",
        useAbsoluteBounds: true,
        version: "v1",
        cachedOnly: true,
      },
      fixture.api.ctx,
    );
    expect(result.images["1:2"]?.dataBase64).toBe(PNG.toString("base64"));
    expect(result.images["1:3"]).toBeNull();
    expect(result.images["1:4"]).toBeNull();
    expect(fixture.api.rest.calls).toHaveLength(0);
    const other = await fixture.handlers["figma.file.render.request"](
      {
        type: "figma.file.render.request",
        requestId: "other",
        fileKey: FILE,
        ids: ["1:2"],
        scale: 0.25,
        format: "png",
        useAbsoluteBounds: true,
        version: "v2",
        cachedOnly: true,
      },
      fixture.api.ctx,
    );
    expect(other.images["1:2"]).toBeNull();
    expect(fixture.api.rest.calls).toHaveLength(0);
  });

  it("rejects an implicit version before resolving metadata", async () => {
    await expect(
      fixture.handlers["figma.file.render.request"](
        {
          type: "figma.file.render.request",
          requestId: "cached",
          fileKey: FILE,
          ids: ["1:2"],
          scale: 1,
          cachedOnly: true,
        },
        fixture.api.ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fixture.api.rest.calls).toHaveLength(0);
  });
});

describe("parallel frame text outlines", () => {
  it.each([false, true])(
    "starts a frame SVG before nodes arrive with a page-only outline cache: %s",
    async (pageOnly) => {
      respondFile();
      const ctx = fixture.api.ctx;
      await fixture.handlers["figma.file.outline.request"](
        {
          type: "figma.file.outline.request",
          requestId: "outline",
          fileKey: FILE,
          ...(pageOnly ? { pagesOnly: true } : {}),
        },
        ctx,
        SESSION,
      );
      if (pageOnly) {
        fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, {
          version: "v1",
          nodes: {
            "0:1": { document: (fileJson("v1").document as { children: unknown[] }).children[0] },
          },
        });
        await fixture.handlers["figma.file.outline.request"](
          {
            type: "figma.file.outline.request",
            requestId: "page",
            fileKey: FILE,
            pageId: "0:1",
            version: "v1",
          },
          ctx,
          SESSION,
        );
      }
      const glyph: FigmaNode = {
        id: "text_a",
        type: "TEXT",
        name: "<text>",
        absoluteBoundingBox: { x: 30, y: 55, width: 20, height: 10 },
        fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
      };
      const frame = { ...restFrame("1:2", "<frame>", 20, 40), children: [glyph] };
      fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, {
        version: "v1",
        nodes: { "1:2": { document: frame } },
      });
      fixture.api.rest.respond(`/v1/images/${FILE}`, { images: { "1:2": "<frame-svg-url>" } });
      fixture.api.rest.provideBytes("<frame-svg-url>", {
        mimeType: "image/svg+xml",
        data: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><g data-node-id="text_a"><path d="M10 15h20v10H10Z" fill="#000"/></g></svg>',
        ),
      });
      let exported!: () => void;
      const ready = new Promise<void>((resolve) => {
        exported = resolve;
      });
      const disk = ctx.cache;
      ctx.cache = {
        getJson: (key) => disk.getJson(key),
        putJson: (key, data) => disk.putJson(key, data),
        getBytes: (key) => disk.getBytes(key),
        putBytes: async (key, bytes) => {
          await disk.putBytes(key, bytes);
          if (key.startsWith("text-frame-svg/")) exported();
        },
      };
      const rest = fixture.api.rest;
      ctx.rest = {
        getJson: async (input) => {
          if (input.path.endsWith("/nodes")) await ready;
          return rest.getJson(input);
        },
        sendJson: () => rest.sendJson(),
        getBytes: (url) => rest.getBytes(url),
        budget: () => rest.budget(),
      };
      const response = await fixture.handlers["figma.file.nodes.request"](
        {
          type: "figma.file.nodes.request",
          requestId: "nodes",
          fileKey: FILE,
          ids: ["1:2"],
          version: "v1",
          prepareTextOutlines: true,
        },
        ctx,
        SESSION,
      );
      expect(response.nodes["1:2"]?.id).toBe("1:2");
      const cached = await disk.getBytes(`render-rest/${FILE}/text_a@1x@svg@absolute@v1`);
      expect(cached?.mimeType).toBe("image/svg+xml");
      expect(cached?.data.toString("utf8")).toContain("translate(-10 -15)");
      const result = await fixture.handlers["figma.file.render.request"](
        {
          type: "figma.file.render.request",
          requestId: "glyph",
          fileKey: FILE,
          ids: ["text_a"],
          version: "v1",
          scale: 1,
          format: "svg",
          useAbsoluteBounds: true,
        },
        ctx,
        SESSION,
      );
      expect(result.images.text_a?.dataBase64).toBe(cached?.data.toString("base64"));
      expect(rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(1);
      expect(rest.callsTo(`/v1/images/${FILE}`)[0]?.query).toEqual({
        ids: "1:2",
        version: "v1",
        scale: 1,
        format: "svg",
        svg_outline_text: "true",
        svg_include_node_id: "true",
        use_absolute_bounds: "true",
      });
    },
  );

  it.each([
    "ordinary-first",
    "prepared-first",
    "unsupported-preparation",
    "ordinary-error",
  ] as const)("preserves the first complete render result: %s", async (order) => {
    respondFile();
    const ctx = fixture.api.ctx;
    await fixture.handlers["figma.file.outline.request"](
      { type: "figma.file.outline.request", requestId: "outline", fileKey: FILE },
      ctx,
      SESSION,
    );
    const glyph: FigmaNode = {
      id: "text_a",
      type: "TEXT",
      name: "<text>",
      absoluteBoundingBox: { x: 30, y: 55, width: 20, height: 10 },
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    };
    fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, {
      version: "v1",
      nodes: {
        "1:2": {
          document: {
            ...restFrame("1:2", "<frame>", 20, 40),
            children: [glyph],
          },
        },
      },
    });
    fixture.api.rest.respond(`/v1/images/${FILE}`, ({ query }) => ({
      images: {
        [String(query.ids)]: String(query.ids) === "1:2" ? "<frame-svg>" : "<direct-svg>",
      },
    }));
    let finishFrame!: () => void;
    let finishDirect!: () => void;
    let directStarted!: () => void;
    const frameGate = new Promise<void>((resolve) => {
      finishFrame = resolve;
    });
    const directGate = new Promise<void>((resolve) => {
      finishDirect = resolve;
    });
    const requestedDirect = new Promise<void>((resolve) => {
      directStarted = resolve;
    });
    const directSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M0 0h20v10Z"/></svg>';
    const frameSvg =
      order === "unsupported-preparation"
        ? "<svg/>"
        : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><g data-node-id="text_a"><path d="M10 15h20v10H10Z" fill="#000"/></g></svg>';
    const rest = fixture.api.rest;
    ctx.rest = {
      getJson: (input) => {
        if (
          order === "ordinary-error" &&
          input.path.endsWith(`/images/${FILE}`) &&
          input.query?.ids === "text_a"
        ) {
          directStarted();
          return Promise.reject(new Error("Direct export failed"));
        }
        return rest.getJson(input);
      },
      sendJson: () => rest.sendJson(),
      budget: () => rest.budget(),
      getBytes: async (url) => {
        if (url === "<frame-svg>") {
          await frameGate;
          return { mimeType: "image/svg+xml", data: Buffer.from(frameSvg) };
        }
        directStarted();
        await directGate;
        return { mimeType: "image/svg+xml", data: Buffer.from(directSvg) };
      },
    };
    // The node response must finish even though frame export is still pending.
    await fixture.handlers["figma.file.nodes.request"](
      {
        type: "figma.file.nodes.request",
        requestId: "nodes",
        fileKey: FILE,
        ids: ["1:2"],
        version: "v1",
        prepareTextOutlines: true,
      },
      ctx,
      SESSION,
    );
    const rendered = fixture.handlers["figma.file.render.request"](
      {
        type: "figma.file.render.request",
        requestId: "glyph",
        fileKey: FILE,
        ids: ["text_a"],
        version: "v1",
        scale: 1,
        format: "svg",
        useAbsoluteBounds: true,
      },
      ctx,
      SESSION,
    );
    await requestedDirect;
    try {
      if (order === "ordinary-error") {
        await expect(rendered).rejects.toThrow("Direct export failed");
        return;
      }
      if (order === "prepared-first") finishFrame();
      else {
        if (order === "unsupported-preparation") finishFrame();
        finishDirect();
      }
      const result = await rendered;
      const svg = Buffer.from(result.images.text_a!.dataBase64, "base64").toString("utf8");
      if (order === "prepared-first") expect(svg).toContain("translate(-10 -15)");
      else expect(svg).toBe(directSvg);
    } finally {
      finishFrame();
      finishDirect();
      await rendered.catch(() => undefined);
    }
  });

  it("does not speculate about unknown IDs or fetch an outline to enable prefetch", async () => {
    fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, {
      version: "v1",
      nodes: { "1:2": { document: restFrame("1:2", "<frame>", 20, 40) } },
    });
    await fixture.handlers["figma.file.nodes.request"](
      {
        type: "figma.file.nodes.request",
        requestId: "nodes",
        fileKey: FILE,
        ids: ["1:2"],
        version: "v1",
        prepareTextOutlines: true,
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(0);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(0);
  });
});

describe("outline", () => {
  it("maps pages, top-level frame bounds, #RRGGBBAA colors and flow starting points", async () => {
    respondFile();
    const { outline } = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    expect(outline).not.toBeNull();
    expect(outline!.name).toBe("Marketing Site");
    expect(outline!.version).toBe("v1");
    expect(outline!.source).toBe("rest");
    expect(outline!.lastModified_ms).toBe(Date.parse("2026-03-01T10:00:00Z"));
    expect(outline!.pages.map((page) => page.id)).toEqual(["0:1", "0:2"]);
    const cover = outline!.pages[0];
    expect(cover.backgroundColor).toBe("#000000ff");
    // Only nodes with bounds become frames; the stray rectangle is skipped.
    expect(cover.frames).toEqual([
      {
        id: "1:2",
        name: "Hero",
        type: "FRAME",
        bounds: { x: 20, y: 40, width: 100, height: 200 },
        backgroundColor: "#1a334dff",
      },
    ]);
    expect(cover.flowStartingPoints).toEqual([
      { nodeId: "1:2", name: "Hero" },
      { nodeId: "9:9", name: "Ghost" },
    ]);
    expect(outline!.pages[1].frames).toEqual([]);
  });

  it("serves a repeat request from the cache with no second REST call", async () => {
    respondFile();
    const first = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    const callsBefore = fixture.api.rest.calls.length;
    const second = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    expect(second.outline).toEqual(first.outline);
    expect(fixture.api.rest.calls.length).toBe(callsBefore);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(1);
  });

  it("reads an explicit ?version= directly, without a Tier-3 meta lookup", async () => {
    fixture.api.rest.respond(`/v1/files/${FILE}`, () => fileJson("v9"));
    const metaCallsBefore = fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`).length;
    const { outline } = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE, version: "v9" },
      fixture.api.ctx,
      SESSION,
    );
    expect(outline!.version).toBe("v9");
    const calls = fixture.api.rest.callsTo(`/v1/files/${FILE}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toMatchObject({ version: "v9", depth: 3 });
    expect(calls[0].tier).toBe("1");
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(metaCallsBefore);
  });

  it("serves a pinned version from REST only, even while the plugin holds a newer document", async () => {
    // 32.1 snapshot rule: the live plugin document answers for whatever version is open in
    // Figma now. isLinked must not let it stand in for history — the pinned read goes straight
    // to the versioned depth-3 REST call and the plugin is never even consulted.
    fixture.api.link.linked.add(FILE);
    fixture.api.link.getNodesImpl = (requested) =>
      requested.includes("0:0") ? { "0:0": linkedDocument() } : {};
    fixture.api.rest.respond(`/v1/files/${FILE}`, () => fileJson("v9"));
    const { outline } = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE, version: "v9" },
      fixture.api.ctx,
      SESSION,
    );
    expect(outline!.source).toBe("rest");
    expect(outline!.version).toBe("v9");
    expect(outline!.name).toBe("Marketing Site"); // not the plugin's newer live hierarchy
    expect(outline!.pages[0].frames[0].bounds).toEqual({ x: 20, y: 40, width: 100, height: 200 });
    expect(fixture.api.link.toolCalls).toHaveLength(0);
    const calls = fixture.api.rest.callsTo(`/v1/files/${FILE}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toMatchObject({ version: "v9", depth: 3 });
  });

  it("serves a pinned version from REST when the plugin document read would throw", async () => {
    // getNodesImpl unset → the fake throws "unsupported"; a pinned read must not care.
    fixture.api.link.linked.add(FILE);
    respondFile("v9");
    const { outline } = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE, version: "v9" },
      fixture.api.ctx,
      SESSION,
    );
    expect(outline!.source).toBe("rest");
    expect(outline!.version).toBe("v9");
    expect(fixture.api.link.toolCalls).toHaveLength(0);
  });

  it("prefers the plugin document while the file is linked", async () => {
    fixture.api.link.linked.add(FILE);
    fixture.api.link.getNodesImpl = (requested): Record<string, FigmaNode | null> =>
      requested.includes("0:0") ? { "0:0": linkedDocument() } : {};
    const { outline } = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    expect(outline!.source).toBe("link");
    expect(outline!.pages[0].frames[0].bounds).toEqual({
      x: 5,
      y: 6,
      width: 100,
      height: 200,
    });
    // The plugin hands over the same document shape REST returns: starting points live on the
    // CANVAS node, without a pageId.
    expect(outline!.pages[0].flowStartingPoints).toEqual([{ nodeId: "1:2", name: "Hero" }]);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(0);
  });

  it("falls back to REST when the plugin cannot answer", async () => {
    fixture.api.link.linked.add(FILE);
    // getNodesImpl unset → the fake throws "unsupported", like a plugin without document read.
    respondFile();
    const { outline } = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    expect(outline!.source).toBe("rest");
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(1);
  });

  it("fails with not_found for a file the daemon has never added", async () => {
    await expect(
      fixture.handlers["figma.file.outline.request"](
        { requestId: "r1", type: "figma.file.outline.request", fileKey: "missing" },
        fixture.api.ctx,
        SESSION,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("nodes", () => {
  const batchIds = Array.from({ length: 12 }, (_, i) => `1:${i + 1}`);

  function respondNodes(): void {
    // GET /v1/files/:key/nodes documented shape (developers.figma.com file-endpoints): each id
    // maps to `{ document, components, componentSets, styles, schemaVersion }` (or null), the
    // library maps live on the entry, and `err` is present on success.
    fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, ({ query }) => {
      const batch = (query.ids ?? "").split(",");
      return {
        err: null,
        name: "Marketing Site",
        role: "owner",
        lastModified: "2026-03-01T10:00:00Z",
        thumbnailUrl: "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/thumb-1abcDEF.png",
        version: "v1",
        nodes: Object.fromEntries(
          batch.map((id) =>
            id === "1:12"
              ? [id, null]
              : [
                  id,
                  {
                    document: {
                      id,
                      name: `Node ${id}`,
                      type: "TEXT",
                      absoluteBoundingBox: { x: 20, y: 40, width: 100, height: 20 },
                      componentId: "1:1",
                    },
                    components: {
                      "1:1": {
                        key: "ck1",
                        file_key: FILE,
                        name: "Button",
                        description: "",
                        remote: false,
                      },
                    },
                    componentSets: {},
                    styles: {
                      "1:1": {
                        key: "sk1",
                        name: "H1",
                        styleType: "TEXT",
                        description: "",
                      },
                    },
                    schemaVersion: 1,
                  },
                ],
          ),
        ),
        components: {
          "1:1": { key: "ck1", name: "Button", remote: false },
          "1:13": { key: "ck2", name: "Team Button", remote: true },
          "1:14": { key: "ck3", name: "Legacy" },
        },
        styles: { "1:1": { key: "sk1", name: "H1", styleType: "TEXT" } },
      };
    });
  }

  /** The plugin's live tree, named so it cannot be confused with REST data. */
  function liveNodesResponder(requested: string[]): Record<string, FigmaNode | null> {
    const found: Record<string, FigmaNode | null> = {};
    for (const id of requested)
      found[id] = { id, name: `Live ${id}`, type: "TEXT" } as unknown as FigmaNode;
    return found;
  }

  /** Echoes the requested version into every document, proving the pin went to REST as-is. */
  function pinnedNodesResponder({ query }: { query: Record<string, string> }): unknown {
    const entries = (query.ids ?? "")
      .split(",")
      .map((id) => [id, { document: { id, name: `Pinned ${query.version}`, type: "TEXT" } }]);
    return { nodes: Object.fromEntries(entries) };
  }

  it("batches ids into multi-id Tier-1 requests and returns components/styles", async () => {
    respondNodes();
    const out = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r1",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: batchIds,
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    const calls = fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`);
    expect(calls).toHaveLength(2); // 12 ids at the default batch size of 10
    expect(calls.map((call) => String(call.query?.ids ?? "").split(","))).toEqual([
      batchIds.slice(0, 10),
      batchIds.slice(10),
    ]);
    expect(calls.every((call) => call.tier === "1")).toBe(true);
    expect(out.source).toBe("rest");
    expect(out.nodes["1:1"]).toMatchObject({ name: "Node 1:1" });
    expect(out.nodes["1:12"]).toBeNull();
    expect(out.components["1:1"]).toEqual({ key: "ck1", name: "Button", remote: false });
    expect(out.components["1:13"]).toEqual({ key: "ck2", name: "Team Button", remote: true });
    expect(out.components["1:14"]).toEqual({ key: "ck3", name: "Legacy" });
    expect(out.styles["1:1"]).toEqual({ key: "sk1", name: "H1", styleType: "TEXT" });
  });

  it("asks for geometry=paths and hands back the entry document, boxes included", async () => {
    respondNodes();
    const out = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r1",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: ["1:1"],
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    const call = fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`)[0];
    // Vector paint data is only returned when the request opts into it — the app's redraw needs
    // it, so the daemon must always ask (figma-integration.md §3.1).
    expect(call.query).toMatchObject({ ids: "1:1", geometry: "paths", version: "v1" });
    // The entry's `document` is the node, not the `{ document, components, … }` wrapper.
    expect(out.nodes["1:1"]).toMatchObject({
      id: "1:1",
      name: "Node 1:1",
      type: "TEXT",
      absoluteBoundingBox: { x: 20, y: 40, width: 100, height: 20 },
      componentId: "1:1",
    });
    // Entry-level library maps merge into the response's components/styles.
    expect(out.components["1:1"]).toEqual({ key: "ck1", name: "Button", remote: false });
    expect(out.styles["1:1"]).toEqual({ key: "sk1", name: "H1", styleType: "TEXT" });
  });

  it("answers a repeat request entirely from the cache, unknown nodes included", async () => {
    respondNodes();
    const first = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r1",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: batchIds,
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    const callsBefore = fixture.api.rest.calls.length;
    const second = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r1",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: batchIds,
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(second.nodes).toEqual(first.nodes);
    expect(fixture.api.rest.calls.length).toBe(callsBefore);
    // A request containing only cached ids (known and unknown) asks for nothing.
    const third = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r1",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: ["1:1", "1:12"],
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(third.nodes["1:12"]).toBeNull();
    expect(fixture.api.rest.calls.length).toBe(callsBefore);
  });

  it("serves live subtrees from the plugin while linked, REST otherwise", async () => {
    fixture.api.link.linked.add(FILE);
    fixture.api.link.getNodesImpl = (requested) => {
      const found: Record<string, FigmaNode | null> = {};
      for (const id of requested)
        found[id] =
          id === "1:1" ? ({ id, name: "Live", type: "TEXT" } as unknown as FigmaNode) : null;
      return found;
    };
    const out = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r1",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: ["1:1", "1:2"],
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(out.source).toBe("link");
    expect(out.nodes["1:1"]).toMatchObject({ name: "Live" });
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`)).toHaveLength(0);

    // All-null from the link is treated as no answer → REST (still cached per version).
    respondNodes();
    fixture.api.link.getNodesImpl = () => ({ "1:1": null, "1:2": null });
    const viaRest = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r1",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: ["1:1", "1:2"],
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(viaRest.nodes["1:1"]).toMatchObject({ name: "Node 1:1" });
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`)).toHaveLength(1);
  });

  it("serves an explicit version from REST even while the plugin is linked", async () => {
    // A pinned version is a snapshot request (ADR-0037): the live plugin tree belongs to
    // whatever version is open in Figma now, so answering with it would silently present
    // current data as history. REST + cache answer for that exact version instead — with no
    // Tier-3 meta, no whole-document fetch, and only the requested ids.
    fixture.api.link.linked.add(FILE);
    fixture.api.link.getNodesImpl = liveNodesResponder;
    fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, pinnedNodesResponder);
    const out = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r1",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: ["1:1"],
        version: "v9",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(out.source).toBe("rest");
    expect(out.nodes["1:1"]).toMatchObject({ name: "Pinned v9" });
    const calls = fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toMatchObject({ ids: "1:1", version: "v9" });
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(0);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(0);
    expect(fixture.api.link.toolCalls.filter((call) => call.tool === "getNodes")).toHaveLength(0);
  });

  it("falls back to REST when the plugin throws", async () => {
    fixture.api.link.linked.add(FILE);
    respondNodes();
    const out = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r1",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: ["1:1"],
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(out.source).toBe("rest");
    expect(out.nodes["1:1"]).toMatchObject({ name: "Node 1:1" });
  });
});

describe("render", () => {
  function respondRender(): void {
    fixture.api.rest.respond(`/v1/images/${FILE}`, ({ query }) => {
      const images: Record<string, string> = {};
      for (const id of (query.ids ?? "").split(","))
        if (id !== "1:404") images[id] = `https://s3.test/${id}`;
      return { images };
    });
    for (const id of ["1:2", "1:3"]) {
      fixture.api.rest.provideBytes(`https://s3.test/${id}`, {
        mimeType: "image/png",
        data: PNG,
      });
    }
  }

  it("returns bytes, never the Figma URLs, and caches them per node@scale@version", async () => {
    respondRender();
    const first = await fixture.handlers["figma.file.render.request"](
      {
        requestId: "r1",
        type: "figma.file.render.request",
        fileKey: FILE,
        ids: ["1:2", "1:3"],
        scale: 2,
        format: "png",
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(first.source).toBe("rest");
    expect(first.images["1:2"]).not.toBeNull();
    expect([...Buffer.from(first.images["1:2"]!.dataBase64, "base64")]).toEqual([...PNG]);
    expect(first.images["1:2"]!.mimeType).toBe("image/png");
    expect(first.images["1:2"]!.dataBase64).not.toContain("s3.test");

    const callCount = fixture.api.rest.calls.length;
    const byteCount = fixture.api.rest.byteCalls.length;
    const second = await fixture.handlers["figma.file.render.request"](
      {
        requestId: "r1",
        type: "figma.file.render.request",
        fileKey: FILE,
        ids: ["1:2", "1:3"],
        scale: 2,
        format: "png",
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(second.images["1:2"]).toEqual(first.images["1:2"]);
    // No second request for either the image endpoint or the bytes.
    expect(fixture.api.rest.calls.length).toBe(callCount);
    expect(fixture.api.rest.byteCalls.length).toBe(byteCount);
  });

  it("returns null for ids Figma has no render for, without asking again", async () => {
    respondRender();
    const missing = await fixture.handlers["figma.file.render.request"](
      {
        requestId: "r1",
        type: "figma.file.render.request",
        fileKey: FILE,
        ids: ["1:404"],
        scale: 1,
        format: "png",
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(missing.images["1:404"]).toBeNull();
    const callCount = fixture.api.rest.calls.length;
    await fixture.handlers["figma.file.render.request"](
      {
        requestId: "r1",
        type: "figma.file.render.request",
        fileKey: FILE,
        ids: ["1:404"],
        scale: 1,
        format: "png",
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    // Unknown renders are not cache entries (only bytes cache), so a re-ask is fine but must
    // stay a single Tier-1 batch.
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(2);
    expect(callCount).toBeGreaterThan(0);
  });

  it("exports through the plugin while linked and caches the result", async () => {
    respondRender();
    fixture.api.link.linked.add(FILE);
    fixture.api.link.exportImpl = () => ({ mimeType: "image/png", data: PNG });
    // Unversioned: the live read keeps its Live Link semantics (32.1) — version resolved current.
    const first = await fixture.handlers["figma.file.render.request"](
      {
        requestId: "r1",
        type: "figma.file.render.request",
        fileKey: FILE,
        ids: ["1:2"],
        scale: 2,
        format: "png",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(first.source).toBe("link");
    expect([...Buffer.from(first.images["1:2"]!.dataBase64, "base64")]).toEqual([...PNG]);
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(0);
    const toolCalls = fixture.api.link.toolCalls.length;
    await fixture.handlers["figma.file.render.request"](
      {
        requestId: "r1",
        type: "figma.file.render.request",
        fileKey: FILE,
        ids: ["1:2"],
        scale: 2,
        format: "png",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(fixture.api.link.toolCalls).toHaveLength(toolCalls); // cached on disk
  });

  it("serves an explicit version from the versioned REST call, never the plugin, while linked", async () => {
    respondRender();
    fixture.api.link.linked.add(FILE);
    fixture.api.link.exportImpl = () => {
      throw new Error("live plugin raster must not answer a pinned version");
    };
    const out = await fixture.handlers["figma.file.render.request"](
      {
        requestId: "r1",
        type: "figma.file.render.request",
        fileKey: FILE,
        ids: ["1:2"],
        scale: 2,
        format: "png",
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(out.source).toBe("rest");
    expect([...Buffer.from(out.images["1:2"]!.dataBase64, "base64")]).toEqual([...PNG]);
    expect(out.images["1:2"]!.mimeType).toBe("image/png");
    expect(fixture.api.link.toolCalls).toHaveLength(0);
    const calls = fixture.api.rest.callsTo(`/v1/images/${FILE}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toMatchObject({ ids: "1:2", scale: 2, format: "png", version: "v1" });
  });

  it("keeps live plugin bytes and pinned snapshot bytes in separate cache namespaces", async () => {
    const LIVE = Buffer.from([0x4c, 0x69, 0x76, 0x65]); // distinguishable from PNG
    respondRender();
    fixture.api.link.linked.add(FILE);
    let exports = 0;
    fixture.api.link.exportImpl = () => {
      exports += 1;
      return { mimeType: "image/png", data: LIVE };
    };

    // Live unversioned read rasterizes through the plugin and caches its bytes under the
    // current version… the same version string a pinned request could name.
    const live = await render();
    expect(live.source).toBe("link");
    expect([...Buffer.from(live.images["1:2"]!.dataBase64, "base64")]).toEqual([...LIVE]);

    // A pinned request must NOT be answered by those unverified plugin bytes: REST + S3 fetch.
    const pinned = await render("v1");
    expect(pinned.source).toBe("rest");
    expect([...Buffer.from(pinned.images["1:2"]!.dataBase64, "base64")]).toEqual([...PNG]);
    expect(exports).toBe(1);
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(1);

    // Both namespaces then serve their own kind from disk without any network or plugin call.
    const liveAgain = await render();
    const pinnedAgain = await render("v1");
    expect([...Buffer.from(liveAgain.images["1:2"]!.dataBase64, "base64")]).toEqual([...LIVE]);
    expect([...Buffer.from(pinnedAgain.images["1:2"]!.dataBase64, "base64")]).toEqual([...PNG]);
    expect(exports).toBe(1);
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(1);
  });

  it("does not consume a legacy pre-upgrade render/ entry for a pinned snapshot", async () => {
    respondRender();
    // Released code cached the plugin's LIVE raster bytes under plain `render/...@version`.
    // The verified-REST path must ignore that mixed-source namespace entirely rather than
    // trust a pre-upgrade entry as history: the pinned request still fetches from Tier-1.
    await fixture.api.ctx.cache.putBytes(`render/${FILE}/1:2@2x@png@v1`, {
      mimeType: "image/png",
      data: Buffer.from([0x4c, 0x69, 0x76, 0x65]),
    });
    fixture.api.link.linked.add(FILE);
    fixture.api.link.exportImpl = () => {
      throw new Error("legacy live bytes must not answer a pinned request");
    };
    const out = await render("v1");
    expect(out.source).toBe("rest");
    expect([...Buffer.from(out.images["1:2"]!.dataBase64, "base64")]).toEqual([...PNG]);
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(1);
    expect(fixture.api.link.toolCalls).toHaveLength(0);
  });

  async function render(version?: string) {
    return fixture.handlers["figma.file.render.request"](
      {
        requestId: "r1",
        type: "figma.file.render.request",
        fileKey: FILE,
        ids: ["1:2"],
        scale: 2,
        format: "png",
        version,
      },
      fixture.api.ctx,
      SESSION,
    );
  }

  it("defaults format to png", async () => {
    respondRender();
    const out = await fixture.handlers["figma.file.render.request"](
      {
        requestId: "r1",
        type: "figma.file.render.request",
        fileKey: FILE,
        ids: ["1:2"],
        scale: 1,
        version: "v1",
        // format omitted on purpose: the agent-tool path reaches the handler without the wire default
      } as Omit<
        FigmaRequestOf<"figma.file.render.request">,
        "format"
      > as FigmaRequestOf<"figma.file.render.request">,
      fixture.api.ctx,
      SESSION,
    );
    expect(out.images["1:2"]!.mimeType).toBe("image/png");
  });
});

describe("export", () => {
  beforeEach(() => {
    fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, () => ({
      version: "v1",
      nodes: { "1:2": { id: "1:2", name: "Hero/Main", type: "FRAME" } },
    }));
    fixture.api.rest.respond(`/v1/images/${FILE}`, ({ query }) => ({
      images: { [query.ids as string]: "https://s3.test/x" },
    }));
  });

  it("names the file <node name>@<scale>x.<ext> and returns bytes", async () => {
    fixture.api.rest.provideBytes("https://s3.test/x", {
      mimeType: "image/svg+xml",
      data: Buffer.from("<svg/>"),
    });
    const out = await fixture.handlers["figma.file.export.request"](
      {
        requestId: "r1",
        type: "figma.file.export.request",
        fileKey: FILE,
        nodeId: "1:2",
        format: "svg",
        scale: 2,
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(out.fileName).toBe("Hero_Main@2x.svg"); // / is not filesystem-safe
    expect(out.file!.mimeType).toBe("image/svg+xml");
    expect(Buffer.from(out.file!.dataBase64, "base64").toString()).toBe("<svg/>");
  });

  it("defaults the scale to 1", async () => {
    fixture.api.rest.provideBytes("https://s3.test/x", {
      mimeType: "application/pdf",
      data: Buffer.from("%PDF"),
    });
    const out = await fixture.handlers["figma.file.export.request"](
      {
        requestId: "r1",
        type: "figma.file.export.request",
        fileKey: FILE,
        nodeId: "1:2",
        format: "pdf",
        // wire default omitted on purpose: the handler must treat missing scale as 1
      } as Omit<
        FigmaRequestOf<"figma.file.export.request">,
        "scale"
      > as FigmaRequestOf<"figma.file.export.request">,
      fixture.api.ctx,
      SESSION,
    );
    expect(out.fileName).toBe("Hero_Main@1x.pdf");
    expect(out.file!.mimeType).toBe("application/pdf");
  });

  it("returns null for an unknown node", async () => {
    const out = await fixture.handlers["figma.file.export.request"](
      {
        requestId: "r1",
        type: "figma.file.export.request",
        fileKey: FILE,
        nodeId: "1:99",
        format: "png",
        scale: 1,
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(out).toEqual({ file: null, fileName: null });
  });
});

describe("image fills", () => {
  beforeEach(() => {
    fixture.api.rest.respond(`/v1/files/${FILE}/images`, () => ({
      images: { ref1: "https://s3.test/ref1" },
    }));
    fixture.api.rest.provideBytes("https://s3.test/ref1", { mimeType: "image/png", data: PNG });
  });

  it("maps refs to bytes once per version, with no URL in the payload", async () => {
    const first = await fixture.handlers["figma.file.imageFills.request"](
      {
        requestId: "r1",
        type: "figma.file.imageFills.request",
        fileKey: FILE,
        imageRefs: ["ref1"],
      },
      fixture.api.ctx,
      SESSION,
    );
    expect([...Buffer.from(first.images["ref1"]!.dataBase64, "base64")]).toEqual([...PNG]);
    expect(first.images["ref1"]!.dataBase64).not.toContain("http");
    const calls = fixture.api.rest.callsTo(`/v1/files/${FILE}/images`);
    expect(calls).toHaveLength(1);
    expect(calls[0].tier).toBe("2"); // endpoint tier per figma-integration.md §3.1

    const second = await fixture.handlers["figma.file.imageFills.request"](
      {
        requestId: "r1",
        type: "figma.file.imageFills.request",
        fileKey: FILE,
        imageRefs: ["ref1"],
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(second.images["ref1"]).toEqual(first.images["ref1"]);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/images`)).toHaveLength(1);
    expect(fixture.api.rest.byteCalls).toHaveLength(1); // bytes from the disk cache
  });

  it("returns null for unknown refs without refetching the map inside the cooldown", async () => {
    const out = await fixture.handlers["figma.file.imageFills.request"](
      {
        requestId: "r1",
        type: "figma.file.imageFills.request",
        fileKey: FILE,
        imageRefs: ["nope"],
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(out.images["nope"]).toBeNull();
    const mapCalls = fixture.api.rest.callsTo(`/v1/files/${FILE}/images`).length;
    expect(mapCalls).toBe(1); // initial map fetch
    await fixture.handlers["figma.file.imageFills.request"](
      {
        requestId: "r1",
        type: "figma.file.imageFills.request",
        fileKey: FILE,
        imageRefs: ["nope"],
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/images`)).toHaveLength(1); // cooldown holds
    expect(fixture.api.rest.byteCalls).toHaveLength(0);
  });
});

describe("versions", () => {
  it("maps the Tier-2 version list to wire entries", async () => {
    fixture.api.rest.respond(`/v1/files/${FILE}/versions`, () => ({
      versions: [
        {
          id: "v7",
          label: "Launch",
          description: "final",
          created_at: "2026-02-28T09:00:00Z",
          user: { handle: "jane" },
        },
        { id: "v6", created_at: 1_700_000_000_000, user: null },
      ],
    }));
    const out = await fixture.handlers["figma.file.versions.request"](
      { requestId: "r1", type: "figma.file.versions.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    const calls = fixture.api.rest.callsTo(`/v1/files/${FILE}/versions`);
    expect(calls).toHaveLength(1);
    expect(calls[0].tier).toBe("2");
    expect(out.versions).toEqual([
      {
        id: "v7",
        label: "Launch",
        description: "final",
        createdAt_ms: Date.parse("2026-02-28T09:00:00Z"),
        user: { handle: "jane" },
      },
      { id: "v6", label: null, description: null, createdAt_ms: 0, user: null },
    ]);
    const callsBefore = fixture.api.rest.calls.length;
    await fixture.handlers["figma.file.versions.request"](
      { requestId: "r1", type: "figma.file.versions.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    expect(fixture.api.rest.calls.length).toBe(callsBefore); // cached per resolved version
  });
});

describe("fonts", () => {
  it("reads preferred family/style names from the sfnt name table", () => {
    const font = buildTtf({ 1: "Alias Family", 2: "Alias Style", 16: "Real Family", 17: "Bold" });
    expect(readFontNames(font)).toEqual({ family: "Real Family", style: "Bold" });
    expect(readFontNames(Buffer.from("woff-bytes-but-too-short"))).toBeNull();
  });

  it("serves system fonts as bytes, matching family and style", async () => {
    const dir = path.join(home, "fonts-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "UnitTestingSans-Bold.ttf"),
      buildTtf({ 1: "Unit Testing Sans", 2: "Bold" }),
    );
    const fixtureWithFonts = buildFonts({ searchDirs: [dir] });
    const out = await fixtureWithFonts.handlers["figma.fonts.get.request"](
      {
        requestId: "r1",
        type: "figma.fonts.get.request",
        family: "unit testing sans",
        style: "bold",
      },
      fixtureWithFonts.api.ctx,
      SESSION,
    );
    expect(out.font!.mimeType).toBe("font/ttf");
    expect(Buffer.from(out.font!.dataBase64, "base64")).toEqual(
      readFileSync(path.join(dir, "UnitTestingSans-Bold.ttf")),
    );
    fixtureWithFonts.content.watches.dispose();
  });

  it("accepts a variable font (fvar) for any style of its family", async () => {
    const dir = path.join(home, "fonts-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "FlexFamily.ttf"),
      buildTtf({ 1: "Flex Family", 2: "Regular" }, ["fvar"]),
    );
    writeFileSync(
      path.join(dir, "UnitTestingSans.ttf"),
      buildTtf({ 1: "Unit Testing Sans", 2: "Regular" }),
    );
    const fixtureWithFonts = buildFonts({ searchDirs: [dir] });
    const hit = await fixtureWithFonts.handlers["figma.fonts.get.request"](
      { requestId: "r1", type: "figma.fonts.get.request", family: "Flex Family", style: "italic" },
      fixtureWithFonts.api.ctx,
      SESSION,
    );
    expect(hit.font).not.toBeNull();
    // The same family without fvar does not cover arbitrary styles.
    const miss = await fixtureWithFonts.handlers["figma.fonts.get.request"](
      {
        requestId: "r1",
        type: "figma.fonts.get.request",
        family: "Unit Testing Sans",
        style: "italic",
      },
      fixtureWithFonts.api.ctx,
      SESSION,
    );
    expect(miss.font).toBeNull();
    fixtureWithFonts.content.watches.dispose();
  });

  it("never returns a different family's font", async () => {
    const dir = path.join(home, "fonts-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "UnitTestingSans-Bold.ttf"),
      buildTtf({ 1: "Unit Testing Sans", 2: "Bold" }),
    );
    const fixtureWithFonts = buildFonts({ searchDirs: [dir] });
    const miss = await fixtureWithFonts.handlers["figma.fonts.get.request"](
      {
        requestId: "r1",
        type: "figma.fonts.get.request",
        family: "Unit Testing Sans",
        style: "light",
      },
      fixtureWithFonts.api.ctx,
      SESSION,
    );
    expect(miss.font).toBeNull();
    fixtureWithFonts.content.watches.dispose();
  });

  it("downloads Google fonts once, then serves from the on-disk index", async () => {
    const downloads: Array<[string, string]> = [];
    const font = buildTtf({ 1: "Roboto", 2: "Regular" });
    const first = buildFonts({
      searchDirs: [path.join(home, "empty-dir")],
      download: async (family, style) => {
        downloads.push([family, style]);
        return { mimeType: "font/ttf", data: font };
      },
    });
    const out = await first.handlers["figma.fonts.get.request"](
      { requestId: "r1", type: "figma.fonts.get.request", family: " Roboto ", style: "Regular" },
      first.api.ctx,
      SESSION,
    );
    expect([...Buffer.from(out.font!.dataBase64, "base64")]).toEqual([...font]);
    expect(downloads).toEqual([["Roboto", "Regular"]]);
    expect(readFileSync(path.join(home, "figma", "fonts", "index.json"), "utf8")).toContain(
      '"family": "Roboto"',
    );

    // A fresh daemon instance with the same home serves from disk without downloading again.
    const second = buildFonts({
      searchDirs: [path.join(home, "empty-dir")],
      download: async () => {
        throw new Error("must not download again");
      },
    });
    const again = await second.handlers["figma.fonts.get.request"](
      { requestId: "r1", type: "figma.fonts.get.request", family: "Roboto", style: "regular" },
      second.api.ctx,
      SESSION,
    );
    expect([...Buffer.from(again.font!.dataBase64, "base64")]).toEqual([...font]);
    first.content.watches.dispose();
    second.content.watches.dispose();
  });

  it("does not retry a failed download on the same instance", async () => {
    let attempts = 0;
    const failed = buildFonts({
      searchDirs: [path.join(home, "empty-dir")],
      download: async () => {
        attempts += 1;
        return null;
      },
    });
    for (let i = 0; i < 2; i += 1) {
      const out = await failed.handlers["figma.fonts.get.request"](
        {
          requestId: "r1",
          type: "figma.fonts.get.request",
          family: "Missing Family",
          style: "Regular",
        },
        failed.api.ctx,
        SESSION,
      );
      expect(out.font).toBeNull();
    }
    expect(attempts).toBe(1);
    failed.content.watches.dispose();
  });

  // ── Google Fonts CSS2 fallback (32.5.1) ─────────────────────────────────────
  // The /download?family= ZIP route is dead for non-browser clients (it answers the
  // Angular HTML shell), so the fallback acquires bytes through the documented CSS2
  // API. These tests stub fetch for the default download; the daemon never assumes
  // an available font — a rejected answer falls back to the real Figma raster.

  const CSS2_BASE = "https://fonts.googleapis.com/css2";
  const STABLE_UA = "JAgentDesk/1.0 (daemon font fetch)";

  function faceCss(opts: {
    family: string;
    weight: number;
    italic: boolean;
    assetUrl?: string;
    extraFaces?: number;
    extraUrls?: number;
  }): string {
    const url =
      opts.assetUrl ?? `https://fonts.gstatic.com/s/${opts.family.toLowerCase()}/face.ttf`;
    let css = `@font-face {\n  font-family: '${opts.family}';\n  font-style: ${
      opts.italic ? "italic" : "normal"
    };\n  font-weight: ${opts.weight};\n  font-stretch: normal;\n  src: url(${url}) format('truetype');`;
    for (let i = 1; i < (opts.extraUrls ?? 1); i += 1)
      css += `\n  src: url(https://fonts.gstatic.com/s/extra${i}.ttf) format('truetype');`;
    css += "\n}\n";
    for (let i = 1; i < (opts.extraFaces ?? 1); i += 1)
      css += `@font-face {\n  font-family: '${opts.family}';\n  font-style: normal;\n  font-weight: ${opts.weight};\n  src: url(https://fonts.gstatic.com/s/subset${i}.ttf) format('woff2');\n}\n`;
    return css;
  }

  interface FetchStub {
    urls: string[];
    userAgents: (string | undefined)[];
  }

  function stubGoogleFetch(
    css: string,
    fontBody: Uint8Array | string | null,
    opts: { assetRedirects?: string[]; cssRedirects?: string[] } = {},
  ): FetchStub {
    const stub: FetchStub = { urls: [], userAgents: [] };
    let assetCalls = 0;
    let cssCalls = 0;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      stub.urls.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      stub.userAgents.push(headers["User-Agent"]);
      const redirects = url.startsWith(CSS2_BASE) ? opts.cssRedirects : opts.assetRedirects;
      const queued = redirects?.[url.startsWith(CSS2_BASE) ? cssCalls++ : assetCalls++];
      if (queued !== undefined)
        return new Response(null, { status: 302, headers: { location: queued } });
      if (url.startsWith(CSS2_BASE))
        return new Response(css, { status: 200, headers: { "content-type": "text/css" } });
      if (fontBody === null) return new Response("gone", { status: 404 });
      return new Response(fontBody, { status: 200, headers: { "content-type": "font/ttf" } });
    });
    return stub;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("asks css2 for the exact weight/italic tuple of the requested style", async () => {
    const cases: Array<[string, string]> = [
      ["Regular", "wght@400"],
      ["Light", "wght@300"],
      ["Semi Bold", "wght@600"], // must not hit the "bold" token
      ["Bold", "wght@700"],
      ["Bold Italic", "ital,wght@1,700"],
      ["Italic", "ital,wght@1,400"],
    ];
    for (const [style, axes] of cases) {
      const italic = axes.startsWith("ital");
      const weight = Number(axes.slice(axes.lastIndexOf(",") + 1).replace("wght@", ""));
      const font = buildTtf({ 1: "Inter", 2: style });
      const stub = stubGoogleFetch(faceCss({ family: "Inter", weight, italic }), font);
      const out = await defaultGoogleFontsDownload("Inter", style);
      expect(stub.urls[0]).toBe(`${CSS2_BASE}?family=Inter:${axes}`);
      expect(stub.userAgents[0]).toBe(STABLE_UA); // plain UA → one full TTF, not subset woff2
      expect(out).not.toBeNull();
      expect(out!.mimeType).toBe("font/ttf");
      expect([...out!.data]).toEqual([...font]);
    }
  });

  it("returns null instead of a font when css2 answers the HTML shell", async () => {
    // The regression that killed the ZIP route: a 200 with `<!doctype html>` where a
    // stylesheet belongs must fail closed, and must not chase an asset URL.
    const stub = stubGoogleFetch("<!doctype html><html><head></head><body></body></html>", null);
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
    expect(stub.urls).toEqual([`${CSS2_BASE}?family=Inter:wght@400`]);
  });

  it("returns null when the served font bytes are HTML, woff2, or a failed fetch", async () => {
    const html = stubGoogleFetch(
      faceCss({ family: "Inter", weight: 400, italic: false }),
      "<!doctype html><p>x</p>",
    );
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
    expect(html.urls).toHaveLength(2);

    const woff2 = stubGoogleFetch(
      faceCss({ family: "Inter", weight: 400, italic: false }),
      Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]),
    );
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
    expect(woff2.urls).toHaveLength(2);

    stubGoogleFetch(faceCss({ family: "Inter", weight: 400, italic: false }), null);
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull(); // asset 404
  });

  it("rejects a face whose css2 descriptor names a different family", async () => {
    const stub = stubGoogleFetch(faceCss({ family: "Roboto", weight: 400, italic: false }), null);
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
    expect(stub.urls).toHaveLength(1); // never fetched the mismatched face's asset
  });

  it("rejects font bytes whose name table disagrees with the requested family", async () => {
    const alias = buildTtf({ 1: "Alias Family", 2: "Regular" });
    stubGoogleFetch(faceCss({ family: "Inter", weight: 400, italic: false }), alias);
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
  });

  it("rejects off-host and redirected font URLs", async () => {
    const font = buildTtf({ 1: "Inter", 2: "Regular" });
    const foreign = stubGoogleFetch(
      faceCss({
        family: "Inter",
        weight: 400,
        italic: false,
        assetUrl: "https://example.com/a.ttf",
      }),
      null,
    );
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
    expect(foreign.urls).toHaveLength(1);

    stubGoogleFetch(
      faceCss({
        family: "Inter",
        weight: 400,
        italic: false,
        assetUrl: "http://fonts.gstatic.com/a.ttf", // gstatic host, but not https
      }),
      font,
    );
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
  });

  it("never fetches a foreign redirect target on the asset hop", async () => {
    // The point of manual hops: an untrusted Location is rejected by VALIDATION, before
    // any request reaches it — not fetched and then discarded after reading the body.
    const font = buildTtf({ 1: "Inter", 2: "Regular" });
    const stub = stubGoogleFetch(
      faceCss({
        family: "Inter",
        weight: 400,
        italic: false,
        assetUrl: "https://fonts.gstatic.com/a.ttf",
      }),
      font,
      { assetRedirects: ["https://cdn.evil.test/a.ttf"] },
    );
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
    expect(stub.urls).toEqual([
      `${CSS2_BASE}?family=Inter:wght@400`,
      "https://fonts.gstatic.com/a.ttf",
    ]); // evil.test was never contacted
  });

  it("follows same-host redirects, absolute and relative", async () => {
    const font = buildTtf({ 1: "Inter", 2: "Regular" });
    const stub = stubGoogleFetch(
      faceCss({
        family: "Inter",
        weight: 400,
        italic: false,
        assetUrl: "https://fonts.gstatic.com/a.ttf",
      }),
      font,
      {
        assetRedirects: ["https://fonts.gstatic.com/s/inter/b.ttf", "/s/inter/c.ttf"],
      },
    );
    const out = await defaultGoogleFontsDownload("Inter", "Regular");
    expect(out).not.toBeNull();
    expect([...out!.data]).toEqual([...font]);
    // The relative Location resolves against the current hop and stays on gstatic.
    expect(stub.urls.slice(1)).toEqual([
      "https://fonts.gstatic.com/a.ttf",
      "https://fonts.gstatic.com/s/inter/b.ttf",
      "https://fonts.gstatic.com/s/inter/c.ttf",
    ]);
  });

  it("rejects redirect hops with credentials or a custom port", async () => {
    const font = buildTtf({ 1: "Inter", 2: "Regular" });
    const cases = [
      "https://cdn.example.com/a.ttf", // foreign host
      "https://user@fonts.gstatic.com/a.ttf", // embedded credentials
      "https://fonts.gstatic.com:8443/a.ttf", // custom port
      "http://fonts.gstatic.com/a.ttf", // not https
    ];
    for (const location of cases) {
      const stub = stubGoogleFetch(
        faceCss({
          family: "Inter",
          weight: 400,
          italic: false,
          assetUrl: "https://fonts.gstatic.com/a.ttf",
        }),
        font,
        { assetRedirects: [location] },
      );
      expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
      // Rejected at validation: the original hop was fetched, the untrusted target never was.
      expect(stub.urls).toHaveLength(2);
    }
  });

  it("keeps the css2 request on fonts.googleapis.com and bounds loops", async () => {
    const font = buildTtf({ 1: "Inter", 2: "Regular" });
    const offHost = stubGoogleFetch(
      faceCss({ family: "Inter", weight: 400, italic: false }),
      font,
      { cssRedirects: ["https://fonts.google.com/css2?family=Inter:wght@400"] },
    );
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
    expect(offHost.urls).toHaveLength(1); // the stylesheet host itself must not bounce off-policy

    const looping = stubGoogleFetch(
      faceCss({
        family: "Inter",
        weight: 400,
        italic: false,
        assetUrl: "https://fonts.gstatic.com/loop.ttf",
      }),
      font,
      { assetRedirects: Array(10).fill("https://fonts.gstatic.com/loop.ttf") },
    );
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
    // One hop per allowed GET, then the bound answers null: 5 redirects followed plus the
    // sixth 302 hits the cap — no infinite spin, and the font body is never served.
    expect(looping.urls.filter((u) => u.includes("loop.ttf"))).toHaveLength(6);
  });

  it("rejects ambiguous responses: multiple faces or multiple src urls", async () => {
    const font = buildTtf({ 1: "Inter", 2: "Regular" });
    const faces = faceCss({ family: "Inter", weight: 400, italic: false, extraFaces: 2 });
    stubGoogleFetch(faces, font);
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();

    const urls = faceCss({ family: "Inter", weight: 400, italic: false, extraUrls: 2 });
    stubGoogleFetch(urls, font);
    expect(await defaultGoogleFontsDownload("Inter", "Regular")).toBeNull();
  });

  it("does not trust a variable font's fvar as proof of the requested style", async () => {
    // css2 answered the italic tuple, but the delivered file's name table says Regular:
    // a variable Regular masquerading as Italic must fall through to the raster, not
    // claim a font the renderer would then draw with the wrong posture.
    const variable = buildTtf({ 1: "Roboto", 2: "Regular" }, ["fvar"]);
    stubGoogleFetch(faceCss({ family: "Roboto", weight: 400, italic: true }), variable);
    expect(await defaultGoogleFontsDownload("Roboto", "Italic")).toBeNull();
  });

  it("shares one download between simultaneous requests for the same font", async () => {
    let downloads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const font = buildTtf({ 1: "Roboto", 2: "Regular" });
    const racer = buildFonts({
      searchDirs: [path.join(home, "empty-dir")],
      download: async () => {
        downloads += 1;
        await gate;
        return { mimeType: "font/ttf", data: font };
      },
    });
    const request = (requestId: string) =>
      racer.handlers["figma.fonts.get.request"](
        { requestId, type: "figma.fonts.get.request", family: "Roboto", style: "Regular" },
        fixture.api.ctx,
        SESSION,
      );
    const starter = request("r1");
    const joiner = request("r2");
    release();
    const [a, b] = await Promise.all([starter, joiner]);
    expect(downloads).toBe(1);
    expect([...Buffer.from(a.font!.dataBase64, "base64")]).toEqual([...font]);
    expect([...Buffer.from(b.font!.dataBase64, "base64")]).toEqual([...font]);
    racer.content.watches.dispose();
  });

  it("keeps both index entries when two different fonts download together", async () => {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fonts: Record<string, Buffer> = {
      Roboto: buildTtf({ 1: "Roboto", 2: "Regular" }),
      Inter: buildTtf({ 1: "Inter", 2: "Bold" }),
    };
    const paired = buildFonts({
      searchDirs: [path.join(home, "empty-dir")],
      download: async (family) => {
        entered += 1;
        if (entered === 2) release();
        await gate;
        return { mimeType: "font/ttf", data: fonts[family] };
      },
    });
    const request = (family: string, style: string) =>
      paired.handlers["figma.fonts.get.request"](
        { requestId: "r1", type: "figma.fonts.get.request", family, style },
        fixture.api.ctx,
        SESSION,
      );
    const [a, b] = await Promise.all([request("Roboto", "Regular"), request("Inter", "Bold")]);
    expect(a.font).not.toBeNull();
    expect(b.font).not.toBeNull();

    // Both flights saved concurrently; the serialized index write must keep both entries.
    const index = JSON.parse(readFileSync(path.join(home, "figma", "fonts", "index.json"), "utf8"));
    expect(index.entries).toHaveLength(2);
    const keys = index.entries.map((entry: { family: string; style: string }) =>
      `${entry.family} ${entry.style}`.toLowerCase(),
    );
    expect(keys).toContain("roboto regular");
    expect(keys).toContain("inter bold");

    // A fresh provider serves both fonts from disk without downloading again.
    const second = buildFonts({
      searchDirs: [path.join(home, "empty-dir")],
      download: async () => {
        throw new Error("must serve from the index");
      },
    });
    const cached = await second.handlers["figma.fonts.get.request"](
      { requestId: "r1", type: "figma.fonts.get.request", family: "Inter", style: "Bold" },
      second.api.ctx,
      SESSION,
    );
    expect([...Buffer.from(cached.font!.dataBase64, "base64")]).toEqual([...fonts.Inter]);
    second.content.watches.dispose();
    paired.content.watches.dispose();
  });

  function buildFonts(fonts: NonNullable<ContentDeps["fonts"]>): Fixture {
    const api = makeFigmaApi({ home, logger: pino({ level: "silent" }) });
    api.store.addFile(makeFile(FILE));
    const content = new FigmaContent({ fonts: { download: async () => null, ...fonts } });
    return { api, content, handlers: content.handlers(), home };
  }
});

describe("watches", () => {
  function watch(fileKey: string): Promise<{ watchId: string }> {
    return fixture.handlers["figma.file.watch.request"](
      { requestId: "r1", type: "figma.file.watch.request", fileKey },
      fixture.api.ctx,
      SESSION,
    );
  }

  function changed(): Array<Record<string, unknown>> {
    return fixture.api.pushes.filter((push) => push.type === "figma.file.changed");
  }

  it("polls meta every 60 s and pushes figma.file.changed on a version change", async () => {
    // Prime the resolved version through an outline read so the poller starts with v1 baseline.
    respondFile();
    await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    const { watchId } = await watch(FILE);
    expect(fixture.content.watches.count).toBe(1);

    // Silent at 60 s while the version is unchanged.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed()).toHaveLength(0);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(2); // prime + poll

    // A version bump produces exactly one push for the watch, with the new version.
    fixture.api.rest.respond(`/v1/files/${FILE}/meta`, metaJson("v2"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed()).toEqual([
      { type: "figma.file.changed", watchId, fileKey: FILE, version: "v2", source: "rest" },
    ]);
    await vi.advanceTimersByTimeAsync(60_000); // v2 == new baseline → silent
    expect(changed()).toHaveLength(1);

    // Unwatching stops the poll entirely.
    await fixture.handlers["figma.file.unwatch.request"](
      { requestId: "r1", type: "figma.file.unwatch.request", watchId },
      fixture.api.ctx,
      SESSION,
    );
    const polls = fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`).length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(polls);
    expect(changed()).toHaveLength(1);
    expect(fixture.content.watches.count).toBe(0);
  });

  it("pushes nothing on the first poll when the outline primed the version after registration", async () => {
    // Run-15 reload bug: the viewer registers the watch, then the outline resolves and primes
    // the current version a beat later. The poller captured baseline=null at registration, so
    // the first 60 s poll compared the polled version against null, pushed the SAME version,
    // and the client dropped its whole FrameStore and assets. The comparison must fall back to
    // the known (primed) version when the registration baseline is absent.
    const { watchId } = await watch(FILE); // registration baseline: nothing known yet
    respondFile();
    await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    ); // primes v1 AFTER registration
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed()).toHaveLength(0); // unchanged → zero pushes (was: one spurious)

    // A real change still pushes exactly once and moves the baseline forward.
    fixture.api.rest.respond(`/v1/files/${FILE}/meta`, metaJson("v2"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed()).toEqual([
      { type: "figma.file.changed", watchId, fileKey: FILE, version: "v2", source: "rest" },
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed()).toHaveLength(1);
  });

  it("still pushes the first poll when the version was never known (unknown baseline preserved)", async () => {
    const { watchId } = await watch(FILE); // no outline, no prime → nothing is known
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed()).toEqual([
      { type: "figma.file.changed", watchId, fileKey: FILE, version: "v1", source: "rest" },
    ]);
  });

  it("shares one poller per file across watchers and unsubscribes from the link when idle", async () => {
    // Prime v1 through an outline read so both watchers start from a silent baseline.
    respondFile();
    await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    const a = await watch(FILE);
    const b = await watch(FILE);
    expect(fixture.content.watches.isPolling(FILE)).toBe(true);
    const before = fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`).length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(before + 1); // one, not two
    expect(changed()).toHaveLength(0);

    fixture.api.rest.respond(`/v1/files/${FILE}/meta`, metaJson("v9"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      changed()
        .map((push) => push.watchId)
        .sort(),
    ).toEqual([a.watchId, b.watchId].sort());

    await fixture.handlers["figma.file.unwatch.request"](
      { requestId: "r1", type: "figma.file.unwatch.request", watchId: a.watchId },
      fixture.api.ctx,
      SESSION,
    );
    await fixture.handlers["figma.file.unwatch.request"](
      { requestId: "r1", type: "figma.file.unwatch.request", watchId: b.watchId },
      fixture.api.ctx,
      SESSION,
    );
    expect(fixture.api.link.activeChangeSubscriptions).toBe(0);
    await fixture.handlers["figma.file.unwatch.request"](
      { requestId: "r1", type: "figma.file.unwatch.request", watchId: "unknown-watch" },
      fixture.api.ctx,
      SESSION,
    );
    expect(fixture.content.watches.count).toBe(0);
  });

  it("spends no Tier-3 budget on a linked file and forwards plugin change events instead", async () => {
    fixture.api.link.linked.add(FILE);
    const { watchId } = await watch(FILE);
    const metaPath = `/v1/files/${FILE}/meta`;
    const before = fixture.api.rest.callsTo(metaPath).length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fixture.api.rest.callsTo(metaPath)).toHaveLength(before); // link reports its own changes

    fixture.api.link.emitChange({ fileKey: FILE, nodeIds: ["1:2"] });
    expect(changed()).toEqual([
      {
        type: "figma.file.changed",
        watchId,
        fileKey: FILE,
        version: "",
        source: "link",
        nodeIds: ["1:2"],
      },
    ]);
  });

  it("rejects watching a file the daemon has never added", async () => {
    await expect(watch("missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("survives a failing poll tick without stopping the interval", async () => {
    fixture.api.store.addFile(makeFile("ghost"));
    const missing = await watch("ghost");
    // /v1/files/ghost/meta has no responder → the fake throws inside the poll; it must be swallowed.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.content.watches.count).toBe(1);
    expect(fixture.api.pushes).toHaveLength(0);
    expect(missing.watchId).toHaveLength(36);
  });

  it("primes the memo from a successful unchanged poll so the next read reuses it", async () => {
    // 32.8 fresh-60 s memo: the poll's meta answer is authoritative for the memo window too.
    // Pre-fix it returned on the unchanged version WITHOUT priming, so a content read a beat
    // after the tick re-GETed /meta.
    respondFile();
    await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    ); // meta #1: initial live resolve, primes memo at T0
    const { watchId } = await watch(FILE); // registration baseline: v1 (known from the outline)
    expect(watchId).toHaveLength(36);
    fixture.api.setNow(fixture.api.now() + 60_000); // the T0 memo is now past its 60 s TTL
    await vi.advanceTimersByTimeAsync(60_000); // poll #2: unchanged v1 → silent, but primes memo
    expect(changed()).toHaveLength(0);

    const { outline } = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r2", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    expect(outline!.version).toBe("v1");
    // No third meta: the read rode the memo the poll just refreshed (pre-fix: 3 — the poll
    // left the expired memo expired, so the read re-GETed /meta).
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(2);
  });

  it("discards a poll answer that raced a remote-write readback instead of rolling it back", async () => {
    respondFile();
    await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    ); // primes live memo v1
    const { watchId } = await watch(FILE); // baseline v1

    // Begin a poll whose Tier-3 answer stays in flight: the send is recorded, but resolution
    // waits on a manual gate (the fake returns structuredClone() of a Promise, so the
    // deferral lives on getJson, not in the responder).
    const rest = fixture.api.rest;
    const originalGetJson = rest.getJson.bind(rest);
    let releaseMeta!: (value: unknown) => void;
    let armed = true;
    rest.getJson = (async (input: Parameters<typeof originalGetJson>[0]) => {
      if (armed && input.path === `/v1/files/${FILE}/meta`) {
        armed = false;
        await originalGetJson(input); // records the send; the answer arrives only via the gate
        return await new Promise((resolve) => {
          releaseMeta = resolve;
        });
      }
      return originalGetJson(input);
    }) as typeof rest.getJson;

    await vi.advanceTimersByTimeAsync(60_000); // poll #2 begins, GET outstanding (in flight)

    // ADR-0040: a confirmed write readback lands while the poll GET is still outstanding.
    fixture.content.watches.remoteWriteApplied(fixture.api.ctx, FILE, "v2");
    releaseMeta(metaJson("v1")); // the stale pre-v2 answer finally arrives
    await vi.advanceTimersByTimeAsync(0);

    // The remote force push is unchanged, and the old v1 poll answer pushed nothing of its own
    // (pre-fix: the stale v1 rolled baseline/memo back and emitted a second figma.file.changed).
    expect(changed()).toEqual([
      { type: "figma.file.changed", watchId, fileKey: FILE, version: "v2", source: "rest" },
    ]);

    // Neither the memo nor the baseline rolled back to the stale v1: the next live read serves
    // the confirmed v2 without re-resolving, and a following unchanged poll is silent.
    fixture.api.rest.respond(`/v1/files/${FILE}`, ({ query }) => fileJson(String(query.version)));
    const { outline } = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r2", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    expect(outline!.version).toBe("v2");
    expect(outline!.source).toBe("rest");
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(2); // init + raced poll
    fixture.api.rest.respond(`/v1/files/${FILE}/meta`, metaJson("v2"));
    await vi.advanceTimersByTimeAsync(60_000); // v2 == baseline → silent
    expect(changed()).toHaveLength(1);
    rest.getJson = originalGetJson;
  });

  it("does not promote a pinned historical outline version into the live memo", async () => {
    // 32.1: a pinned read is an immutable snapshot — promoting its version would poison the
    // live memo (current v2) with history (v1). Only live reads or verified fresh meta promote.
    fixture.api.rest.respond(`/v1/files/${FILE}/meta`, metaJson("v2")); // current is v2
    fixture.api.rest.respond(`/v1/files/${FILE}`, ({ query }) => fileJson(String(query.version)));
    const historical = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE, version: "v1" },
      fixture.api.ctx,
      SESSION,
    );
    expect(historical.outline!.version).toBe("v1");

    const live = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r2", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    expect(live.outline!.version).toBe("v2");
    // The fresh live read resolved through Tier-3 meta — not through a history pin (pre-fix:
    // zero meta calls and a v1 answer, the memo poisoned by the historical read).
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(1);
    expect(
      fixture.api.rest.callsTo(`/v1/files/${FILE}`).map((call) => String(call.query.version)),
    ).toEqual(["v1", "v2"]);
  });
});

// ── ADR-0039: section-aware outline + depth-1 metadata read ──────────────────

describe("outline section flattening (ADR-0039)", () => {
  const FULL_PATH = `/v1/files/${FILE}`;

  function boxed(id: string, name: string, type = "FRAME"): object {
    return {
      id,
      type,
      name,
      absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 200 },
      backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
    };
  }

  /**
   * A depth-3 answer: page children at level 2, section children at level 3. The level-3
   * SECTION 5:2 comes back truncated (children present-but-empty is how REST marks the cut)
   * and COMPONENT 6:0 / FRAME 5:3 carry children the outline must NOT flatten — they are
   * inside a screen, not screens of their own.
   */
  function respondSections(): void {
    fixture.api.rest.respond(FULL_PATH, {
      name: "Sections",
      version: "v1",
      lastModified: "2026-03-01T10:00:00Z",
      editorType: "figma",
      document: {
        id: "0:0",
        type: "DOCUMENT",
        children: [
          {
            id: "0:1",
            type: "CANVAS",
            name: "Cover",
            backgroundColor: { r: 0, g: 0, b: 0, a: 1 },
            children: [
              boxed("1:2", "Hero"),
              {
                ...boxed("5:0", "Onboarding", "SECTION"),
                children: [
                  boxed("5:1", "Inside Section"),
                  { ...boxed("5:2", "Boundary Section", "SECTION"), children: [] },
                  {
                    ...boxed("6:0", "Section Component", "COMPONENT"),
                    children: [boxed("6:1", "Hidden")],
                  },
                  {
                    ...boxed("5:3", "Has Nested Frame"),
                    children: [boxed("5:31", "Frame Within Screen")],
                  },
                ],
              },
              { id: "5:9", type: "RECTANGLE", name: "No bounds" },
            ],
            flowStartingPoints: [{ nodeId: "5:1", name: "Inside Section" }],
          },
        ],
      },
    });
  }

  async function outline() {
    const response = await fixture.handlers["figma.file.outline.request"](
      { requestId: "r1", type: "figma.file.outline.request", fileKey: FILE },
      fixture.api.ctx,
      SESSION,
    );
    return response.outline;
  }

  it("reads depth 3 and flattens only SECTION wrappers into parent-first, sibling-order summaries", async () => {
    respondSections();
    const result = await outline();
    expect(result).not.toBeNull();
    expect(result!.pages[0].frames.map((frame) => frame.id)).toEqual([
      "1:2",
      "5:0", // the section itself is a background/label entry
      "5:1",
      "5:2",
      "6:0",
      "5:3",
    ]);
    expect(fixture.api.rest.callsTo(FULL_PATH)[0].query).toMatchObject({ depth: 3 });

    const byId = Object.fromEntries(result!.pages[0].frames.map((f) => [f.id, f]));
    // Top-level screen: no parent, no section semantics.
    expect(byId["1:2"].parentId).toBeUndefined();
    expect(byId["1:2"].childrenLoaded).toBeUndefined();
    // Section: children known at level 2, so the walk descended.
    expect(byId["5:0"].type).toBe("SECTION");
    expect(byId["5:0"].childrenLoaded).toBe(true);
    expect(byId["5:0"].parentId).toBeUndefined();
    // Flattened children carry the nearest section as parent.
    expect(byId["5:1"].parentId).toBe("5:0");
    // Boundary section: children: [] is a truncation, not an empty section.
    expect(byId["5:2"].parentId).toBe("5:0");
    expect(byId["5:2"].childrenLoaded).toBe(false);
    // The walk stops at drawable roots: their inner nodes are content, not summaries…
    expect(byId["6:0"].type).toBe("COMPONENT");
    expect(byId["6:0"].parentId).toBe("5:0");
    expect(byId).not.toHaveProperty("6:1");
    expect(byId).not.toHaveProperty("5:31");
    // …and a frame nested inside a screen is never its own canvas screen.
    const ids = result!.pages[0].frames.map((frame) => frame.id);
    expect(ids).not.toContain("5:31");
  });

  it("keeps real flow starting points from page metadata and never invents them", async () => {
    respondSections();
    const result = await outline();
    expect(result!.pages[0].flowStartingPoints).toEqual([
      { nodeId: "5:1", name: "Inside Section" },
    ]);
  });

  it("never answers the depth-3 outline from the old depth-2 summary namespace", async () => {
    // A summary cached before ADR-0039 saw sections as opaque entries with no children; if the
    // reader kept the `outline@` key, this stale entry would answer with zero REST calls.
    await fixture.api.ctx.cache.putJson(`file/${FILE}/outline@v1`, {
      data: {
        fileKey: FILE,
        name: "Stale Depth Two",
        version: "v1",
        lastModified_ms: 0,
        editorType: "figma",
        pages: [],
        source: "rest",
      },
      cached_at: Date.now(),
      source: "rest",
    });
    respondSections();
    const result = await outline();
    expect(result!.name).toBe("Sections");
    expect(fixture.api.rest.callsTo(FULL_PATH)).toHaveLength(1);

    // The second read hits the new namespace instead of re-fetching.
    const again = await outline();
    expect(again!.name).toBe("Sections");
    expect(fixture.api.rest.callsTo(FULL_PATH)).toHaveLength(1);
  });
});

describe("nodes depth=1 metadata read (ADR-0039)", () => {
  const NODES_PATH = `/v1/files/${FILE}/nodes`;

  function nodeEntry(id: string, shallow: boolean): Record<string, unknown> {
    return {
      document: {
        id,
        name: shallow ? `Shallow ${id}` : `Node ${id}`,
        type: "TEXT",
        absoluteBoundingBox: { x: 20, y: 40, width: 100, height: 20 },
        ...(shallow
          ? { children: [{ id: `${id}.1`, name: "Direct child", type: "RECTANGLE" }] }
          : {}),
      },
      components: {},
      componentSets: {},
      styles: {},
      schemaVersion: 1,
    };
  }

  function respondDepthAware(): void {
    fixture.api.rest.respond(NODES_PATH, ({ query }) => {
      const shallow = query.depth !== undefined;
      return {
        err: null,
        name: "Marketing Site",
        version: "v1",
        lastModified: "2026-03-01T10:00:00Z",
        nodes: Object.fromEntries(
          (query.ids ?? "").split(",").map((id) => [id, nodeEntry(id, shallow)]),
        ),
      };
    });
  }

  async function readDepth1(version?: string, ids: string[] = ["1:1"]) {
    return fixture.handlers["figma.file.nodes.request"](
      { requestId: "r1", type: "figma.file.nodes.request", fileKey: FILE, ids, version, depth: 1 },
      fixture.api.ctx,
      SESSION,
    );
  }

  it("requires a pinned version and rejects blank ones before any REST call", async () => {
    respondDepthAware();
    await expect(readDepth1()).rejects.toMatchObject({ code: "invalid_input" });
    await expect(readDepth1("   ")).rejects.toMatchObject({ code: "invalid_input" });
    expect(fixture.api.rest.calls).toHaveLength(0);
  });

  it("is REST-only for a pinned version, forwards depth without geometry, and never asks the plugin", async () => {
    fixture.api.link.linked.add(FILE);
    fixture.api.link.getNodesImpl = () => {
      throw new Error("depth-1 must never read the live tree");
    };
    respondDepthAware();
    const out = await readDepth1("v1");
    expect(out.source).toBe("rest");

    const calls = fixture.api.rest.callsTo(NODES_PATH);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toMatchObject({ ids: "1:1", depth: 1, version: "v1" });
    expect(calls[0].query).not.toHaveProperty("geometry"); // metadata needs no vector paths
    expect(fixture.api.link.toolCalls).toHaveLength(0);

    // The shallow entry is stored and served as returned: direct children only.
    const cached = await readDepth1("v1");
    expect(cached.nodes["1:1"]).toMatchObject({ name: "Shallow 1:1" });
    expect((cached.nodes["1:1"] as { children?: unknown[] }).children).toHaveLength(1);
    expect(fixture.api.rest.callsTo(NODES_PATH)).toHaveLength(1);
  });

  it("keeps shallow and full trees in separate cache namespaces in both directions", async () => {
    respondDepthAware();

    // Shallow first: the later full read must NOT accept the truncated entry.
    const shallow = await readDepth1("v1");
    expect(shallow.nodes["1:1"]).toMatchObject({ name: "Shallow 1:1" });
    const full = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r2",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: ["1:1"],
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(full.nodes["1:1"]).toMatchObject({ name: "Node 1:1" });
    const calls = fixture.api.rest.callsTo(NODES_PATH);
    expect(calls).toHaveLength(2);
    expect(calls[1].query).toMatchObject({ ids: "1:1", geometry: "paths", version: "v1" });
    expect(calls[1].query).not.toHaveProperty("depth");

    // And both repeat reads hit their own namespace, never the other's answer.
    await readDepth1("v1");
    await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r3",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: ["1:1"],
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(fixture.api.rest.callsTo(NODES_PATH)).toHaveLength(2);
  });

  it("treats a shallow known-unknown as known without re-fetching or poisoning the full tree", async () => {
    fixture.api.rest.respond(NODES_PATH, ({ query }) => {
      const shallow = query.depth !== undefined;
      const nodes: Record<string, unknown> = {};
      for (const id of (query.ids ?? "").split(",")) {
        if (shallow && id === "missing") continue;
        nodes[id] = nodeEntry(id, shallow);
      }
      return {
        err: null,
        name: "Marketing Site",
        version: "v1",
        lastModified: "2026-03-01T10:00:00Z",
        nodes,
      };
    });

    const out = await readDepth1("v1", ["1:1", "missing"]);
    expect(out.nodes["missing"]).toBeNull();
    // Second shallow call: `missing` is known-unknown at depth 1, so it is not re-asked…
    await readDepth1("v1", ["1:1", "missing"]);
    expect(fixture.api.rest.callsTo(NODES_PATH)).toHaveLength(1);
    // …but the full tree still answers it from its own namespace.
    const full = await fixture.handlers["figma.file.nodes.request"](
      {
        requestId: "r2",
        type: "figma.file.nodes.request",
        fileKey: FILE,
        ids: ["missing"],
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(full.nodes["missing"]).toMatchObject({ name: "Node missing" });
  });
});

// ── ADR-0042: render fidelity (packet C3) ─────────────────────────────────────

describe("render fidelity (ADR-0042)", () => {
  const SVG = Buffer.from("<svg><path/></svg>");

  function renderRequest(params: Record<string, unknown> = {}) {
    return {
      requestId: "r1",
      type: "figma.file.render.request",
      fileKey: FILE,
      ids: ["1:2"],
      scale: 2,
      ...params,
    } as Parameters<(typeof fixture.handlers)["figma.file.render.request"]>[0];
  }

  function respondImage(url: string, mimeType: string, data: Buffer): void {
    fixture.api.rest.respond(`/v1/images/${FILE}`, ({ query }) => ({
      images: { [String(query.ids)]: url },
    }));
    fixture.api.rest.provideBytes(url, { mimeType, data });
  }

  function onlyImageQuery(): Record<string, unknown> {
    const calls = fixture.api.rest.callsTo(`/v1/images/${FILE}`);
    expect(calls).toHaveLength(1);
    return calls[0]!.query;
  }

  async function render(params: Record<string, unknown> = {}) {
    return fixture.handlers["figma.file.render.request"](
      renderRequest(params),
      fixture.api.ctx,
      SESSION,
    );
  }

  // The clarified contract: fidelity (svg or absolute) must carry a non-empty explicit version,
  // refused BEFORE any REST dispatch and without touching the plugin — even while linked.
  it("fidelity without an explicit version is refused before REST and without the plugin", async () => {
    fixture.api.link.linked.add(FILE); // a linked file must not rescue it either
    const missing: Record<string, unknown>[] = [
      { format: "svg" }, // no version at all
      { useAbsoluteBounds: true },
      { format: "svg", version: "" }, // blank
      { format: "svg", useAbsoluteBounds: true, version: "   " }, // whitespace
    ];
    for (const params of missing) {
      const error = await render(params).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(params)).toBeInstanceOf(FigmaServiceError);
      expect((error as FigmaServiceError).code).toBe("invalid_input");
      expect((error as FigmaServiceError).message).toContain("version");
    }
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toEqual([]);
    expect(fixture.api.link.toolCalls).toEqual([]);
  });

  it("legacy png/jpg unversioned keep their released live semantics (not refused)", async () => {
    respondImage("https://s3.test/png", "image/png", PNG);
    await expect(render({ format: "png" })).resolves.toMatchObject({ source: "rest" });
    respondImage("https://s3.test/jpg", "image/jpeg", PNG);
    await expect(render({ format: "jpg" })).resolves.toMatchObject({ source: "rest" });
  });

  it("plain png crop keeps the released query byte-for-byte — no new flags", async () => {
    respondImage("https://s3.test/png", "image/png", PNG);
    const out = await render();
    // Exact object equality: an absent option must not even send `undefined` flags.
    expect(onlyImageQuery()).toEqual({ ids: "1:2", scale: 2, format: "png", version: "v1" });
    expect(out.images["1:2"]).toMatchObject({ mimeType: "image/png" });
  });

  it("jpg crop keeps the released query too", async () => {
    respondImage("https://s3.test/jpg", "image/jpeg", PNG);
    await render({ format: "jpg" });
    expect(onlyImageQuery()).toEqual({ ids: "1:2", scale: 2, format: "jpg", version: "v1" });
  });

  it("svg requests text outlines over REST and return svg bytes", async () => {
    respondImage("https://s3.test/svg", "image/svg+xml", SVG);
    const out = await render({ format: "svg", version: "v1" });
    const query = onlyImageQuery();
    expect(query.format).toBe("svg");
    expect(query.svg_outline_text).toBe("true");
    expect(query).not.toHaveProperty("use_absolute_bounds");
    expect(out.images["1:2"]!.mimeType).toBe("image/svg+xml");
    expect(Buffer.from(out.images["1:2"]!.dataBase64, "base64")).toEqual(SVG);
  });

  it("absolute bounds maps exactly to use_absolute_bounds=true", async () => {
    respondImage("https://s3.test/abs", "image/png", PNG);
    await render({ useAbsoluteBounds: true, version: "v1" });
    const query = onlyImageQuery();
    expect(query.use_absolute_bounds).toBe("true");
    expect(query).not.toHaveProperty("svg_outline_text");
  });

  it("svg + absolute carries both flags", async () => {
    respondImage("https://s3.test/both", "image/svg+xml", SVG);
    await render({ format: "svg", useAbsoluteBounds: true, version: "v1" });
    expect(onlyImageQuery()).toMatchObject({
      ids: "1:2",
      scale: 2,
      format: "svg",
      version: "v1",
      svg_outline_text: "true",
      use_absolute_bounds: "true",
    });
  });

  it("fidelity requests never reach the live plugin even while linked", async () => {
    fixture.api.link.linked.add(FILE);
    let pluginAsked = 0;
    fixture.api.link.exportImpl = () => {
      pluginAsked += 1;
      return { mimeType: "image/png", data: PNG };
    };
    respondImage("https://s3.test/never-via-link", "image/svg+xml", SVG);
    const svg = await render({ format: "svg", version: "v1" });
    respondImage("https://s3.test/abs-via-rest", "image/png", PNG);
    const absolute = await render({ useAbsoluteBounds: true, version: "v1" });
    expect(svg.source).toBe("rest");
    expect(absolute.source).toBe("rest");
    expect(pluginAsked).toBe(0);
    expect(fixture.api.link.toolCalls).toEqual([]); // not even a probe of the plugin
  });

  it("the old crop path still uses the plugin when linked (semantics preserved)", async () => {
    fixture.api.link.linked.add(FILE);
    fixture.api.link.exportImpl = () => ({ mimeType: "image/png", data: PNG });
    const out = await render();
    expect(out.source).toBe("link");
    expect(fixture.api.link.toolCalls.map((c) => c.tool)).toEqual(["exportNode"]);
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toEqual([]);
  });

  it("absolute bytes are never served from, nor collided with, the crop cache", async () => {
    // Bytes the released code cached for the CROP semantics of this exact file/id/scale/format/version.
    const cropKey = `render-rest/${FILE}/1:2@2x@png@v1`;
    fixture.api.cache.putBytes(cropKey, { mimeType: "image/png", data: PNG });

    respondImage("https://s3.test/absolute", "image/png", PNG);
    const absolute = await render({ useAbsoluteBounds: true, version: "v1" });
    // The crop entry must NOT answer an absolute request: exactly one REST call, with the new flag.
    expect(onlyImageQuery().use_absolute_bounds).toBe("true");

    const absoluteKey = `render-rest/${FILE}/1:2@2x@png@absolute@v1`;
    expect(await fixture.api.cache.getBytes(absoluteKey)).not.toBeNull();
    // The crop entry is a separate namespace, not overwritten by the absolute store.
    expect(await fixture.api.cache.getBytes(cropKey)).not.toBeNull();

    // Second absolute request: served from its own key, no second REST round-trip...
    const before = fixture.api.rest.callsTo(`/v1/images/${FILE}`).length;
    const again = await render({ useAbsoluteBounds: true, version: "v1" });
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(before);
    expect(again.images["1:2"]).toEqual(absolute.images["1:2"]);

    // ...and the crop request is STILL served from the original crop key (untouched bytes).
    const crop = await render();
    // no new images REST call for the crop either (served from the crop namespace)
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(before);
    expect(crop.images["1:2"]).toEqual(absolute.images["1:2"]); // same png bytes, different namespace
  });

  it("a pinned-version fidelity request answers from REST for that version", async () => {
    // Same pinned rule as the crop snapshot path (32.1): the fidelity query carries the
    // requested version, and its cache key is versioned too — never the current one.
    respondImage("https://s3.test/pinned-absolute", "image/png", PNG);
    const out = await render({ version: "v9", useAbsoluteBounds: true });
    expect(out.source).toBe("rest");
    expect(onlyImageQuery()).toMatchObject({ version: "v9", use_absolute_bounds: "true" });
    expect(
      await fixture.api.cache.getBytes(`render-rest/${FILE}/1:2@2x@png@absolute@v9`),
    ).not.toBeNull();
    expect(await fixture.api.cache.getBytes(`render-rest/${FILE}/1:2@2x@png@v9`)).toBeNull();
  });

  it("single-file export keeps its existing semantics — no ADR-0042 flags on its query", async () => {
    // ADR-0042 is a render-only contract: export must not gain the new options implicitly.
    fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, () => ({
      version: "v1",
      nodes: { "1:2": { id: "1:2", name: "Hero", type: "FRAME" } },
    }));
    fixture.api.rest.respond(`/v1/images/${FILE}`, ({ query }) => ({
      images: { [String(query.ids)]: "https://s3.test/export" },
    }));
    fixture.api.rest.provideBytes("https://s3.test/export", { mimeType: "image/png", data: PNG });
    const out = await fixture.handlers["figma.file.export.request"](
      {
        requestId: "r1",
        type: "figma.file.export.request",
        fileKey: FILE,
        nodeId: "1:2",
        format: "png",
        scale: 2,
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(out.file).not.toBeNull();
    const calls = fixture.api.rest.callsTo(`/v1/images/${FILE}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).not.toHaveProperty("svg_outline_text");
    expect(calls[0]!.query).not.toHaveProperty("use_absolute_bounds");
  });

  it("legacy single-file export SVG with a linked file still goes through the plugin", async () => {
    // The pre-ADR-0042 behavior root review restored: the renderNodes route must not gain a
    // format guard — export answers from the plugin's own svg export while linked.
    fixture.api.link.linked.add(FILE);
    fixture.api.rest.respond(`/v1/files/${FILE}/nodes`, () => ({
      version: "v1",
      nodes: { "1:2": { id: "1:2", name: "Hero", type: "FRAME" } },
    }));
    let pluginArgs: Record<string, unknown> | null = null;
    fixture.api.link.exportImpl = (nodeId, format, scale) => {
      pluginArgs = { nodeId, format, scale };
      return { mimeType: "image/svg+xml", data: SVG };
    };
    const out = await fixture.handlers["figma.file.export.request"](
      {
        requestId: "r1",
        type: "figma.file.export.request",
        fileKey: FILE,
        nodeId: "1:2",
        format: "svg",
        scale: 2,
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(pluginArgs).toEqual({ nodeId: "1:2", format: "svg", scale: 2 });
    expect(out.fileName).toBe("Hero@2x.svg");
    expect(out.file!.mimeType).toBe("image/svg+xml");
    expect(Buffer.from(out.file!.dataBase64, "base64")).toEqual(SVG);
    // No REST images call: the old plugin export path is intact.
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toEqual([]);
  });
});

// ── outline request coalescing (run-15 cold-mount evidence) ──────────────────

describe("outline coalescing", () => {
  const outlineRequest = (requestId: string, params: Record<string, unknown> = {}) =>
    ({
      requestId,
      type: "figma.file.outline.request",
      fileKey: FILE,
      ...params,
    }) as Parameters<(typeof fixture.handlers)["figma.file.outline.request"]>[0];
  const ask = (requestId: string, params?: Record<string, unknown>) =>
    fixture.handlers["figma.file.outline.request"](
      outlineRequest(requestId, params),
      fixture.api.ctx,
      SESSION,
    );

  it("shares one depth-3 read between simultaneous identical live requests", async () => {
    // Run-15: a real card click fired two outline requests a beat apart and the daemon fetched,
    // parsed, mapped and cache-wrote the whole file twice. The joiner must ride the leader's
    // flight, not start a second one.
    respondFile();
    const starter = ask("r1");
    const joiner = ask("r2");
    const [a, b] = await Promise.all([starter, joiner]);
    expect(a.outline).not.toBeNull();
    expect(b.outline).toBe(a.outline); // one flight, one result
    const reads = fixture.api.rest.callsTo(`/v1/files/${FILE}`);
    expect(reads).toHaveLength(1);
    // The shared read stays on the owning file's connection and tier — never a cross-connection ride.
    expect(reads[0]).toMatchObject({ connectionId: "fgc_fake", tier: "1" });
    // The version resolve belongs to the flight too: one meta lookup, not two.
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(1);
  });

  it("does not share between a live read and a pinned-version read", async () => {
    fixture.api.rest.respond(`/v1/files/${FILE}`, ({ query }) => fileJson(String(query.version)));
    const [live, pinnedA, pinnedB] = await Promise.all([
      ask("r1"),
      ask("r2", { version: "v9" }),
      ask("r3", { version: "v9" }),
    ]);
    const versions = fixture.api.rest
      .callsTo(`/v1/files/${FILE}`)
      .map((call) => String(call.query.version))
      .sort();
    // The two v9 reads share one flight; the live read is its own key and never joins them.
    expect(versions).toEqual(["v1", "v9"]);
    for (const call of fixture.api.rest.callsTo(`/v1/files/${FILE}`))
      expect(call).toMatchObject({ connectionId: "fgc_fake", tier: "1" });
    expect(pinnedB.outline).toBe(pinnedA.outline);
    expect(live.outline!.version).toBe("v1");
    expect(pinnedA.outline!.version).toBe("v9");
  });

  it("does not share a flight across two service contexts", async () => {
    // The exported figmaContent is a module singleton serving several FigmaService contexts
    // (distinct homes). Both contexts here carry the SAME connection and file key; flights
    // must be scoped per context, so the foreign read dispatches its own REST, maps on its
    // own ctx and answers its own disk cache instead of riding the first context's leader.
    const homeB = mkdtempSync(path.join(os.tmpdir(), "jad-figma-content-b-"));
    try {
      const apiB = makeFigmaApi({ home: homeB, logger: pino({ level: "silent" }) });
      apiB.store.addFile(makeFile(FILE));
      apiB.rest.respond(`/v1/files/${FILE}/meta`, metaJson("v1"));
      apiB.rest.respond(`/v1/files/${FILE}`, () => fileJson("v1"));
      respondFile();
      const [a, b] = await Promise.all([
        ask("r1"),
        fixture.handlers["figma.file.outline.request"](outlineRequest("r2"), apiB.ctx, SESSION),
      ]);
      expect(a.outline).not.toBeNull();
      expect(b.outline).not.toBeNull();
      expect(b.outline).not.toBe(a.outline); // each context computed its own answer
      expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(1);
      expect(apiB.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(1);
      // A second same-context request still works: the settled flight is gone, the warm
      // per-version disk cache answers it — per-context scoping did not disable either path.
      const c = await ask("r3");
      expect(c.outline).toEqual(a.outline);
      expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(1);
    } finally {
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  it("keeps later requests on the normal path once a shared flight settles", async () => {
    respondFile();
    await Promise.all([ask("r1"), ask("r2")]);
    // The settled flight left no entry behind: a third request re-enters outline() and gets the
    // per-version disk cache answer (zero new REST calls), exactly like any warm read.
    respondFile();
    const third = await ask("r3");
    expect(third.outline).toEqual(await ask("r4").then((r) => r.outline));
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}`)).toHaveLength(1);
  });
});

// ── files.add primes the content version memo (avoidable Tier-3 meta double-fetch) ─

describe("add-then-outline version prime", () => {
  const add = (fileKey: string) =>
    filesHandlers["figma.files.add.request"](
      {
        requestId: "r1",
        type: "figma.files.add.request",
        connectionId: "fgc_fake",
        url: `https://www.figma.com/design/${fileKey}/title`,
      } as Parameters<(typeof filesHandlers)["figma.files.add.request"]>[0],
      fixture.api.ctx,
    );
  const outline = (fileKey: string) => {
    const handlers = figmaContent.handlers();
    return handlers["figma.file.outline.request"](
      { requestId: "r2", type: "figma.file.outline.request", fileKey } as Parameters<
        ReturnType<(typeof figmaContent)["handlers"]>["figma.file.outline.request"]
      >[0],
      fixture.api.ctx,
      SESSION,
    );
  };

  it("answers the first outline from the add's verified version — one meta total, no prewarm", async () => {
    const KEY = "PRIMEOK";
    fixture.api.rest.respond(`/v1/files/${KEY}/meta`, metaJson("v1"));
    fixture.api.rest.respond(`/v1/files/${KEY}`, () => fileJson("v1"));
    const added = await add(KEY);
    expect(added.file.lastVersion).toBe("v1");
    expect(fixture.api.rest.callsTo(`/v1/files/${KEY}/meta`)).toHaveLength(1); // the add's own

    const { outline: answer } = await outline(KEY);
    expect(answer!.version).toBe("v1");
    // The resolver rode the prime: no second meta immediately after the add.
    expect(fixture.api.rest.callsTo(`/v1/files/${KEY}/meta`)).toHaveLength(1);
    // And nothing was prewarmed: the cold outline still cost exactly one depth-3 read.
    expect(fixture.api.rest.callsTo(`/v1/files/${KEY}`)).toHaveLength(1);
  });

  it("re-resolves meta once the primed version passes the 60 s TTL", async () => {
    const KEY = "PRIMETTL";
    fixture.api.rest.respond(`/v1/files/${KEY}/meta`, metaJson("v1"));
    fixture.api.rest.respond(`/v1/files/${KEY}`, () => fileJson("v1"));
    await add(KEY);
    await outline(KEY); // primed → still one meta
    expect(fixture.api.rest.callsTo(`/v1/files/${KEY}/meta`)).toHaveLength(1);

    fixture.api.setNow(fixture.api.now() + 61_000);
    const { outline: answer } = await outline(KEY);
    expect(answer!.version).toBe("v1");
    // Expiry revalidates: the memo expired, so the resolver fetched its own meta — and the
    // per-version disk cache still answered the content with zero new depth-3 reads.
    expect(fixture.api.rest.callsTo(`/v1/files/${KEY}/meta`)).toHaveLength(2);
    expect(fixture.api.rest.callsTo(`/v1/files/${KEY}`)).toHaveLength(1);
  });

  it("does not prime when the add succeeded but its metadata carried no version", async () => {
    const KEY = "PRIMENOV";
    fixture.api.rest.respond(`/v1/files/${KEY}/meta`, {
      file: { name: "Marketing Site", last_touched_at: "2026-03-01T10:00:00Z" },
    });
    fixture.api.rest.respond(`/v1/files/${KEY}`, () => fileJson("v7"));
    const added = await add(KEY);
    expect(added.file.lastVersion ?? null).toBeNull();

    fixture.api.rest.respond(`/v1/files/${KEY}/meta`, metaJson("v7")); // resolver's own answer
    const { outline: answer } = await outline(KEY);
    expect(answer!.version).toBe("v7");
    // Two metas = the add's + the outline resolver's own fetch: a version-less add primed nothing.
    expect(fixture.api.rest.callsTo(`/v1/files/${KEY}/meta`)).toHaveLength(2);
  });

  it("does not prime when the add fails, even though its meta carried a version", async () => {
    const KEY = "PRIMEFAIL";
    fixture.api.rest.respond(`/v1/files/${KEY}/meta`, {
      file: { version: "v1", last_touched_at: "2026-03-01T10:00:00Z" },
    }); // no name → the add throws AFTER fetching a versioned meta
    await expect(add(KEY)).rejects.toMatchObject({ code: "figma_error" });

    fixture.api.store.addFile(makeFile(KEY)); // the file exists from an earlier successful add
    fixture.api.rest.respond(`/v1/files/${KEY}/meta`, metaJson("v1"));
    fixture.api.rest.respond(`/v1/files/${KEY}`, () => fileJson("v1"));
    const { outline: answer } = await outline(KEY);
    expect(answer!.version).toBe("v1");
    // Two metas = the failed add's + the outline resolver's own fetch: nothing was primed.
    expect(fixture.api.rest.callsTo(`/v1/files/${KEY}/meta`)).toHaveLength(2);
  });
});
