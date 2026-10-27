import { existsSync, rmSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  MAX_PROVIDER_IMAGE_BYTES,
  isProviderImageMarkdown,
  materializeProviderImage,
  renderProviderImageOutputAsAssistantMarkdown,
} from "./provider-image-output.js";

const HASH = "a".repeat(64);

async function renderImageMarkdown(imagePath: string): Promise<string> {
  const item = await renderProviderImageOutputAsAssistantMarkdown({ path: imagePath });
  if (!item || item.type !== "assistant_message") {
    throw new Error("Expected provider image output to render as assistant markdown.");
  }
  return item.text;
}

describe("isProviderImageMarkdown", () => {
  test("matches the markdown emitted for a materialized attachment", () => {
    expect(isProviderImageMarkdown(`![Image](/tmp/jagentdesk-attachments/${HASH}.png)`)).toBe(true);
    expect(
      isProviderImageMarkdown(`![Image](/tmp/jagentdesk-attachments-a1B2c3/${HASH}.png)`),
    ).toBe(true);
    expect(
      isProviderImageMarkdown(`![Image](/tmp/jagentdesk-attachments/user-1000/${HASH}.png)`),
    ).toBe(true);
    expect(
      isProviderImageMarkdown(`![shot](/var/folders/x/jagentdesk-attachments/${HASH}.webp)`),
    ).toBe(true);
    // Windows: backslash path separators are doubled by escapeMarkdownImageSource.
    expect(
      isProviderImageMarkdown(
        `![Image](C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Temp\\\\jagentdesk-attachments\\\\${HASH}.png)`,
      ),
    ).toBe(true);
  });

  test("emits Windows file paths as file URIs", async () => {
    const markdown = await renderImageMarkdown(
      `C:\\Users\\me\\AppData\\Local\\Temp\\jagentdesk-attachments\\${HASH}.png`,
    );

    expect(markdown).toBe(
      `![Image](file:///C:/Users/me/AppData/Local/Temp/jagentdesk-attachments/${HASH}.png)`,
    );
    expect(isProviderImageMarkdown(markdown)).toBe(true);
  });

  test("emits POSIX file paths with spaces as valid file URI markdown", async () => {
    const markdown = await renderImageMarkdown(
      "/home/user/Projects/Project With Spaces/screenshot.png",
    );

    expect(markdown).toBe(
      "![Image](file:///home/user/Projects/Project%20With%20Spaces/screenshot.png)",
    );
  });

  test("encodes URI-significant characters in POSIX file paths", async () => {
    const markdown = await renderImageMarkdown("/tmp/screenshot#1?draft.png");

    expect(markdown).toBe("![Image](file:///tmp/screenshot%231%3Fdraft.png)");
  });

  test("preserves double-leading slashes in POSIX file paths", async () => {
    const markdown = await renderImageMarkdown("//tmp/screenshot#1.png");

    expect(markdown).toBe("![Image](file:////tmp/screenshot%231.png)");
  });

  test.each([
    ["UNC", "\\\\server\\share\\shot#1.png", "file://server/share/shot%231.png"],
    [
      "extended UNC",
      "\\\\?\\UNC\\server\\share\\shot?draft.png",
      "file://server/share/shot%3Fdraft.png",
    ],
  ])("encodes %s image paths as file URIs", async (_label, imagePath, expectedSource) => {
    expect(await renderImageMarkdown(imagePath)).toBe(`![Image](${expectedSource})`);
  });

  test("rejects user-authored markdown that is not a materialized attachment", () => {
    // No content hash — a hand-written path, not something the writer produced.
    expect(isProviderImageMarkdown("![diagram](./jagentdesk-attachments/notes.png)")).toBe(false);
    expect(isProviderImageMarkdown("![logo](https://example.com/logo.png)")).toBe(false);
    // Image markdown that does not start the text.
    expect(isProviderImageMarkdown("see the chart: ![chart](x.png)")).toBe(false);
  });
});

describe("materializeProviderImage", () => {
  test("recreates the private temp directory if the cached directory is removed", async () => {
    const first = await materializeProviderImage({
      data: "YWJjMTIz",
      mimeType: "image/png",
    });
    const firstDir = path.dirname(first.path);
    expect(existsSync(first.path)).toBe(true);

    rmSync(firstDir, { recursive: true, force: true });

    const second = await materializeProviderImage({
      data: "ZGVmNDU2",
      mimeType: "image/png",
    });
    const secondDir = path.dirname(second.path);

    try {
      expect(existsSync(second.path)).toBe(true);
    } finally {
      rmSync(secondDir, { recursive: true, force: true });
    }
  });
});

test("repeated content is reused without rewriting the attachment", async () => {
  const image = {
    data: Buffer.from("dedupe regression").toString("base64"),
    mimeType: "image/png",
  };
  const first = await materializeProviderImage(image);
  const before = statSync(first.path, { bigint: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await materializeProviderImage(image);
  expect(second.path).toBe(first.path);
  expect(statSync(second.path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
});

test("64 MiB materialization leaves the event loop responsive and preserves bytes", async () => {
  const bytes = Buffer.alloc(64 * 1024 * 1024, 37);
  const data = bytes.toString("base64");
  let previous = performance.now();
  let longest = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - previous);
    previous = now;
  }, 1);
  try {
    const result = await materializeProviderImage({ data, mimeType: "image/png" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    console.log(`64 MiB attachment longest loop gap: ${longest.toFixed(2)} ms`);
    expect(longest).toBeLessThan(50);
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
    rmSync(result.path, { force: true });
  } finally {
    clearInterval(probe);
  }
});

test("preserves base64 decoding across whitespace and chunk boundaries", async () => {
  const bytes = Buffer.alloc(512 * 1024, 123);
  const base64 = bytes.toString("base64");
  const data = base64.match(/.{1,77}/g)!.join("\n");
  const result = await materializeProviderImage({ data, mimeType: "image/png" });
  expect(readFileSync(result.path).equals(bytes)).toBe(true);
});

test("rejects oversized materialization before work and leaves the queue usable", async () => {
  const data = "A".repeat(Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4 + 260);
  await expect(materializeProviderImage({ data, mimeType: "image/png" })).rejects.toThrow(
    "exceeds",
  );
  const omitted = await renderProviderImageOutputAsAssistantMarkdown(
    { data, mimeType: "image/png" },
    { materialize: materializeProviderImage },
  );
  expect(omitted).toEqual({
    type: "assistant_message",
    text: "Image output was omitted because it was not available as a file path or URL.",
  });
  const image = await materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });
  expect(readFileSync(image.path).toString()).toBe("abc123");
});

test("simultaneous requests for the same content share the published file", async () => {
  const image = {
    data: Buffer.from("concurrent dedupe fixture").toString("base64"),
    mimeType: "image/png",
  };
  const results = await Promise.all([
    materializeProviderImage(image),
    materializeProviderImage(image),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(readFileSync(results[0].path).toString()).toBe("concurrent dedupe fixture");
});
