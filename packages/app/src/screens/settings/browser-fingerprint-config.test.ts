import { describe, expect, it } from "vitest";
import { generateFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import type { MutableDaemonConfig } from "@jagentdesk/protocol/messages";
import {
  deleteProfilePatch,
  resolveActiveFingerprintProfile,
  selectProfilePatch,
  upsertProfilePatch,
} from "./browser-fingerprint-config";

const p = (id: string) => generateFingerprintProfile({ id, nowMs: 1 });

function configWith(profiles: ReturnType<typeof p>[], activeProfileId: string | null) {
  return {
    browserTools: { enabled: true, profiles, activeProfileId },
  } as unknown as MutableDaemonConfig;
}

describe("browser-fingerprint-config", () => {
  it("resolves the active profile by id, null when unset or missing", () => {
    const a = p("a");
    expect(resolveActiveFingerprintProfile(configWith([a], "a"))?.id).toBe("a");
    expect(resolveActiveFingerprintProfile(configWith([a], null))).toBeNull();
    expect(resolveActiveFingerprintProfile(configWith([a], "gone"))).toBeNull();
    expect(resolveActiveFingerprintProfile(null)).toBeNull();
  });

  it("upsert replaces by id and keeps the rest (patch sends the full array)", () => {
    const a = p("a");
    const b = p("b");
    const a2 = { ...a, name: "renamed" };
    const patch = upsertProfilePatch([a, b], a2);
    const next = patch.browserTools?.profiles ?? [];
    expect(next).toHaveLength(2);
    expect(next.find((x) => x.id === "a")?.name).toBe("renamed");
    expect(next.some((x) => x.id === "b")).toBe(true);
  });

  it("delete removes the profile and clears active id only if it was active", () => {
    const a = p("a");
    const b = p("b");
    const removedActive = deleteProfilePatch([a, b], "a", "a");
    expect(removedActive.browserTools?.profiles?.map((x) => x.id)).toEqual(["b"]);
    expect(removedActive.browserTools?.activeProfileId).toBeNull();

    const removedOther = deleteProfilePatch([a, b], "a", "b");
    expect(removedOther.browserTools?.activeProfileId).toBe("b");
  });

  it("select patches only the active id", () => {
    expect(selectProfilePatch("x").browserTools?.activeProfileId).toBe("x");
    expect(selectProfilePatch(null).browserTools?.activeProfileId).toBeNull();
  });
});
