import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArchifyDiagramType } from "@jagentdesk/protocol/archify";
import { buildSelfNodeCommand } from "../jagentdesk-env.js";

// Renders archify JSON (spec 31, ADR-0021/ADR-0031) with the archify copy vendored at
// packages/server/vendor/archify-3.2.0. archify's renderers run their CLI at module load, so each render
// is one child process of the daemon's own runtime (Node, or Electron with ELECTRON_RUN_AS_NODE).
// No network (the vendored copy has no update check and no brand-mark capture) and no model calls.

export interface ArchifyDiagramError {
  // JSON pointer into the submitted document ("/" when the problem is not tied to one field).
  path: string;
  message: string;
}

const RENDER_TIMEOUT_MS = 30_000;
const MAX_ERRORS = 25;
const MAX_MESSAGE_CHARS = 2_000;
// The daemon chooses the output path rather than using an authored host path.
export const ARCHIFY_RENDER_OUTPUT_NAME = "diagram.html";
const RENDER_OUTPUT_NAME = ARCHIFY_RENDER_OUTPUT_NAME;

// Source layout: src/server/archify → ../../../vendor/<dir> (packages/server/vendor/<dir>).
// Build layout:  dist/server/server/archify → ../../vendor/<dir> (dist/server/vendor/<dir>).
// The activity graph uses the sandboxed archify 3.2.0 renderer (spec 31, ADR-0031).
export type ArchifyVendorName = "archify-3.2.0";
const VENDOR_PREFIXES = ["../../../vendor/", "../../vendor/"];

// A child process cannot read inside app.asar, so a packaged daemon uses the unpacked copy
// (electron-builder asarUnpack lists the vendor directory).
function toExternalPath(filePath: string): string {
  const unpacked = filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
  return unpacked !== filePath && existsSync(unpacked) ? unpacked : filePath;
}

export function resolveArchifyVendorDir(name: ArchifyVendorName = "archify-3.2.0"): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const prefix of VENDOR_PREFIXES) {
    const dir = path.resolve(here, `${prefix}${name}`);
    if (existsSync(path.join(dir, "assets", "template.html"))) return toExternalPath(dir);
  }
  throw new Error(`archify renderer is not bundled with this daemon (vendor/${name} missing)`);
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

function runRenderer(
  scriptPath: string,
  inputPath: string,
  outputPath: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
) {
  const { command, args, env } = buildSelfNodeCommand([scriptPath, inputPath, outputPath], {
    ...extraEnv,
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

export type ArchifyRunResult =
  | { ok: true; html: string }
  | { ok: false; errors: ArchifyDiagramError[] };

// Runs one vendored renderer on an already prepared document (meta.output pinned by the caller).
export async function runArchifyRenderer(input: {
  vendor: ArchifyVendorName;
  diagramType: ArchifyDiagramType;
  json: string;
  env?: Record<string, string>;
}): Promise<ArchifyRunResult> {
  const vendorDir = resolveArchifyVendorDir(input.vendor);
  const scriptPath = path.join(
    vendorDir,
    "renderers",
    input.diagramType,
    `render-${input.diagramType}.mjs`,
  );
  const workDir = await mkdtemp(path.join(tmpdir(), "jad-archify-"));
  try {
    const inputPath = path.join(workDir, "diagram.json");
    const outputPath = path.join(workDir, RENDER_OUTPUT_NAME);
    await writeFile(inputPath, input.json, "utf8");
    const outcome = await runRenderer(scriptPath, inputPath, outputPath, workDir, input.env);
    if (outcome.timedOut) {
      return {
        ok: false,
        errors: [
          { path: "/", message: `archify render timed out after ${RENDER_TIMEOUT_MS / 1000}s` },
        ],
      };
    }
    if (outcome.code !== 0) return { ok: false, errors: parseRendererFailure(outcome.stderr) };
    const html = await readFile(outputPath, "utf8");
    return { ok: true, html };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
