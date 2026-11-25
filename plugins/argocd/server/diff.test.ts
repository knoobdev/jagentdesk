import { describe, expect, it } from "vitest";
import { manifestToYaml, unifiedDiff } from "./diff.js";

describe("unifiedDiff", () => {
  it("renders a hunk with context for a changed field", () => {
    const before = manifestToYaml(
      JSON.stringify({ kind: "Deployment", metadata: { name: "ui" }, spec: { replicas: 1 } }),
    );
    const after = manifestToYaml(
      JSON.stringify({ kind: "Deployment", metadata: { name: "ui" }, spec: { replicas: 3 } }),
    );

    const diff = unifiedDiff({ before, after, label: "Deployment/ui", maxBytes: 10_000 });

    expect(diff).toEqual({
      text: [
        "--- live/Deployment/ui",
        "+++ desired/Deployment/ui",
        "@@ -2,4 +2,4 @@",
        " metadata:",
        "   name: ui",
        " spec:",
        "-  replicas: 1",
        "+  replicas: 3",
        "",
      ].join("\n"),
      truncated: false,
    });
  });

  it("is empty when nothing differs and shows a missing live object as all additions", () => {
    expect(unifiedDiff({ before: "a: 1\n", after: "a: 1\n", label: "x", maxBytes: 100 }).text).toBe(
      "",
    );
    expect(unifiedDiff({ before: "", after: "a: 1\n", label: "x", maxBytes: 100 }).text).toBe(
      "--- live/x\n+++ desired/x\n@@ -1,0 +1,1 @@\n+a: 1\n",
    );
  });
});
