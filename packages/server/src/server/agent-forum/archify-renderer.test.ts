import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  parseRendererFailure,
  prepareArchifyDocument,
  renderArchifyDiagram,
  resolveArchifyVendorDir,
} from "./archify-renderer.js";

// Spec 23.2 / ADR-0021: the vendored archify validates + renders in a child process of the daemon's
// own runtime. These tests run the real vendored renderers (no network, no model).

const MINIMAL_ARCHITECTURE = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Todo app", animation: "trace" },
  components: [
    { id: "web", type: "frontend", label: "Web app", pos: [40, 120], size: [140, 60] },
    { id: "api", type: "backend", label: "API", pos: [260, 120], size: [140, 60] },
    { id: "db", type: "database", label: "Postgres", pos: [480, 120], size: [140, 60] },
  ],
  connections: [
    { id: "web-api", from: "web", to: "api", label: "HTTPS" },
    { id: "api-db", from: "api", to: "db", label: "SQL" },
  ],
};

// Upstream catalog ids of the marks THIRD_PARTY_NOTICES.md lists with their own licenses, plus
// path-data prefixes of three of them (upstream v3.0.1), to prove none of that data ships or renders.
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

describe("prepareArchifyDocument", () => {
  test("pins meta.output and infers the diagram type from the JSON", () => {
    const prepared = prepareArchifyDocument({
      source: JSON.stringify({
        ...MINIMAL_ARCHITECTURE,
        meta: { title: "t", output: "../x.html" },
      }),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.diagramType).toBe("architecture");
    expect(JSON.parse(prepared.json).meta.output).toBe("diagram.html");
  });

  test("rejects invalid JSON, non-objects, unknown and mismatched types", () => {
    const bad = prepareArchifyDocument({ source: "{nope" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.result).toMatchObject({ ok: false, errors: [{ path: "/" }] });

    expect(prepareArchifyDocument({ source: "[]" }).ok).toBe(false);

    const unknown = prepareArchifyDocument({ source: JSON.stringify({ diagram_type: "mindmap" }) });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.result).toMatchObject({ errors: [{ path: "/diagram_type" }] });
    }

    const mismatch = prepareArchifyDocument({
      source: JSON.stringify(MINIMAL_ARCHITECTURE),
      diagramType: "workflow",
    });
    expect(mismatch.ok).toBe(false);
  });
});

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

describe("renderArchifyDiagram (vendored archify)", () => {
  test("renders a valid architecture with the trace animation", async () => {
    const result = await renderArchifyDiagram({ source: JSON.stringify(MINIMAL_ARCHITECTURE) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagramType).toBe("architecture");
    expect(result.html).toContain('data-animation="trace"');
    expect(result.html).toContain('data-animate="edge"');
    expect(result.html).toContain('id="btn-motion"');
    // Self-contained: no remote script/style/font/image references.
    expect(result.html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']https?:/i);
    expect(result.html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(result.html).not.toContain("data-brand-mark=");
    for (const prefix of LICENSED_BRAND_PATH_PREFIXES) expect(result.html).not.toContain(prefix);
  }, 60_000);

  test("returns each schema error with its JSON path", async () => {
    const invalid = {
      ...MINIMAL_ARCHITECTURE,
      components: [{ ...MINIMAL_ARCHITECTURE.components[0], type: "mainframe" }],
      connections: [],
    };
    const result = await renderArchifyDiagram({ source: JSON.stringify(invalid) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("/components/0/type");
    expect(result.errors[0]?.message).toContain("allowed values");
  }, 60_000);

  test("returns layout errors from the renderer", async () => {
    const overlapping = {
      ...MINIMAL_ARCHITECTURE,
      components: MINIMAL_ARCHITECTURE.components.map((c) => ({ ...c, pos: [40, 120] })),
    };
    const result = await renderArchifyDiagram({ source: JSON.stringify(overlapping) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("apart"))).toBe(true);
  }, 60_000);

  test("rejects brand marks instead of fetching or embedding them", async () => {
    const branded = structuredClone(MINIMAL_ARCHITECTURE) as {
      components: Record<string, unknown>[];
    };
    branded.components[0]!.brand = "vue";
    const result = await renderArchifyDiagram({ source: JSON.stringify(branded) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("brand marks are not available");
  }, 60_000);
});

describe("vendored archify copy", () => {
  test("ships no brand-mark catalog, update check, or network client", async () => {
    const dir = resolveArchifyVendorDir();
    const files = await listFiles(dir);
    const scripts = files.filter((file) => file.endsWith(".mjs"));
    expect(scripts.length).toBeGreaterThan(20);
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
    expect(readme).toContain("3.0.1");
  });
});
