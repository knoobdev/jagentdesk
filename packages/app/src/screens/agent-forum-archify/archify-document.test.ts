import { describe, expect, it } from "vitest";
import {
  ARCHIFY_CSP,
  ARCHIFY_REPLAY_MESSAGE,
  ARCHIFY_REPLAY_SCRIPT,
  buildArchifyDocument,
} from "./archify-document";

// ADR-0021 §4 / spec 23.4: the sandbox document for daemon-rendered archify HTML.

const RENDERED =
  '<!DOCTYPE html>\n<html lang="en" data-theme="dark"><head></head><body><svg></svg></body></html>';

describe("buildArchifyDocument", () => {
  it("uses exactly the ADR-0021 policy plus form/base lockdown", () => {
    expect(ARCHIFY_CSP.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data: blob:",
      "font-src data:",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]);
    expect(ARCHIFY_CSP).not.toContain("unsafe-eval");
    expect(ARCHIFY_CSP).not.toMatch(/https?:/);
  });

  it("puts the CSP first so it lands in <head> before any archify markup", () => {
    const doc = buildArchifyDocument(RENDERED, "dark");
    expect(
      doc.startsWith(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARCHIFY_CSP}">`,
      ),
    ).toBe(true);
    const cspAt = doc.indexOf("Content-Security-Policy");
    expect(cspAt).toBeLessThan(doc.indexOf("<script>"));
    expect(cspAt).toBeLessThan(doc.indexOf("<!DOCTYPE html>"));
  });

  it("keeps the rendered HTML verbatim between prologue and epilogue", () => {
    const doc = buildArchifyDocument(RENDERED, "light");
    expect(doc).toContain(RENDERED);
    expect(doc.indexOf(RENDERED)).toBeLessThan(doc.indexOf("__jadArchifyReplay="));
  });

  it("strips a leading BOM", () => {
    expect(buildArchifyDocument(`﻿${RENDERED}`, "dark")).not.toContain("﻿");
  });

  it("injects the app color scheme and the embed attribute", () => {
    expect(buildArchifyDocument(RENDERED, "light")).toContain('var scheme="light"');
    expect(buildArchifyDocument(RENDERED, "dark")).toContain('var scheme="dark"');
    const doc = buildArchifyDocument(RENDERED, "dark");
    expect(doc).toContain('setAttribute("data-jad-embed","true")');
    // archify's own embed switch would also disable the trace animation.
    expect(doc).not.toContain('setAttribute("data-embed"');
    expect(doc).toContain('html[data-jad-embed="true"] .toolbar');
  });

  it("wires replay for both the iframe message and the native injected script", () => {
    const doc = buildArchifyDocument(RENDERED, "dark");
    expect(doc).toContain(JSON.stringify(ARCHIFY_REPLAY_MESSAGE));
    expect(doc).toContain("event.source!==window.parent");
    expect(ARCHIFY_REPLAY_SCRIPT).toContain("__jadArchifyReplay");
  });
});
