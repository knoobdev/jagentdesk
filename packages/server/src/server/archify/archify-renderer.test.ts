import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  parseRendererFailure,
  runArchifyRenderer,
  resolveArchifyVendorDir,
} from "./archify-renderer.js";

// Spec 23.2 / ADR-0021: the vendored archify validates + renders in a child process of the daemon's
// own runtime. These tests run the real vendored renderers (no network, no model).

// Upstream catalog ids of the marks THIRD_PARTY_NOTICES.md lists with their own licenses, plus
// path-data prefixes of three of them (upstream v3.2.0), to prove none of that data ships or renders.
const LICENSED_BRAND_IDS = [
  "angular",
  "apache-airflow",
  "apache-kafka",
  "dotnet",
  "javascript",
  "jenkins",
  "rust",
  "vue",
  "openai",
];
const LICENSED_BRAND_PATH_PREFIXES = [
  "M24,1.61H14.06L12,5.16,9.94,1.61H0L12,22.39Z", // Vue.js
  "M11.248 18.25q-.825 0-1.568-.314", // OpenAI
  "M23.8346 11.7033l-1.0073-.6236", // Rust
];

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("parseRendererFailure", () => {
  test("maps archify diagnostics to path + message and drops warnings", () => {
    const stderr = [
      "archify: some plain warning",
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: "summary",
        diagnostics: [
          { severity: "warning", message: "ignored" },
          { severity: "error", message: "bad type", subject: { path: "/components/0/type" } },
          { severity: "error", message: "overlap" },
        ],
      }),
    ].join("\n");
    expect(parseRendererFailure(stderr)).toEqual([
      { path: "/components/0/type", message: "bad type" },
      { path: "/", message: "overlap" },
    ]);
  });

  test("falls back to raw stderr text", () => {
    expect(parseRendererFailure("boom\n")).toEqual([{ path: "/", message: "boom" }]);
  });
});

describe("runArchifyRenderer", () => {
  test("returns schema diagnostics from the bundled tree renderer", async () => {
    const result = await runArchifyRenderer({
      vendor: "archify-3.2.0",
      diagramType: "tree",
      json: JSON.stringify({
        schema_version: 1,
        diagram_type: "tree",
        meta: { title: "Invalid node" },
        nodes: [{ id: "root" }],
      }),
    });
    expect(result).toMatchObject({ ok: false, errors: [{ path: "/nodes/0" }] });
  });
});

describe("vendored archify copy", () => {
  test("ships no brand-mark catalog, update check, or network client", async () => {
    const dir = resolveArchifyVendorDir();
    const files = await listFiles(dir);
    const scripts = files.filter((file) => file.endsWith(".mjs"));
    expect(scripts).toContain(path.join(dir, "renderers", "tree", "render-tree.mjs"));
    expect(files.some((file) => file.endsWith("generated-brand-marks.mjs"))).toBe(false);
    expect(files.some((file) => file.endsWith("check-update.mjs"))).toBe(false);
    for (const file of scripts) {
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(/from ['"]node:(https?|net|dns|dgram|tls)['"]/);
      expect(text, file).not.toMatch(/\bfetch\(/);
      for (const id of LICENSED_BRAND_IDS) expect(text, file).not.toContain(`"id": "${id}"`);
    }
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const prefix of LICENSED_BRAND_PATH_PREFIXES) expect(text, file).not.toContain(prefix);
    }
    const readme = await readFile(path.join(dir, "README.md"), "utf8");
    expect(readme).toContain("3.2.0");
  });
});
