import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeBody } from "./http.js";
import { describeNonPlistBody } from "./developer-services.js";

const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>resultCode</key><integer>0</integer></dict></plist>`;

describe("Developer Services response bodies", () => {
  it("decodes gzip even when the header is missing", () => {
    const zipped = gzipSync(Buffer.from(plist));
    expect(decodeBody(zipped, "gzip").toString()).toBe(plist);
    expect(decodeBody(zipped, undefined).toString()).toBe(plist);
    expect(decodeBody(Buffer.from(plist), undefined).toString()).toBe(plist);
  });

  it("describes a non-plist body without its content", () => {
    const html = Buffer.from(
      "<!DOCTYPE html><html><head><title>Upgrade Required</title></head><body>secret</body></html>",
    );
    const text = describeNonPlistBody({
      status: 200,
      headers: { "content-type": "text/html" },
      body: html,
    });
    expect(text).toContain('an HTML page titled "Upgrade Required"');
    expect(text).not.toContain("secret");
    expect(describeNonPlistBody({ status: 200, headers: {}, body: Buffer.alloc(0) })).toBe(
      "HTTP 200, empty body",
    );
    expect(
      describeNonPlistBody({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"teams":[]}'),
      }),
    ).toContain("JSON");
  });
});
