import { describe, expect, it } from "vitest";
import {
  FIGMA_PICKER_PARTITION,
  FIGMA_PICKER_URL,
  isFigmaPickerNavigation,
  selectedFigmaFileUrl,
} from "./figma-file-picker-policy";

// ADR-0038: only the navigation URL crosses the guest boundary, so this policy is the whole
// trust gate. A selection must be an exact selected-Figma-host file URL — HTTPS, no
// credentials, no port, canonical design/file/proto shape (the paste flow's file-key and
// node-id shapes from packages/app/src/figma/url-parse.ts) — and must come back canonical.

const FILE_KEY = "XKVu5QzA9G4iGv5pKQ2m3c";
const LEGACY_NUMERIC_KEY = "869312345678901234";

describe("figma picker session constants", () => {
  it("pins the Files entry URL and the persistent guest partition", () => {
    expect(FIGMA_PICKER_URL).toBe("https://www.figma.com/files");
    expect(FIGMA_PICKER_PARTITION).toBe("persist:jagentdesk-figma-picker");
  });
});

describe("isFigmaPickerNavigation", () => {
  it.each([
    ["https://www.figma.com/files", true],
    ["https://accounts.google.com/o/oauth2/auth", true],
    ["http://www.figma.com/files", false],
    ["file:///Users/me/index.html", false],
    ["", false],
    ["not a url", false],
  ] as const)("allows %s to navigate: %s", (url, allowed) => {
    expect(isFigmaPickerNavigation(url)).toBe(allowed);
  });
});

describe("selectedFigmaFileUrl", () => {
  it("normalizes a design selection to the canonical www.figma.com URL and keeps the node", () => {
    expect(
      selectedFigmaFileUrl(
        `https://www.figma.com/design/${FILE_KEY}/My%20File?node-id=1-23&t=ZqLmnbvVgFvFvBpU-0&m=dev`,
      ),
    ).toBe(`https://www.figma.com/design/${FILE_KEY}?node-id=1-23`);
  });

  it("accepts file and proto paths and normalizes the apex host", () => {
    expect(selectedFigmaFileUrl(`https://figma.com/file/${FILE_KEY}`)).toBe(
      `https://www.figma.com/file/${FILE_KEY}`,
    );
    expect(selectedFigmaFileUrl(`https://figma.com/proto/${LEGACY_NUMERIC_KEY}/slug/1`)).toBe(
      `https://www.figma.com/proto/${LEGACY_NUMERIC_KEY}`,
    );
  });

  it("keeps a colon-form node id", () => {
    expect(
      selectedFigmaFileUrl(`https://www.figma.com/design/${FILE_KEY}/s?node-id=12%3A345`),
    ).toBe(`https://www.figma.com/design/${FILE_KEY}?node-id=12%3A345`);
  });

  it("drops an invalid node id but keeps the selection", () => {
    expect(
      selectedFigmaFileUrl(`https://www.figma.com/design/${FILE_KEY}/s?node-id=${"x".repeat(200)}`),
    ).toBe(`https://www.figma.com/design/${FILE_KEY}`);
  });

  it.each([
    ["http transport", `http://www.figma.com/design/${FILE_KEY}/s`],
    ["an unselected host", `https://cdn.figma.com/design/${FILE_KEY}/s`],
    ["a suffix-spoof host", `https://figma.com.evil/design/${FILE_KEY}/s`],
    ["a non-file path", "https://www.figma.com/files"],
    ["a team browse path", "https://www.figma.com/files/team/123/project/456"],
    ["a short file key", `https://www.figma.com/design/XKV/s`],
    ["a punctuation file key", `https://www.figma.com/design/XKVu-5QzA9G/s`],
    ["a port", `https://www.figma.com:8443/design/${FILE_KEY}/s`],
    ["credentials", `https://user:pass@www.figma.com/design/${FILE_KEY}/s`],
    ["a bare word", "design"],
  ])("rejects %s", (_name, url) => {
    expect(selectedFigmaFileUrl(url)).toBeNull();
  });

  it("accepts the default HTTPS port written explicitly", () => {
    expect(selectedFigmaFileUrl(`https://www.figma.com:443/design/${FILE_KEY}/s`)).toBe(
      `https://www.figma.com/design/${FILE_KEY}`,
    );
  });
});
