import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ForumDiagramTypeSchema,
  type ForumDiagramType,
} from "@jagentdesk/protocol/agent-forum/types";
import { buildSelfNodeCommand } from "../jagentdesk-env.js";

// Renders archify JSON (spec 23, ADR-0021) with the archify copy vendored at
// packages/server/vendor/archify. archify's renderers run their CLI at module load, so each render
// is one child process of the daemon's own runtime (Node, or Electron with ELECTRON_RUN_AS_NODE).
// No network (the vendored copy has no update check and no brand-mark capture) and no model calls.

export interface ArchifyDiagramError {
  // JSON pointer into the submitted document ("/" when the problem is not tied to one field).
  path: string;
  message: string;
}

export type ArchifyRenderResult =
  | { ok: true; diagramType: ForumDiagramType; html: string }
  | { ok: false; errors: ArchifyDiagramError[] };

export interface ArchifyRenderInput {
  source: string;
  diagramType?: ForumDiagramType;
}

export type ArchifyRenderer = (input: ArchifyRenderInput) => Promise<ArchifyRenderResult>;

const RENDER_TIMEOUT_MS = 30_000;
const MAX_ERRORS = 25;
const MAX_MESSAGE_CHARS = 2_000;
// meta.output is required by archify's schema but meaningless here: the daemon chooses where the HTML
// is stored. The wrapper always sets it so agents need not, and so an authored path is never used.
const RENDER_OUTPUT_NAME = "diagram.html";

// Source layout: src/server/agent-forum → ../../../vendor/archify (packages/server/vendor/archify).
// Build layout:  dist/server/server/agent-forum → ../../vendor/archify (dist/server/vendor/archify).
const VENDOR_CANDIDATES = ["../../../vendor/archify", "../../vendor/archify"];

// A child process cannot read inside app.asar, so a packaged daemon uses the unpacked copy
// (electron-builder asarUnpack lists the vendor directory).
function toExternalPath(filePath: string): string {
  const unpacked = filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
  return unpacked !== filePath && existsSync(unpacked) ? unpacked : filePath;
}

export function resolveArchifyVendorDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of VENDOR_CANDIDATES) {
    const dir = path.resolve(here, candidate);
    if (existsSync(path.join(dir, "assets", "template.html"))) return toExternalPath(dir);
  }
  throw new Error("archify renderer is not bundled with this daemon (vendor/archify missing)");
}

function fail(message: string, pointer = "/"): ArchifyRenderResult {
  return { ok: false, errors: [{ path: pointer, message }] };
}

type PreparedDocument =
  | { ok: true; diagramType: ForumDiagramType; json: string }
  | { ok: false; result: ArchifyRenderResult };

// Parse, pick the renderer, and pin meta.output. Structural validation is archify's job.
export function prepareArchifyDocument(input: ArchifyRenderInput): PreparedDocument {
  let document: unknown;
  try {
    document = JSON.parse(input.source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, result: fail(`source is not valid JSON: ${reason}`) };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, result: fail("source must be a JSON object") };
  }
  const record = document as Record<string, unknown>;
  const declared = ForumDiagramTypeSchema.safeParse(record.diagram_type);
  const diagramType = input.diagramType ?? (declared.success ? declared.data : undefined);
  if (!diagramType) {
    return {
      ok: false,
      result: fail(
        `diagram_type must be one of ${ForumDiagramTypeSchema.options.join(", ")}`,
        "/diagram_type",
      ),
    };
  }
  if (declared.success && declared.data !== diagramType) {
    return {
      ok: false,
      result: fail(
        `diagram_type "${declared.data}" does not match diagramType "${diagramType}"`,
        "/diagram_type",
      ),
    };
  }
  const meta = record.meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    (meta as Record<string, unknown>).output = RENDER_OUTPUT_NAME;
  }
  return { ok: true, diagramType, json: JSON.stringify(record) };
}

interface RendererDiagnostic {
  severity?: unknown;
  message?: unknown;
  subject?: { path?: unknown } | null;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function diagnosticToError(entry: RendererDiagnostic): ArchifyDiagramError | null {
  if (entry.severity === "warning") return null;
  const message = typeof entry.message === "string" ? entry.message.trim() : "";
  if (!message) return null;
  const pointer = typeof entry.subject?.path === "string" ? entry.subject.path : "/";
  return { path: pointer || "/", message: truncate(message) };
}

// With ARCHIFY_DIAGNOSTIC_FORMAT=json a failing renderer prints one receipt
// `{ ok: false, error, diagnostics: [...] }` on stderr (possibly after plain warnings).
export function parseRendererFailure(stderr: string): ArchifyDiagramError[] {
  const start = stderr.indexOf('{"schemaVersion"');
  if (start !== -1) {
    try {
      const receipt = JSON.parse(stderr.slice(start).trim()) as {
        error?: unknown;
        diagnostics?: RendererDiagnostic[];
      };
      const errors = (receipt.diagnostics ?? [])
        .map(diagnosticToError)
        .filter((entry): entry is ArchifyDiagramError => entry !== null)
        .slice(0, MAX_ERRORS);
      if (errors.length > 0) return errors;
      if (typeof receipt.error === "string" && receipt.error.trim()) {
        return [{ path: "/", message: truncate(receipt.error.trim()) }];
      }
    } catch {
      // Fall through to the raw text below.
    }
  }
  const text = stderr.trim();
  return [{ path: "/", message: truncate(text || "archify renderer failed without output") }];
}

interface ChildOutcome {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

function runRenderer(scriptPath: string, inputPath: string, outputPath: string, cwd: string) {
  const { command, args, env } = buildSelfNodeCommand([scriptPath, inputPath, outputPath], {
    ARCHIFY_DIAGNOSTIC_FORMAT: "json",
    ARCHIFY_UPDATE_CHECK_DISABLED: "1",
    // Repository evidence would shell out to git against a host path; never enable it here.
    ARCHIFY_REPO_ROOT: undefined,
    ARCHIFY_QUALITY_PROFILE: undefined,
  });
  return new Promise<ChildOutcome>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RENDER_TIMEOUT_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 1_000_000) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });
}

export async function renderArchifyDiagram(
  input: ArchifyRenderInput,
): Promise<ArchifyRenderResult> {
  const prepared = prepareArchifyDocument(input);
  if (!prepared.ok) return prepared.result;
  const vendorDir = resolveArchifyVendorDir();
  const scriptPath = path.join(
    vendorDir,
    "renderers",
    prepared.diagramType,
    `render-${prepared.diagramType}.mjs`,
  );
  const workDir = await mkdtemp(path.join(tmpdir(), "jad-archify-"));
  try {
    const inputPath = path.join(workDir, "diagram.json");
    const outputPath = path.join(workDir, RENDER_OUTPUT_NAME);
    await writeFile(inputPath, prepared.json, "utf8");
    const outcome = await runRenderer(scriptPath, inputPath, outputPath, workDir);
    if (outcome.timedOut) {
      return fail(`archify render timed out after ${RENDER_TIMEOUT_MS / 1000}s`);
    }
    if (outcome.code !== 0) return { ok: false, errors: parseRendererFailure(outcome.stderr) };
    const html = await readFile(outputPath, "utf8");
    return { ok: true, diagramType: prepared.diagramType, html };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
