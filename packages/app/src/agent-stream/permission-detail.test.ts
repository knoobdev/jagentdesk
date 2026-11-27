import { describe, expect, it } from "vitest";
import { permissionRequestDetail } from "./permission-detail";

describe("permissionRequestDetail", () => {
  it("keeps a provider detail that has content", () => {
    const detail = { type: "plain_text" as const, text: "/private/var/folders/T/opencode/*" };
    expect(permissionRequestDetail({ detail, input: { action: "external_directory" } })).toBe(
      detail,
    );
  });

  it("shows the request input when the provider detail is empty", () => {
    expect(
      permissionRequestDetail({
        detail: { type: "unknown", input: null, output: null },
        input: { action: "external_directory", resources: ["/Users/me/projects/app/*"] },
      }),
    ).toEqual({
      type: "unknown",
      input: { action: "external_directory", resources: ["/Users/me/projects/app/*"] },
      output: null,
    });
  });

  it("shows nothing rather than an empty detail for a request without content", () => {
    expect(permissionRequestDetail({})).toBeNull();
    expect(permissionRequestDetail({ input: {} })).toBeNull();
  });
});
