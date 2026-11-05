import { describe, expect, it } from "vitest";
import { parseFigmaCallbackUrl, parseFigmaFileUrl, parseFigmaTeamUrl } from "./url-parse";

// URL parsing (spec 32.2–32.3) is pure string work — no daemon, no network.

const KEY = "abcdefghij1234567890";

describe("parseFigmaFileUrl", () => {
  it("reads a design URL and decodes the node id", () => {
    const parsed = parseFigmaFileUrl(
      `https://www.figma.com/design/${KEY}/My-File?node-id=1-23&t=example`,
    );
    expect(parsed).toEqual({ fileKey: KEY, nodeId: "1:23" });
  });

  it("accepts file and proto URLs without a node", () => {
    expect(parseFigmaFileUrl(`figma.com/file/${KEY}/Title`)).toEqual({
      fileKey: KEY,
      nodeId: null,
    });
    expect(parseFigmaFileUrl(`https://figma.com/proto/${KEY}/Title`)).toEqual({
      fileKey: KEY,
      nodeId: null,
    });
  });

  it("accepts a bare file key", () => {
    expect(parseFigmaFileUrl(KEY)).toEqual({ fileKey: KEY, nodeId: null });
  });

  it("rejects other hosts, kinds and junk", () => {
    expect(parseFigmaFileUrl(`https://example.com/design/${KEY}/Title`)).toBeNull();
    expect(parseFigmaFileUrl(`https://figma.com/slides/${KEY}/Title`)).toBeNull();
    expect(parseFigmaFileUrl("not a url at all")).toBeNull();
    expect(parseFigmaFileUrl("")).toBeNull();
  });
});

describe("parseFigmaTeamUrl", () => {
  it("reads a team URL", () => {
    expect(parseFigmaTeamUrl("https://www.figma.com/files/team/123456789/Designers")).toEqual({
      teamId: "123456789",
    });
  });

  it("accepts a bare numeric team id", () => {
    expect(parseFigmaTeamUrl("123456789")).toEqual({ teamId: "123456789" });
  });

  it("rejects non-team URLs and non-numeric ids", () => {
    expect(parseFigmaTeamUrl(`https://figma.com/design/${KEY}/Title`)).toBeNull();
    expect(parseFigmaTeamUrl("abc")).toBeNull();
  });
});

describe("parseFigmaCallbackUrl", () => {
  it("extracts code and state from the loopback URL the browser landed on", () => {
    const parsed = parseFigmaCallbackUrl(
      "http://127.0.0.1:8766/figma/callback?code=secret-code&state=xyz",
    );
    expect(parsed).toEqual({ kind: "code", code: "secret-code", state: "xyz" });
  });

  it("reports Figma's error responses", () => {
    const parsed = parseFigmaCallbackUrl(
      "http://localhost:8766/figma/callback?error=access_denied",
    );
    expect(parsed.kind).toBe("error");
  });

  it("rejects URLs without a code or state", () => {
    expect(parseFigmaCallbackUrl("http://127.0.0.1:8766/figma/callback").kind).toBe("error");
    expect(parseFigmaCallbackUrl("   ").kind).toBe("error");
    expect(parseFigmaCallbackUrl("random text").kind).toBe("error");
  });
});
