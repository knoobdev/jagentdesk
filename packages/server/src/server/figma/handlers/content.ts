import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Dirent } from "node:fs";
import type {
  FigmaBytes,
  FigmaFile,
  FigmaFrameSummary,
  FigmaNode,
  FigmaOutline,
  FigmaPage,
  FigmaSource,
  FigmaVersion,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { writePrivateFileAtomicSync } from "../../private-files.js";
import { FigmaServiceError, type FigmaContext } from "../context.js";
import { pageFlowStartingPoints } from "../prototype.js";
import type { FigmaHandlerMap } from "./types.js";

// Outline, nodes, image fills, fallback renders, export, versions, fonts, watches (32.5, 32.8).
// Owner: W4.
//
// Facts come from the Figma REST API (endpoint tiers per figma-integration.md §3.1/§4) or from
// Figma Link while the plugin has that file open, and everything is cached on disk by
// (fileKey, version) so a viewer session costs one Tier-1 call per frame per version (32.8).
// Clients never see a Figma URL: renders, image fills, exports and fonts leave as bytes
// (base64 in FigmaBytes).

export type ContentRequestType =
  | "figma.file.outline.request"
  | "figma.file.nodes.request"
  | "figma.file.imageFills.request"
  | "figma.file.render.request"
  | "figma.file.export.request"
  | "figma.file.versions.request"
  | "figma.fonts.get.request"
  | "figma.file.watch.request"
  | "figma.file.unwatch.request";

const DOCUMENT_NODE_ID = "0:0";
// 32.8: while a file is watched, `GET /v1/files/:key/meta` (Tier 3) is polled every 60 s, and the
// resolved current version is reused for cache keys inside that window.
export const FIGMA_WATCH_POLL_MS = 60_000;
export const FIGMA_VERSION_RESOLVE_TTL_MS = 60_000;
// Figma counts a multi-id request as one hit (figma-integration.md §4.4), so ids are batched.
const NODES_BATCH_SIZE = 10;
const RENDER_BATCH_SIZE = 20;
const VERSIONS_PAGE_SIZE = 50;
// 32.5.1: the Google Fonts fallback uses the documented CSS API
// (https://developers.google.com/fonts/docs/css2), not the fonts.google.com/download ZIP
// route — that endpoint answers non-browser clients with the site's HTML shell, so the
// old unzipSync path could never produce bytes. A stable explicit non-browser UA makes
// css2 serve exactly one full-coverage TTF per requested axis tuple (verified for
// Inter/Roboto incl. Vietnamese in w5-font-download-spike); a browser UA would get the
// per-subset woff2 sprawl instead. The UA string is load-bearing for the response shape,
// so it is pinned here rather than left to the fetch default.
const GOOGLE_FONTS_CSS2_URL = "https://fonts.googleapis.com/css2";
const GOOGLE_FONTS_ASSET_HOST = "fonts.gstatic.com";
const GOOGLE_FONTS_USER_AGENT = "JAgentDesk/1.0 (daemon font fetch)";

// ── REST response shapes (only the fields these handlers read) ────────────────

interface RestColor {
  r?: unknown;
  g?: unknown;
  b?: unknown;
  a?: unknown;
}

interface RestNode {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  children?: RestNode[];
  absoluteBoundingBox?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  backgroundColor?: RestColor;
  // CANVAS (page) nodes carry the flow starting points (figma-integration.md §5.1).
  flowStartingPoints?: RestFlowStart[];
}

interface RestFlowStart {
  nodeId?: unknown;
  name?: unknown;
}

interface RestFile {
  name?: unknown;
  version?: unknown;
  lastModified?: unknown;
  editorType?: unknown;
  document?: RestNode;
}

/** One entry of the documented `GET /v1/files/:key/nodes` `nodes` map. */
interface RestNodeEntry {
  document?: RestNode;
  components?: Record<string, { key?: unknown; name?: unknown; remote?: unknown }>;
  styles?: Record<string, { key?: unknown; name?: unknown; styleType?: unknown }>;
  schemaVersion?: unknown;
  // A flat node (no `document` envelope) is tolerated; it is identified by its own id.
  id?: unknown;
}

interface RestNodesResponse {
  err?: unknown;
  version?: unknown;
  nodes?: Record<string, RestNodeEntry | null>;
  // Some payloads (and every pre-doc fake) put the library maps at the response root.
  components?: Record<string, { key?: unknown; name?: unknown; remote?: unknown }>;
  styles?: Record<string, { key?: unknown; name?: unknown; styleType?: unknown }>;
}

interface RestImagesResponse {
  err?: unknown;
  images?: Record<string, string | null>;
}

interface RestVersionsResponse {
  versions?: Array<{
    id?: unknown;
    label?: unknown;
    description?: unknown;
    created_at?: unknown;
    user?: { handle?: unknown } | null;
  }>;
}

interface RestMeta {
  version?: unknown;
  file?: { version?: unknown };
}

interface ComponentMeta {
  key: string;
  name: string;
  // False/absent for a component defined in this file, true when it comes from a team library.
  remote?: boolean;
}

interface StyleMeta {
  key: string;
  name: string;
  styleType: string;
}

interface LibraryMeta {
  components: Record<string, ComponentMeta>;
  styles: Record<string, StyleMeta>;
}

/** Cache entries are wrapped so a cached `null` (unknown node id) differs from a cache miss. */
interface Wrapped<T> {
  data: T;
}

const wrap = <T>(data: T): Wrapped<T> => ({ data });

type RenderFormat = "png" | "jpg" | "svg" | "pdf";

const RENDER_MIME: Record<RenderFormat, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

function toBase64Bytes(value: { mimeType: string; data: Buffer }): FigmaBytes {
  return { mimeType: value.mimeType, dataBase64: value.data.toString("base64") };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The version from `GET /v1/files/:key/meta`, documented as `{ file: { version, … } }`; the
 * flat shape is tolerated so a host that answers the old way still resolves.
 */
function metaVersion(meta: RestMeta | null | undefined): string {
  const file = meta?.file;
  return asString(file && typeof file === "object" ? file.version : meta?.version);
}

function parseMs(iso: unknown): number {
  const at = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : 0;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function requireFile(ctx: FigmaContext, fileKey: string): Promise<FigmaFile> {
  const file = await ctx.store.getFile(fileKey);
  if (!file)
    throw new FigmaServiceError("not_found", `File ${fileKey} has not been added to JAgentDesk`);
  return file;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── current version resolution ────────────────────────────────────────────────

class FileVersionCache {
  private readonly entries = new Map<string, { version: string; at_ms: number }>();

  constructor(private readonly ttlMs: number = FIGMA_VERSION_RESOLVE_TTL_MS) {}

  peek(fileKey: string): string | null {
    return this.entries.get(fileKey)?.version ?? null;
  }

  prime(ctx: FigmaContext, fileKey: string, version: string): void {
    this.entries.set(fileKey, { version, at_ms: ctx.now() });
  }

  /** The live version of the file, so every cache key below is (fileKey, version) exact. */
  async current(ctx: FigmaContext, file: FigmaFile): Promise<string> {
    const hit = this.entries.get(file.fileKey);
    if (hit && ctx.now() - hit.at_ms < this.ttlMs) return hit.version;
    const meta = await ctx.rest.getJson<RestMeta>({
      connectionId: file.connectionId,
      path: `/v1/files/${file.fileKey}/meta`,
      tier: "3",
    });
    const version = metaVersion(meta);
    if (!version)
      throw new FigmaServiceError(
        "figma_error",
        `Figma did not report a version for ${file.fileKey}`,
      );
    this.entries.set(file.fileKey, { version, at_ms: ctx.now() });
    return version;
  }
}

// ── outline mapping (32.5.1, ADR-0039) ───────────────────────────────────────

// The outline read: document=0, page=1, page children=2, section children=3. A section at
// the boundary has no returned children — the REST answer truncates it, it is not empty.
const OUTLINE_REST_DEPTH = 3;

function colorToHex(color: RestColor | undefined): string | undefined {
  if (!color) return undefined;
  const part = (value: unknown): string | null => {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
    return byte.toString(16).padStart(2, "0");
  };
  const r = part(color.r);
  const g = part(color.g);
  const b = part(color.b);
  if (r === null || g === null || b === null) return undefined;
  return `#${r}${g}${b}${part(color.a ?? 1) ?? "ff"}`;
}

function frameSummaryFromRest(node: RestNode): FigmaFrameSummary | null {
  const box = node.absoluteBoundingBox;
  if (!box) return null; // only nodes with bounds can be placed on canvas
  return {
    id: asString(node.id),
    name: asString(node.name),
    type: asString(node.type),
    bounds: { x: num(box.x), y: num(box.y), width: num(box.width), height: num(box.height) },
    backgroundColor: colorToHex(node.backgroundColor),
  };
}

/**
 * A SECTION is a background/label entry, never a unit of subtree loading: its direct children
 * flatten into ordered summaries — parent first, then children, siblings in data order — so
 * the canvas can place and hit-test screens without loading a section tree. FRAME, COMPONENT,
 * INSTANCE and every other drawable node stop the walk: a frame nested inside a screen is
 * content, not its own canvas screen. Children flattened from within a section (including a
 * nested section) carry `parentId`; `childrenLoaded` marks whether the section's direct
 * children are known — a section sitting at the document's returned depth boundary reads false
 * even when the truncated answer carries `children: []`, and is never faked as an empty one.
 */
function collectSectionFlattened(
  nodes: RestNode[],
  level: number,
  parentId: string | undefined,
  knownDepth: number,
  out: FigmaFrameSummary[],
): void {
  for (const node of nodes) {
    const children = Array.isArray(node.children) ? node.children : null;
    const summary = frameSummaryFromRest(node);
    if (summary) {
      if (asString(node.type) === "SECTION")
        summary.childrenLoaded = children !== null && level < knownDepth;
      out.push(parentId === undefined ? summary : { ...summary, parentId });
    }
    if (asString(node.type) !== "SECTION" || !children) continue;
    collectSectionFlattened(children, level + 1, asString(node.id), knownDepth, out);
  }
}

/**
 * `knownDepth` is the deepest level the payload provably carries children for: the depth-3
 * outline answer (3) or a whole plugin document, which has no cut (Infinity).
 */
function pageFromRest(page: RestNode, knownDepth: number): FigmaPage {
  const frames: FigmaFrameSummary[] = [];
  collectSectionFlattened(page.children ?? [], 2, undefined, knownDepth, frames);
  return {
    id: asString(page.id),
    name: asString(page.name),
    backgroundColor: colorToHex(page.backgroundColor),
    frames,
    // The page node itself carries its flow starting points (§5.1) — the file root does not.
    // ADR-0039 keeps them as REST returned them: no invented flows, none dropped.
    flowStartingPoints: pageFlowStartingPoints(page),
  };
}

function outlineFromRest(json: RestFile, fileKey: string, version: string): FigmaOutline {
  return {
    fileKey,
    name: asString(json.name),
    version: asString(json.version) || version,
    lastModified_ms: parseMs(json.lastModified),
    editorType: asString(json.editorType) || "figma",
    pages: (json.document?.children ?? [])
      .filter((node) => asString(node.type) === "CANVAS")
      .map((page) => pageFromRest(page, OUTLINE_REST_DEPTH)),
    source: "rest",
  };
}

function linkedOutline(
  file: FigmaFile,
  document: FigmaNode | null | undefined,
  version: string,
): FigmaOutline | null {
  const pages = (document?.children ?? []).filter((node) => node.type === "CANVAS");
  if (pages.length === 0) return null;
  return {
    fileKey: file.fileKey,
    name: file.name,
    version,
    lastModified_ms: 0,
    editorType: "figma",
    // The plugin hands over the whole document: no depth cut, so every section's children
    // are known.
    pages: pages.map((page) => pageFromRest(page as unknown as RestNode, Infinity)),
    source: "link",
  };
}

// ── fonts (32.5.1 text: system folders, then a Google Fonts cache) ────────────

export interface DownloadedFont {
  mimeType: string;
  data: Buffer;
}

export interface FontDeps {
  /** Directories scanned recursively for system fonts; defaults to the OS font folders. */
  searchDirs?: string[];
  /** Downloads a family from Google Fonts; injectable so tests never hit the network. */
  download?: (family: string, style: string) => Promise<DownloadedFont | null>;
}

interface FontIndexEntry {
  family: string;
  style: string;
  file: string;
  mimeType: string;
}

function normalizeFontName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function fileNameToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function decodeUtf16Be(bytes: Buffer): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2)
    out += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
  return out;
}

function readSfntNames(buffer: Buffer, base: number): { family: string; style: string } | null {
  try {
    const flavor = buffer.readUInt32BE(base);
    const sfntFlavors = [0x0001_0000, 0x4f54_544f, 0x7472_7565]; // ttf | OTTO | true
    if (!sfntFlavors.includes(flavor)) return null;
    const numTables = buffer.readUInt16BE(base + 4);
    let nameOffset = -1;
    for (let i = 0; i < numTables; i += 1) {
      const record = base + 12 + i * 16;
      if (buffer.toString("latin1", record, record + 4) === "name")
        nameOffset = buffer.readUInt32BE(record + 8);
    }
    if (nameOffset < 0 || nameOffset + 6 > buffer.length) return null;
    const count = buffer.readUInt16BE(nameOffset + 2); // +0 is the table version
    const storage = nameOffset + buffer.readUInt16BE(nameOffset + 4);
    const names = new Map<number, string>();
    for (let i = 0; i < count; i += 1) {
      const record = nameOffset + 6 + i * 12;
      const platform = buffer.readUInt16BE(record);
      const nameId = buffer.readUInt16BE(record + 6);
      const length = buffer.readUInt16BE(record + 8);
      const offset = buffer.readUInt16BE(record + 10);
      if (nameId > 17) continue;
      const start = storage + offset;
      if (start + length > buffer.length) continue;
      const raw = buffer.subarray(start, start + length);
      names.set(nameId, platform === 1 ? raw.toString("latin1") : decodeUtf16Be(raw));
    }
    // Preferred family/subfamily (16/17) win over 1/2 where present (OpenType name spec).
    const family = names.get(16) ?? names.get(1);
    if (!family) return null;
    return { family, style: names.get(17) ?? names.get(2) ?? "Regular" };
  } catch {
    return null;
  }
}

/** Reads (family, style) from the name table of a sfnt font (TTF/OTF), or the first readable
 *  font of a TTC collection. Null when the file is not sfnt (WOFF is skipped) or unreadable. */
export function readFontNames(buffer: Buffer): { family: string; style: string } | null {
  const tag = buffer.length >= 12 ? buffer.toString("latin1", 0, 4) : "";
  if (tag === "ttcf") {
    const count = buffer.readUInt32BE(8);
    for (let i = 0; i < count; i += 1) {
      const found = readSfntNames(buffer, buffer.readUInt32BE(12 + i * 4));
      if (found) return found;
    }
    return null;
  }
  return readSfntNames(buffer, 0);
}

function hasTable(buffer: Buffer, table: string): boolean {
  try {
    const numTables = buffer.readUInt16BE(4);
    for (let i = 0; i < numTables; i += 1)
      if (buffer.toString("latin1", 12 + i * 16, 16 + i * 16) === table) return true;
  } catch {
    // not sfnt
  }
  return false;
}

const FONT_FILE_EXTENSIONS: Record<string, string> = {
  "font/otf": ".otf",
  "font/collection": ".ttc",
  "font/ttf": ".ttf",
};

function fontMimeType(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".otf")) return "font/otf";
  if (lower.endsWith(".ttc")) return "font/collection";
  return "font/ttf";
}

function matchesFont(
  names: { family: string; style: string } | null,
  wantedFamily: string,
  wantedStyle: string,
  bytes: Buffer,
): boolean {
  if (!names) return false;
  if (normalizeFontName(names.family) !== wantedFamily) return false;
  // A variable font carries every style in one file (its name table usually says Regular).
  return (
    normalizeFontName(names.style) === wantedStyle ||
    (wantedStyle !== "regular" && hasTable(bytes, "fvar"))
  );
}

// ── Google Fonts CSS API download (32.5.1) ────────────────────────────────────
// The fonts.google.com/download?family= ZIP route is dead for non-browser clients (it
// answers the HTML shell), so the fallback acquires bytes through the documented CSS2
// API instead: request the exact family:ital,wght tuple with a stable non-browser UA and
// the response carries a single full-coverage TTF (incl. Vietnamese) on fonts.gstatic.com.
// Every stage fails closed — an ambiguous, off-host, non-sfnt or wrong-named answer
// becomes null so the caller keeps the real Figma raster fallback. text=/subset slicing
// and the /download/list internal diagnostic are deliberately not used.

// Mirror of packages/app/src/figma/font-style.ts, the single authority shared by the
// renderer and the player. The server must not depend on app code, so this table has to
// stay in sync with that file when weight tokens change.
const STYLE_WEIGHTS: [string, number][] = [
  ["thin", 100],
  ["hairline", 100],
  ["extralight", 200],
  ["ultralight", 200],
  ["light", 300],
  ["regular", 400],
  ["normal", 400],
  ["medium", 500],
  ["semibold", 600],
  ["demibold", 600],
  ["bold", 700],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["black", 900],
  ["heavy", 900],
];

function weightForStyle(styleName: string): number {
  // "Semi Bold" must not hit the "Bold" token: normalise spacing, then take the LONGEST
  // matching token so "semibold"/"extrabold"/"demibold" win over "bold".
  const compact = styleName.toLowerCase().replace(/[\s_-]+/g, "");
  const tokens = [...STYLE_WEIGHTS].sort((a, b) => b[0].length - a[0].length);
  for (const [token, value] of tokens) {
    if (compact.includes(token)) return value;
  }
  return 400;
}

function isItalicStyle(styleName: string): boolean {
  return /italic|oblique/.test(styleName.toLowerCase());
}

function compactFontToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function googleFontsCss2Url(family: string, weight: number, italic: boolean): string {
  const axes = italic ? `ital,wght@1,${weight}` : `wght@${weight}`;
  return `${GOOGLE_FONTS_CSS2_URL}?family=${encodeURIComponent(family)}:${axes}`;
}

function isGoogleFontsAssetUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" && url.hostname === GOOGLE_FONTS_ASSET_HOST;
  } catch {
    return false;
  }
}

/**
 * The one font URL the css2 response serves for the requested face, or null when the
 * answer is not exactly what was asked for: zero faces (HTML shell — the regression that
 * killed the ZIP route), more than one face (per-subset woff2 sprawl), descriptors that
 * disagree with the requested tuple, or multiple/foreign src URLs.
 */
function css2FontUrl(css: string, family: string, weight: number, italic: boolean): string | null {
  const faces = css.match(/@font-face\s*\{[^{}]*\}/g);
  if (!faces || faces.length !== 1) return null;
  const face = faces[0];
  const declaredFamily = /font-family\s*:\s*['"]([^'"]*)['"]/.exec(face)?.[1];
  if (!declaredFamily || normalizeFontName(declaredFamily) !== normalizeFontName(family))
    return null;
  const declaredWeight = Number(/font-weight\s*:\s*(\d+)/.exec(face)?.[1]);
  if (declaredWeight !== weight) return null;
  const declaredStyle = /font-style\s*:\s*([A-Za-z]+)/.exec(face)?.[1]?.toLowerCase();
  if (declaredStyle !== (italic ? "italic" : "normal")) return null;
  const sources = face.match(/url\(\s*['"]?([^'"()\s]+)/g);
  if (!sources || sources.length !== 1) return null;
  const href = sources[0].replace(/^url\(\s*['"]?/, "");
  return isGoogleFontsAssetUrl(href) ? href : null;
}

async function fetchGoogleFontsBytes(href: string): Promise<Buffer | null> {
  const response = await fetch(href, { redirect: "follow" });
  if (!response.ok) return null;
  // Validate the FINAL host as well as the requested one: a redirect off gstatic means
  // the CDN moved or intercepted, and unverified bytes are worse than a raster fallback.
  if (response.url && !isGoogleFontsAssetUrl(response.url)) return null;
  return Buffer.from(await response.arrayBuffer());
}

/** sfnt flavor → mime. Only reached after readFontNames proved the buffer is sfnt. */
function sfntMimeType(buffer: Buffer): string {
  const tag = buffer.length >= 4 ? buffer.toString("latin1", 0, 4) : "";
  if (tag === "OTTO") return "font/otf";
  if (tag === "ttcf") return "font/collection";
  return "font/ttf";
}

export async function defaultGoogleFontsDownload(
  family: string,
  style: string,
): Promise<DownloadedFont | null> {
  const requestedStyle = style.trim() || "Regular";
  const weight = weightForStyle(requestedStyle);
  const italic = isItalicStyle(requestedStyle);
  const cssResponse = await fetch(googleFontsCss2Url(family, weight, italic), {
    redirect: "follow",
    headers: { "User-Agent": GOOGLE_FONTS_USER_AGENT },
  });
  if (!cssResponse.ok) return null;
  const css = await cssResponse.text();
  // The HTML shell answers 200 like a stylesheet would; it carries no face.
  if (!css.includes("@font-face")) return null;
  const href = css2FontUrl(css, family, weight, italic);
  if (!href) return null;
  const data = await fetchGoogleFontsBytes(href);
  if (!data) return null;
  // Null for anything that is not a readable sfnt — HTML, woff2, a truncated body.
  const names = readFontNames(data);
  if (!names) return null;
  if (normalizeFontName(names.family) !== normalizeFontName(family)) return null;
  // The name table must agree with the requested style: a variable font whose name table
  // says Regular is NOT proof of Italic, so unlike matchesFont (system folders, where a
  // variable file genuinely carries every style) there is no fvar escape here.
  if (compactFontToken(names.style) !== compactFontToken(requestedStyle)) return null;
  return { mimeType: sfntMimeType(data), data };
}

/**
 * The index.json read-modify-write runs one save at a time per fonts dir: two flights for
 * different fonts would otherwise both read the pre-write index, and the later write would
 * silently drop the earlier entry.
 */
const googleFontIndexQueues = new Map<string, Promise<void>>();

function queueGoogleFontIndexWrite(dir: string, write: () => Promise<void>): Promise<void> {
  const previous = googleFontIndexQueues.get(dir) ?? Promise.resolve();
  const next = previous.then(write, write);
  googleFontIndexQueues.set(
    dir,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export class FigmaFontProvider {
  private readonly attempted = new Set<string>();
  /**
   * Concurrent requests for the same family+style share one download (and one cache
   * save). Without it the `attempted` memo would turn every sibling but the first into a
   * null — a false "font unavailable" that silently downgrades a whole text subtree to
   * the raster fallback.
   */
  private readonly inFlight = new Map<string, Promise<DownloadedFont | null>>();
  private readonly searchDirs: string[] | null;
  private readonly downloadFont: (family: string, style: string) => Promise<DownloadedFont | null>;

  constructor(deps: FontDeps = {}) {
    this.searchDirs = deps.searchDirs ?? null;
    this.downloadFont = deps.download ?? defaultGoogleFontsDownload;
  }

  async getFont(ctx: FigmaContext, family: string, style: string): Promise<FigmaBytes | null> {
    const trimmedFamily = family.trim();
    const trimmedStyle = style.trim() || "Regular";
    if (!trimmedFamily) return null;
    const wantedFamily = normalizeFontName(trimmedFamily);
    const wantedStyle = normalizeFontName(trimmedStyle);
    const downloaded = await this.fromGoogleCache(ctx, wantedFamily, wantedStyle);
    if (downloaded) return toBase64Bytes(downloaded);
    const system = await this.fromSystemFonts(wantedFamily, wantedStyle);
    if (system) return toBase64Bytes(system);
    const attempt = `${wantedFamily} ${wantedStyle}`;
    const shared = this.inFlight.get(attempt);
    if (shared) return this.joinFlight(shared);
    if (this.attempted.has(attempt)) return null;
    this.attempted.add(attempt);
    const flight = this.downloadOnce(ctx, trimmedFamily, trimmedStyle);
    this.inFlight.set(attempt, flight);
    try {
      return await this.joinFlight(flight);
    } finally {
      this.inFlight.delete(attempt);
    }
  }

  private async joinFlight(flight: Promise<DownloadedFont | null>): Promise<FigmaBytes | null> {
    const font = await flight;
    return font ? toBase64Bytes(font) : null;
  }

  /** Download plus cache save are one flight so joiners never race the index write. */
  private async downloadOnce(
    ctx: FigmaContext,
    family: string,
    style: string,
  ): Promise<DownloadedFont | null> {
    try {
      const fetched = await this.downloadFont(family, style);
      if (!fetched) return null;
      await this.saveToGoogleCache(ctx, family, style, fetched);
      return fetched;
    } catch (error) {
      ctx.logger.info(
        { family, err: error instanceof Error ? error.message : String(error) },
        "figma google fonts download failed",
      );
      return null;
    }
  }

  private async fromSystemFonts(
    wantedFamily: string,
    wantedStyle: string,
  ): Promise<DownloadedFont | null> {
    for (const dir of this.searchDirs ?? defaultFontSearchDirs()) {
      const found = await this.searchDir(dir, wantedFamily, wantedStyle);
      if (found) return found;
    }
    return null;
  }

  private async searchDir(
    dir: string,
    wantedFamily: string,
    wantedStyle: string,
  ): Promise<DownloadedFont | null> {
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile() || !/\.(ttf|otf|ttc)$/i.test(entry.name)) continue;
        // Filename pre-filter; the name table stays the authority.
        if (!fileNameToken(entry.name).includes(fileNameToken(wantedFamily))) continue;
        let bytes: Buffer;
        try {
          bytes = await fs.readFile(full);
        } catch {
          continue;
        }
        if (!matchesFont(readFontNames(bytes), wantedFamily, wantedStyle, bytes)) continue;
        return { mimeType: fontMimeType(entry.name), data: bytes };
      }
    }
    return null;
  }

  private dirOf(ctx: FigmaContext): string {
    return path.join(ctx.jagentdeskHome, "figma", "fonts");
  }

  private async readIndex(ctx: FigmaContext): Promise<FontIndexEntry[]> {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.dirOf(ctx), "index.json"), "utf8"));
      return Array.isArray(raw?.entries) ? (raw.entries as FontIndexEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async fromGoogleCache(
    ctx: FigmaContext,
    wantedFamily: string,
    wantedStyle: string,
  ): Promise<DownloadedFont | null> {
    for (const entry of await this.readIndex(ctx)) {
      if (
        normalizeFontName(entry.family) === wantedFamily &&
        normalizeFontName(entry.style) === wantedStyle
      ) {
        try {
          return {
            mimeType: entry.mimeType,
            data: await fs.readFile(path.join(this.dirOf(ctx), entry.file)),
          };
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private async saveToGoogleCache(
    ctx: FigmaContext,
    family: string,
    style: string,
    font: DownloadedFont,
  ): Promise<void> {
    const dir = this.dirOf(ctx);
    const ext = FONT_FILE_EXTENSIONS[font.mimeType] ?? ".ttf";
    const file = `${fileNameToken(family)}-${fileNameToken(style)}-${randomUUID().slice(0, 8)}${ext}`;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path.join(dir, file), font.data);
    await queueGoogleFontIndexWrite(dir, async () => {
      const entries = await this.readIndex(ctx);
      entries.push({ family, style, file, mimeType: font.mimeType });
      writePrivateFileAtomicSync(
        path.join(dir, "index.json"),
        JSON.stringify({ entries }, null, 2),
      );
    });
  }
}

function defaultFontSearchDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      "/System/Library/Fonts",
      "/System/Library/Fonts/Supplemental",
      "/Library/Fonts",
      path.join(home, "Library", "Fonts"),
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [
      path.join(process.env.SystemRoot ?? "C:\\Windows", "Fonts"),
      path.join(local, "Microsoft", "Windows", "Fonts"),
    ];
  }
  return [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    path.join(home, ".fonts"),
    path.join(home, ".local", "share", "fonts"),
  ];
}

// ── watches (32.8) ────────────────────────────────────────────────────────────

interface WatchRecord {
  fileKey: string;
  sessionKey: string;
}

interface FilePoller {
  timer: ReturnType<typeof setInterval>;
  baseline: string | null;
  inFlight: boolean;
}

export class FigmaFileWatches {
  private readonly watches = new Map<string, WatchRecord>();
  private readonly pollers = new Map<string, FilePoller>();
  private unsubLink: (() => void) | null = null;
  private ctx: FigmaContext | null = null;

  constructor(
    private readonly versions: FileVersionCache,
    private readonly intervalMs: number = FIGMA_WATCH_POLL_MS,
  ) {}

  get count(): number {
    return this.watches.size;
  }

  isPolling(fileKey: string): boolean {
    return this.pollers.has(fileKey);
  }

  watch(ctx: FigmaContext, fileKey: string, sessionKey: string): string {
    this.ctx = ctx;
    const watchId = randomUUID();
    this.watches.set(watchId, { fileKey, sessionKey });
    this.ensurePoller(fileKey);
    this.ensureLinkForwarding();
    return watchId;
  }

  unwatch(watchId: string): boolean {
    const record = this.watches.get(watchId);
    if (!record) return false;
    this.watches.delete(watchId);
    let stillWatched = false;
    for (const other of this.watches.values())
      if (other.fileKey === record.fileKey) stillWatched = true;
    if (!stillWatched) this.stopPoller(record.fileKey);
    if (this.watches.size === 0) this.stopLinkForwarding();
    return true;
  }

  dispose(): void {
    for (const watchId of this.watches.keys()) this.unwatch(watchId);
  }

  private ensurePoller(fileKey: string): void {
    if (this.pollers.has(fileKey)) return;
    const timer = setInterval(() => void this.poll(fileKey), this.intervalMs);
    timer.unref?.();
    this.pollers.set(fileKey, { timer, baseline: this.versions.peek(fileKey), inFlight: false });
  }

  private stopPoller(fileKey: string): void {
    const poller = this.pollers.get(fileKey);
    if (!poller) return;
    clearInterval(poller.timer);
    this.pollers.delete(fileKey);
  }

  private async poll(fileKey: string): Promise<void> {
    const ctx = this.ctx;
    const poller = this.pollers.get(fileKey);
    if (!ctx || !poller || poller.inFlight) return;
    // A linked file reports its own changes through the plugin; spend no Tier-3 budget on it.
    if (ctx.link.isLinked(fileKey)) return;
    poller.inFlight = true;
    try {
      const file = await ctx.store.getFile(fileKey);
      if (!file) return;
      const meta = await ctx.rest.getJson<RestMeta>({
        connectionId: file.connectionId,
        path: `/v1/files/${fileKey}/meta`,
        tier: "3",
      });
      const version = metaVersion(meta);
      if (!version || version === poller.baseline) return;
      poller.baseline = version;
      this.versions.prime(ctx, fileKey, version);
      this.pushChanged(ctx, fileKey, version, "rest");
    } catch (error) {
      ctx.logger.info(
        { fileKey, err: error instanceof Error ? error.message : String(error) },
        "figma watch poll failed",
      );
    } finally {
      poller.inFlight = false;
    }
  }

  private pushChanged(
    ctx: FigmaContext,
    fileKey: string,
    version: string,
    source: FigmaSource,
    nodeIds?: string[],
  ): void {
    for (const [watchId, record] of this.watches) {
      if (record.fileKey !== fileKey) continue;
      ctx.push({
        type: "figma.file.changed",
        watchId,
        fileKey,
        version,
        source,
        ...(nodeIds && nodeIds.length > 0 ? { nodeIds } : {}),
      });
    }
  }

  private ensureLinkForwarding(): void {
    const ctx = this.ctx;
    if (!ctx || this.unsubLink) return;
    this.unsubLink = ctx.link.onChange((event) => {
      const current = this.ctx;
      if (!event.fileKey || !current) return;
      if (this.watches.size === 0 || !current.link.isLinked(event.fileKey)) return;
      this.pushChanged(
        current,
        event.fileKey,
        this.versions.peek(event.fileKey) ?? "",
        "link",
        event.nodeIds,
      );
    });
  }

  private stopLinkForwarding(): void {
    this.unsubLink?.();
    this.unsubLink = null;
  }
}

// ── the content module ────────────────────────────────────────────────────────

export interface ContentDeps {
  watchPollMs?: number;
  nodesBatchSize?: number;
  versionTtlMs?: number;
  fonts?: FontDeps;
}

/**
 * The node inside a documented `nodes` entry (figma-integration.md §3.1). A flat node (no
 * `document` envelope, e.g. an older cached payload) is tolerated when it identifies itself.
 */
function restEntryNode(entry: RestNodeEntry | null): RestNode | null {
  if (!entry) return null;
  return entry.document ?? (typeof entry.id === "string" ? (entry as unknown as RestNode) : null);
}

/** Merges every `components`/`styles` map seen in a batch into the cached library metadata. */
function mergeLibraryMaps(
  libs: LibraryMeta,
  componentMaps: Array<Record<string, { key?: unknown; name?: unknown; remote?: unknown }>>,
  styleMaps: Array<Record<string, { key?: unknown; name?: unknown; styleType?: unknown }>>,
): void {
  for (const map of componentMaps)
    for (const [id, component] of Object.entries(map))
      libs.components[id] = {
        key: asString(component.key),
        name: asString(component.name),
        ...(typeof component.remote === "boolean" ? { remote: component.remote } : {}),
      };
  for (const map of styleMaps)
    for (const [id, style] of Object.entries(map))
      libs.styles[id] = {
        key: asString(style.key),
        name: asString(style.name),
        styleType: asString(style.styleType),
      };
}

export class FigmaContent {
  private readonly versions: FileVersionCache;
  readonly watches: FigmaFileWatches;
  private readonly fonts: FigmaFontProvider;
  private readonly nodesBatchSize: number;
  // imageRef→url maps expire "after no more than 14 days" (figma-integration.md §3.1); a ref
  // missing from a cached map re-fetches the map at most once per minute, not every request.
  private readonly mapRefreshedAt = new Map<string, number>();

  constructor(deps: ContentDeps = {}) {
    this.versions = new FileVersionCache(deps.versionTtlMs);
    this.watches = new FigmaFileWatches(this.versions, deps.watchPollMs);
    this.fonts = new FigmaFontProvider(deps.fonts);
    this.nodesBatchSize = deps.nodesBatchSize ?? NODES_BATCH_SIZE;
  }

  handlers(): FigmaHandlerMap<ContentRequestType> {
    return {
      "figma.file.outline.request": (request, ctx) => this.outline(request, ctx),
      "figma.file.nodes.request": (request, ctx) => this.nodes(request, ctx),
      "figma.file.imageFills.request": (request, ctx) => this.imageFills(request, ctx),
      "figma.file.render.request": (request, ctx) => this.render(request, ctx),
      "figma.file.export.request": (request, ctx) => this.export(request, ctx),
      "figma.file.versions.request": (request, ctx) => this.versionsList(request, ctx),
      "figma.fonts.get.request": (request, ctx) =>
        this.fonts.getFont(ctx, request.family, request.style).then((font) => ({ font })),
      "figma.file.watch.request": async (request, ctx, session) => {
        await requireFile(ctx, request.fileKey);
        return { watchId: this.watches.watch(ctx, request.fileKey, session.sessionKey) };
      },
      "figma.file.unwatch.request": (request) => {
        this.watches.unwatch(request.watchId);
        return Promise.resolve({});
      },
    };
  }

  // ── outline / nodes ──

  private async outline(
    request: { fileKey: string; version?: string },
    ctx: FigmaContext,
  ): Promise<{ outline: FigmaOutline | null }> {
    const file = await requireFile(ctx, request.fileKey);
    // An explicit version is a snapshot request (32.1): the plugin's live document belongs to
    // whatever version is open in Figma now, so serving it for a pinned read would silently
    // present current hierarchy and flows as history. Only the live (unversioned) outline may
    // prefer the plugin — the same rule the pinned nodes read enforces.
    if (request.version === undefined && ctx.link.isLinked(file.fileKey)) {
      const viaLink = await this.linkedOutlineAttempt(ctx, file);
      if (viaLink) return { outline: viaLink };
    }
    const version = request.version ?? (await this.versions.current(ctx, file));
    // ADR-0039: the outline is a depth-3 read, so a SECTION's direct children (depth-3 nodes)
    // come back with it. The cache namespace carries that — a stale depth-2 summary, which
    // saw sections as opaque entries with no children, must never answer a depth-3 request.
    const key = `file/${file.fileKey}/outline-d3@${version}`;
    const hit = await ctx.cache.getJson<Wrapped<FigmaOutline>>(key);
    if (hit?.data) return { outline: hit.data };
    const json = await ctx.rest.getJson<RestFile>({
      connectionId: file.connectionId,
      path: `/v1/files/${file.fileKey}`,
      query: { depth: OUTLINE_REST_DEPTH, version },
      tier: "1",
    });
    const outline = outlineFromRest(json, file.fileKey, version);
    this.versions.prime(ctx, file.fileKey, outline.version);
    await ctx.cache.putJson(key, wrap(outline));
    return { outline };
  }

  /** The plugin may not support the document read; null tells the caller to use REST (32.1). */
  private async linkedOutlineAttempt(
    ctx: FigmaContext,
    file: FigmaFile,
  ): Promise<FigmaOutline | null> {
    try {
      const nodes = await ctx.link.getNodes(file.fileKey, [DOCUMENT_NODE_ID]);
      return linkedOutline(file, nodes[DOCUMENT_NODE_ID], this.versions.peek(file.fileKey) ?? "");
    } catch (error) {
      ctx.logger.info(
        { fileKey: file.fileKey, err: error instanceof Error ? error.message : String(error) },
        "figma outline via link failed, falling back to REST",
      );
      return null;
    }
  }

  private async nodes(
    request: { fileKey: string; ids: string[]; version?: string; depth?: 1 },
    ctx: FigmaContext,
  ): Promise<{
    version: string;
    source: FigmaSource;
    nodes: Record<string, FigmaNode | null>;
    components: Record<string, ComponentMeta>;
    styles: Record<string, StyleMeta>;
  }> {
    const file = await requireFile(ctx, request.fileKey);
    if (request.depth === 1) {
      // ADR-0039: a shallow read lists a section's direct children only. It is always the
      // REST snapshot for a pinned version — the non-empty version is enforced here, the
      // plugin's live tree is never consulted, and answers cache under their own depth-carrying
      // namespace so a shallow node can never poison the full tree (or vice versa). Geometry
      // is not requested: metadata does not need vector paths.
      const version = request.version?.trim() ?? "";
      if (version === "")
        throw new FigmaServiceError(
          "invalid_input",
          "A depth-1 node read needs the pinned file version.",
        );
      return this.loadNodes(ctx, file, request.ids, version, 1);
    }
    const version = request.version ?? (await this.versions.current(ctx, file));
    // An explicit version is a snapshot request (ADR-0037): only data for that exact
    // (fileKey, version) can answer it. The plugin's live tree belongs to whatever version is
    // open in Figma right now, so serving it for a pinned version would silently present
    // current data as history. Only the live (unversioned) read may prefer the plugin.
    if (request.version === undefined && ctx.link.isLinked(file.fileKey)) {
      try {
        const live = await ctx.link.getNodes(file.fileKey, request.ids);
        if (request.ids.some((id) => live[id]))
          return {
            version,
            source: "link",
            nodes: Object.fromEntries(request.ids.map((id) => [id, live[id] ?? null])),
            components: {},
            styles: {},
          };
      } catch (error) {
        ctx.logger.info(
          { fileKey: file.fileKey, err: error instanceof Error ? error.message : String(error) },
          "figma nodes via link failed, falling back to REST",
        );
      }
    }
    return this.loadNodes(ctx, file, request.ids, version);
  }

  /** The (fileKey, id, version) node cache — namespaced by depth so shallow and full
   *  answers never serve each other (ADR-0039). */
  private static nodeKey(fileKey: string, id: string, version: string, depth?: 1): string {
    return depth === undefined
      ? `node/${fileKey}/${id}@${version}`
      : `node/${fileKey}/${id}@${version}@depth=${depth}`;
  }

  /** Library maps follow the same namespace rule: a shallow read's entry-level maps must not
   *  overwrite the full tree's component/style metadata (ADR-0039). */
  private static libsKey(fileKey: string, version: string, depth?: 1): string {
    return depth === undefined
      ? `libs/${fileKey}@${version}`
      : `libs/${fileKey}@${version}@depth=${depth}`;
  }

  /** Ids already cached (including known-unknown `null`s) and the ids that must be fetched. */
  private async cachedNodes(
    ctx: FigmaContext,
    file: FigmaFile,
    ids: string[],
    version: string,
    depth?: 1,
  ): Promise<{ nodes: Record<string, FigmaNode | null>; misses: string[] }> {
    const nodes: Record<string, FigmaNode | null> = {};
    const misses: string[] = [];
    for (const id of ids) {
      const hit = await ctx.cache.getJson<Wrapped<FigmaNode | null>>(
        FigmaContent.nodeKey(file.fileKey, id, version, depth),
      );
      if (hit) nodes[id] = hit.data;
      else misses.push(id);
    }
    return { nodes, misses };
  }

  /** Cached per node per version per depth; uncached ids come back in batched Tier-1 requests. */
  private async loadNodes(
    ctx: FigmaContext,
    file: FigmaFile,
    ids: string[],
    version: string,
    depth?: 1,
  ): Promise<{
    version: string;
    source: FigmaSource;
    nodes: Record<string, FigmaNode | null>;
    components: Record<string, ComponentMeta>;
    styles: Record<string, StyleMeta>;
  }> {
    const { nodes, misses } = await this.cachedNodes(ctx, file, ids, version, depth);
    // Library maps join the same namespace rule: shallow entries must not overwrite the full
    // read's component/style metadata either.
    const libsKey = FigmaContent.libsKey(file.fileKey, version, depth);
    const libs = (await ctx.cache.getJson<LibraryMeta>(libsKey)) ?? { components: {}, styles: {} };
    let resolvedVersion = version;
    for (const batch of chunks(misses, this.nodesBatchSize)) {
      const response = await ctx.rest.getJson<RestNodesResponse>({
        connectionId: file.connectionId,
        path: `/v1/files/${file.fileKey}/nodes`,
        query: {
          ids: batch.join(","),
          ...(depth === undefined ? { geometry: "paths" } : { depth }),
          version,
        },
        tier: "1",
      });
      resolvedVersion = asString(response?.version) || resolvedVersion;
      const componentMaps: Array<Record<string, { key?: unknown; name?: unknown }>> = [
        response?.components ?? {},
      ];
      const styleMaps: Array<
        Record<string, { key?: unknown; name?: unknown; styleType?: unknown }>
      > = [response?.styles ?? {}];
      for (const id of batch) {
        // Figma answers `null` for unknown ids; that is cached too, so it is never re-asked.
        // Each entry is `{ document, components, styles, schemaVersion }`: the node is the
        // entry's `document`, and the entry-level library maps merge into the response's.
        const entry = response?.nodes?.[id] ?? null;
        const node = restEntryNode(entry) as FigmaNode | null;
        nodes[id] = node;
        await ctx.cache.putJson(FigmaContent.nodeKey(file.fileKey, id, version, depth), wrap(node));
        if (entry?.components) componentMaps.push(entry.components);
        if (entry?.styles) styleMaps.push(entry.styles);
      }
      mergeLibraryMaps(libs, componentMaps, styleMaps);
    }
    if (misses.length > 0) await ctx.cache.putJson(libsKey, libs);
    if (resolvedVersion !== version) this.versions.prime(ctx, file.fileKey, resolvedVersion);
    return {
      version: resolvedVersion,
      source: "rest",
      nodes,
      components: libs.components,
      styles: libs.styles,
    };
  }

  // ── image fills / renders / export ──

  private async imageFills(
    request: { fileKey: string; imageRefs: string[] },
    ctx: FigmaContext,
  ): Promise<{ images: Record<string, FigmaBytes | null> }> {
    const file = await requireFile(ctx, request.fileKey);
    const version = await this.versions.current(ctx, file);
    const mapKey = `imagefills/${file.fileKey}@${version}`;
    let urls = (await ctx.cache.getJson<Wrapped<Record<string, string>>>(mapKey))?.data ?? null;
    // One map request per file version; a ref missing from the cached map may simply predate it,
    // so refresh the map at most once a minute before giving up on that ref.
    const refreshedAt = this.mapRefreshedAt.get(mapKey) ?? 0;
    const stale = request.imageRefs.some((ref) => !urls || !(ref in urls));
    if (!urls || (stale && ctx.now() - refreshedAt >= FIGMA_VERSION_RESOLVE_TTL_MS)) {
      const response = await ctx.rest.getJson<RestImagesResponse>({
        connectionId: file.connectionId,
        path: `/v1/files/${file.fileKey}/images`,
        tier: "2",
      });
      urls = (response?.images ?? {}) as Record<string, string>;
      this.mapRefreshedAt.set(mapKey, ctx.now());
      await ctx.cache.putJson(mapKey, wrap(urls));
    }
    const images: Record<string, FigmaBytes | null> = {};
    await Promise.all(
      request.imageRefs.map(async (ref) => {
        const bytesKey = `imagefill/${file.fileKey}/${ref}`;
        const cached = await ctx.cache.getBytes(bytesKey);
        if (cached) {
          images[ref] = toBase64Bytes(cached);
          return;
        }
        const url = urls?.[ref];
        if (!url) {
          images[ref] = null;
          return;
        }
        try {
          const bytes = await ctx.rest.getBytes(url);
          await ctx.cache.putBytes(bytesKey, bytes);
          images[ref] = toBase64Bytes(bytes);
        } catch (error) {
          ctx.logger.info(
            {
              fileKey: file.fileKey,
              imageRef: ref,
              err: error instanceof Error ? error.message : String(error),
            },
            "figma image fill download failed",
          );
          images[ref] = null;
        }
      }),
    );
    return { images };
  }

  private async render(
    request: {
      fileKey: string;
      ids: string[];
      scale: number;
      format?: "png" | "jpg";
      version?: string;
    },
    ctx: FigmaContext,
  ): Promise<{ images: Record<string, FigmaBytes | null>; source: FigmaSource }> {
    const file = await requireFile(ctx, request.fileKey);
    const format: RenderFormat = request.format ?? "png";
    // An explicit version is a snapshot request (32.1): the plugin rasterizes whatever version
    // is open in Figma now, so live bytes mislabeled as history are the failure mode — only the
    // versioned Tier-1 images endpoint can answer a pinned version, and its answers keep their
    // own cache namespace so unverified live plugin bytes never serve a snapshot.
    if (request.version !== undefined)
      return this.renderNodes(
        ctx,
        file,
        request.ids,
        request.scale,
        format,
        request.version,
        false,
      );
    const version = await this.versions.current(ctx, file);
    return this.renderNodes(ctx, file, request.ids, request.scale, format, version, true);
  }

  private async export(
    request: { fileKey: string; nodeId: string; format: RenderFormat; scale?: number },
    ctx: FigmaContext,
  ): Promise<{ file: FigmaBytes | null; fileName: string | null }> {
    const file = await requireFile(ctx, request.fileKey);
    const scale = request.scale ?? 1;
    const version = await this.versions.current(ctx, file);
    const loaded = await this.loadNodes(ctx, file, [request.nodeId], version);
    const node = loaded.nodes[request.nodeId];
    if (!node) return { file: null, fileName: null };
    const rendered = await this.renderNodes(
      ctx,
      file,
      [request.nodeId],
      scale,
      request.format,
      version,
      true, // export has no version field: it is the live current-version read (32.1)
    );
    const bytes = rendered.images[request.nodeId];
    if (!bytes) return { file: null, fileName: null };
    const name =
      asString(node.name)
        .replace(/[/\\:*?"<>|]/g, "_")
        .trim() || request.nodeId;
    return { file: bytes, fileName: `${name}@${scale}x.${request.format}` };
  }

  /**
   * Cache per nodeId@scale@version. `live` marks reads whose version is the CURRENT one:
   * only those may use the plugin export (32.1). Live and verified-REST bytes keep separate
   * namespaces, and both are NEW: released code cached mixed-source plugin bytes under plain
   * `render/...@version`, whose legacy entries neither branch reads — a pre-upgrade live byte
   * can never answer a pinned snapshot unverified.
   */
  private async renderNodes(
    ctx: FigmaContext,
    file: FigmaFile,
    ids: string[],
    scale: number,
    format: RenderFormat,
    version: string,
    live: boolean,
  ): Promise<{ images: Record<string, FigmaBytes | null>; source: FigmaSource }> {
    if (live && ctx.link.isLinked(file.fileKey))
      return this.renderViaLink(ctx, file, ids, scale, format, version);
    return this.renderRest(ctx, file, ids, scale, format, version);
  }

  /** Live plugin rasters, cached in their own namespace keyed by the current version. */
  private async renderViaLink(
    ctx: FigmaContext,
    file: FigmaFile,
    ids: string[],
    scale: number,
    format: RenderFormat,
    version: string,
  ): Promise<{ images: Record<string, FigmaBytes | null>; source: FigmaSource }> {
    const images: Record<string, FigmaBytes | null> = {};
    const cacheKey = (id: string): string =>
      `render-live/${file.fileKey}/${id}@${scale}x@${format}@${version}`;
    await Promise.all(
      ids.map(async (id) => {
        const cached = await ctx.cache.getBytes(cacheKey(id));
        if (cached) {
          images[id] = toBase64Bytes(cached);
          return;
        }
        try {
          const exported = await ctx.link.exportNode(file.fileKey, id, format, scale);
          const stored = {
            mimeType: exported.mimeType || RENDER_MIME[format],
            data: exported.data,
          };
          await ctx.cache.putBytes(cacheKey(id), stored);
          images[id] = toBase64Bytes(stored);
        } catch (error) {
          ctx.logger.info(
            {
              fileKey: file.fileKey,
              nodeId: id,
              err: error instanceof Error ? error.message : String(error),
            },
            "figma link export failed",
          );
          images[id] = null;
        }
      }),
    );
    return { images, source: "link" };
  }

  /**
   * One multi-id Tier-1 call per batch; the S3 urls never leave the daemon (32.8). Answers
   * either the versioned snapshot or the unversioned read of an unlinked file — both are
   * exact-version REST bytes, so they share the version-keyed namespace. That namespace is
   * NEW: released code stored plugin-live rasters under plain `render/...@version`, and those
   * mixed-source entries are never consumed here, so a pre-upgrade live byte can't answer a
   * pinned snapshot unverified.
   */
  private async renderRest(
    ctx: FigmaContext,
    file: FigmaFile,
    ids: string[],
    scale: number,
    format: RenderFormat,
    version: string,
  ): Promise<{ images: Record<string, FigmaBytes | null>; source: FigmaSource }> {
    const images: Record<string, FigmaBytes | null> = {};
    const misses: string[] = [];
    const cacheKey = (id: string): string =>
      `render-rest/${file.fileKey}/${id}@${scale}x@${format}@${version}`;
    for (const id of ids) {
      const cached = await ctx.cache.getBytes(cacheKey(id));
      if (cached) images[id] = toBase64Bytes(cached);
      else misses.push(id);
    }
    for (const batch of chunks(misses, RENDER_BATCH_SIZE)) {
      const response = await ctx.rest.getJson<RestImagesResponse>({
        connectionId: file.connectionId,
        path: `/v1/images/${file.fileKey}`,
        query: { ids: batch.join(","), scale, format, version },
        tier: "1",
      });
      await Promise.all(
        batch.map(async (id) => {
          const url = response?.images?.[id];
          if (!url) {
            images[id] = null;
            return;
          }
          try {
            const bytes = await ctx.rest.getBytes(url);
            const stored = { mimeType: bytes.mimeType || RENDER_MIME[format], data: bytes.data };
            await ctx.cache.putBytes(cacheKey(id), stored);
            images[id] = toBase64Bytes(stored);
          } catch (error) {
            ctx.logger.info(
              {
                fileKey: file.fileKey,
                nodeId: id,
                err: error instanceof Error ? error.message : String(error),
              },
              "figma render download failed",
            );
            images[id] = null;
          }
        }),
      );
    }
    return { images, source: "rest" };
  }

  // ── versions ──

  private async versionsList(
    request: { fileKey: string },
    ctx: FigmaContext,
  ): Promise<{ versions: FigmaVersion[] }> {
    const file = await requireFile(ctx, request.fileKey);
    const version = await this.versions.current(ctx, file);
    const key = `versions/${file.fileKey}@${version}`;
    const hit = await ctx.cache.getJson<Wrapped<FigmaVersion[]>>(key);
    if (hit?.data) return { versions: hit.data };
    const json = await ctx.rest.getJson<RestVersionsResponse>({
      connectionId: file.connectionId,
      path: `/v1/files/${file.fileKey}/versions`,
      query: { page_size: VERSIONS_PAGE_SIZE },
      tier: "2",
    });
    const versions: FigmaVersion[] = (json?.versions ?? []).map((entry) => {
      const handle = entry.user?.handle;
      return {
        id: asString(entry.id),
        label: typeof entry.label === "string" ? entry.label : null,
        description: typeof entry.description === "string" ? entry.description : null,
        createdAt_ms: parseMs(entry.created_at),
        user: typeof handle === "string" && handle ? { handle } : null,
      };
    });
    await ctx.cache.putJson(key, wrap(versions));
    return { versions };
  }
}

export const contentHandlers: FigmaHandlerMap<ContentRequestType> = new FigmaContent().handlers();
