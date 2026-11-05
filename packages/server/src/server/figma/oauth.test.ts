import { describe, expect, it } from "vitest";
import {
  figmaEndpointsFromEnv,
  figmaSecretKeys,
  parseFigmaCallbackUrl,
  pkceChallengeS256,
  FIGMA_ENDPOINTS,
  FIGMA_LOOPBACK_REDIRECT_URI,
} from "./oauth.js";
import { FigmaServiceError } from "./context.js";

// The pure halves of the sign-in module: the PKCE transform, the pasted-URL parser, and the
// env endpoint override tests use to point at a fake server (spec 32.2).

describe("pkceChallengeS256", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(pkceChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("figmaEndpointsFromEnv", () => {
  it("defaults to Figma's production endpoints", () => {
    expect(figmaEndpointsFromEnv({})).toEqual(FIGMA_ENDPOINTS);
  });

  it("overrides each endpoint independently for tests", () => {
    expect(
      figmaEndpointsFromEnv({
        JAGENTDESK_FIGMA_AUTH_URL: "http://127.0.0.1:4001",
        JAGENTDESK_FIGMA_API_URL: "http://127.0.0.1:4002",
      }),
    ).toEqual({ authUrl: "http://127.0.0.1:4001", apiUrl: "http://127.0.0.1:4002" });
  });
});

describe("figmaSecretKeys", () => {
  it("covers every secret one connection owns", () => {
    expect(figmaSecretKeys("fgc_abc")).toEqual([
      "figma/fgc_abc/client_id",
      "figma/fgc_abc/client_secret",
      "figma/fgc_abc/tokens",
    ]);
  });
});

describe("parseFigmaCallbackUrl", () => {
  it("extracts code and state from the URL the browser landed on", () => {
    expect(parseFigmaCallbackUrl(`${FIGMA_LOOPBACK_REDIRECT_URI}?code=c_1&state=s_1`)).toEqual({
      code: "c_1",
      state: "s_1",
    });
  });

  it("reports a refused sign-in as auth_failed", () => {
    const thrown = () =>
      parseFigmaCallbackUrl(`${FIGMA_LOOPBACK_REDIRECT_URI}?error=access_denied&state=s_1`);
    expect(thrown).toThrow(FigmaServiceError);
    try {
      thrown();
    } catch (error) {
      expect((error as FigmaServiceError).code).toBe("auth_failed");
      expect((error as FigmaServiceError).message).toContain("access_denied");
    }
  });

  it("rejects a URL without code and state", () => {
    expect(() => parseFigmaCallbackUrl("http://127.0.0.1:8766/figma/callback")).toThrow(
      /no code and state/,
    );
  });

  it("rejects something that is not a URL", () => {
    expect(() => parseFigmaCallbackUrl("not a url")).toThrow(/not a URL/);
  });
});
