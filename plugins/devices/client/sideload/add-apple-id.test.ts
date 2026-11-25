import { describe, expect, it } from "vitest";
import {
  PASSWORD_HELP,
  advancedAfterFailure,
  advancedOpenInitially,
  anisetteRequestFields,
  canSubmitAppleId,
} from "./add-apple-id";

describe("Add Apple ID anisette (Advanced)", () => {
  it("sends no anisette fields while Advanced is untouched, so the host default applies", () => {
    expect(anisetteRequestFields({ source: "native", url: "", touched: false })).toEqual({});
    expect(
      anisetteRequestFields({ source: "remote", url: "http://<host>:6969", touched: false }),
    ).toEqual({});
  });

  it("sends the choice the user made", () => {
    expect(anisetteRequestFields({ source: "native", url: "x", touched: true })).toEqual({
      anisetteSource: "native",
    });
    expect(
      anisetteRequestFields({ source: "remote", url: " http://<host>:6969 ", touched: true }),
    ).toEqual({ anisetteSource: "remote", anisetteUrl: "http://<host>:6969" });
  });

  it("starts collapsed for native and open for a remote account", () => {
    expect(advancedOpenInitially("native")).toBe(false);
    expect(advancedOpenInitially("remote")).toBe(true);
  });

  it("opens Advanced on anisette failures and picks Remote where native is missing", () => {
    expect(advancedAfterFailure("anisette_url_required")).toEqual({ open: true, source: "remote" });
    expect(advancedAfterFailure("anisette_failed")).toEqual({ open: true, source: null });
    expect(advancedAfterFailure("invalid_credentials")).toBeNull();
    expect(advancedAfterFailure(null)).toBeNull();
  });

  it("needs Apple ID and password, and a URL only for a remote server", () => {
    const native = { source: "native" as const, url: "", touched: false };
    expect(canSubmitAppleId({ appleId: "", password: "p", anisette: native })).toBe(false);
    expect(canSubmitAppleId({ appleId: "id", password: "", anisette: native })).toBe(false);
    expect(canSubmitAppleId({ appleId: "id", password: "p", anisette: native })).toBe(true);
    expect(
      canSubmitAppleId({
        appleId: "id",
        password: "p",
        anisette: { source: "remote", url: " ", touched: true },
      }),
    ).toBe(false);
  });

  it("explains why the password is needed", () => {
    expect(PASSWORD_HELP).toBe(
      "Apple requires your Apple ID password to sign apps, just like Sideloadly. It goes only to this host and to Apple.",
    );
  });
});
