import { describe, expect, it } from "vitest";
import { formatBackgroundElapsed, truncatePathMiddle } from "./format";

describe("formatBackgroundElapsed", () => {
  it("keeps the sidebar line to one or two units", () => {
    expect(formatBackgroundElapsed(-5)).toBe("0s");
    expect(formatBackgroundElapsed(45_400)).toBe("45s");
    expect(formatBackgroundElapsed(125_000)).toBe("2m");
    expect(formatBackgroundElapsed(3_600_000)).toBe("1h");
    expect(formatBackgroundElapsed(3_900_000)).toBe("1h 5m");
  });
});

describe("truncatePathMiddle", () => {
  it("leaves a folder that fits alone", () => {
    expect(truncatePathMiddle("~/code/app", 40)).toBe("~/code/app");
  });

  it("keeps the root and as many trailing folders as fit", () => {
    expect(truncatePathMiddle("~/.jad-plat/projects/client/bgdetail-workspace", 34)).toBe(
      "~/…/client/bgdetail-workspace",
    );
    expect(truncatePathMiddle("/srv/build/agents/one/two/three", 22)).toBe("/srv/…/one/two/three");
  });

  it("keeps the last folder whole when nothing else fits", () => {
    expect(truncatePathMiddle("~/a/b/a-very-long-folder-name", 10)).toBe(
      "~/…/a-very-long-folder-name",
    );
  });
});
