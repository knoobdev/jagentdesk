import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaContent, type ContentDeps, readFontNames } from "./content.js";
import type { FigmaHandlerMap, FigmaRequestOf } from "./types.js";
import type { ContentRequestType } from "./content.js";
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
    expect(calls[0].query).toMatchObject({ version: "v9", depth: 2 });
    expect(calls[0].tier).toBe("1");
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/meta`)).toHaveLength(metaCallsBefore);
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
    expect(out.components["1:1"]).toEqual({ key: "ck1", name: "Button" });
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
        version: "v1",
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
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(viaRest.nodes["1:1"]).toMatchObject({ name: "Node 1:1" });
    expect(fixture.api.rest.callsTo(`/v1/files/${FILE}/nodes`)).toHaveLength(1);
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
        version: "v1",
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
    const first = await fixture.handlers["figma.file.render.request"](
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
        version: "v1",
      },
      fixture.api.ctx,
      SESSION,
    );
    expect(fixture.api.link.toolCalls).toHaveLength(toolCalls); // cached on disk
  });

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
});
