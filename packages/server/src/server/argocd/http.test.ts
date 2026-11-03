import { describe, expect, it } from "vitest";
import { renewedTokenFromSetCookie } from "./http.js";

// Reference §1.5: Argo CD renews a local session through Set-Cookie and splits long tokens
// (util/http/http.go splitCookie): `argocd.token=<n>:<chunk0>`, `argocd.token-1=<chunk1>`, ….
describe("renewedTokenFromSetCookie", () => {
  it("reads a single-cookie token", () => {
    expect(
      renewedTokenFromSetCookie([
        "argocd.token=aaa.bbb.ccc; path=/; SameSite=lax; httpOnly; Secure",
      ]),
    ).toBe("aaa.bbb.ccc");
  });

  it("joins a split token in chunk order", () => {
    expect(
      renewedTokenFromSetCookie([
        "argocd.token-2=ccc; path=/",
        "argocd.token=3:aaa; path=/",
        "argocd.token-1=bbb; path=/",
      ]),
    ).toBe("aaabbbccc");
  });

  it("ignores a split token with a missing chunk and responses without the cookie", () => {
    expect(renewedTokenFromSetCookie(["argocd.token=2:aaa; path=/"])).toBeNull();
    expect(renewedTokenFromSetCookie(["other=1; path=/"])).toBeNull();
    expect(renewedTokenFromSetCookie(undefined)).toBeNull();
  });
});
