import { describe, expect, test } from "vitest";
import { selectTailnetStatus } from "./status.js";

describe("selectTailnetStatus", () => {
  test("returns the host with the TCP listen port", () => {
    expect(selectTailnetStatus({ host: "tailnet.test", listen: "0.0.0.0:6767" })).toBe(
      "tailnet.test:6767",
    );
  });

  test("returns just the host when the listen target has no port", () => {
    expect(selectTailnetStatus({ host: "tailnet.test", listen: "/tmp/jagentdesk.sock" })).toBe(
      "tailnet.test",
    );
  });

  test("returns not configured for a null host", () => {
    expect(selectTailnetStatus({ host: null, listen: "0.0.0.0:6767" })).toBe("not configured");
  });

  test("returns not configured for an empty-string host", () => {
    expect(selectTailnetStatus({ host: "", listen: "0.0.0.0:6767" })).toBe("not configured");
  });

  test("returns the host when the listen target has no colon", () => {
    expect(selectTailnetStatus({ host: "tailnet.test", listen: "tailnet.test" })).toBe(
      "tailnet.test",
    );
  });
});
