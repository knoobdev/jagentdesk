import { describe, expect, test } from "vitest";
import { backgroundWorkSources, scriptLanguage } from "./sources";

const provider = { id: "provider", kind: "provider", label: "" };

describe("background work sources", () => {
  test("an older daemon without sources gives the provider tab alone", () => {
    expect(backgroundWorkSources({ outputAvailable: true })).toEqual({
      tabs: [{ id: "provider", kind: "provider", available: true }],
      defaultTabId: "provider",
      script: null,
      empty: false,
    });
    expect(backgroundWorkSources({ outputAvailable: false }).tabs).toEqual([
      { id: "provider", kind: "provider", available: false },
    ]);
  });

  test("a redirect file is a tab beside the provider's and the newest data is shown first", () => {
    const result = backgroundWorkSources({
      outputAvailable: true,
      sources: [
        { ...provider, available: true, size: 0, modifiedAt: "2026-11-28T10:00:00.000Z" },
        {
          id: "redirect:0",
          kind: "redirect",
          label: "t.log",
          path: "/tmp/t.log",
          available: true,
          size: 120,
          modifiedAt: "2026-11-28T10:00:05.000Z",
          lastRead: { at: "2026-11-28T10:01:00.000Z", content: "PASS", truncated: false },
        },
      ],
    });
    expect(result.tabs.map((tab) => tab.id)).toEqual(["provider", "redirect:0"]);
    expect(result.defaultTabId).toBe("redirect:0");
    expect(result.tabs[1]).toMatchObject({
      label: "t.log",
      lastRead: { content: "PASS" },
    });
    expect(result.empty).toBe(false);
  });

  test("the provider wins when its output is newer", () => {
    const result = backgroundWorkSources({
      outputAvailable: true,
      sources: [
        { ...provider, available: true, size: 10, modifiedAt: "2026-11-28T10:00:09.000Z" },
        {
          id: "redirect:0",
          kind: "redirect",
          label: "t.log",
          available: true,
          size: 120,
          modifiedAt: "2026-11-28T10:00:05.000Z",
        },
      ],
    });
    expect(result.defaultTabId).toBe("provider");
  });

  test("a provider without output gets no tab beside redirect files", () => {
    const result = backgroundWorkSources({
      outputAvailable: false,
      sources: [
        { ...provider, available: false },
        {
          id: "redirect:1",
          kind: "redirect",
          label: "later.log",
          available: false,
          size: 0,
          modifiedAt: null,
        },
      ],
    });
    expect(result.tabs).toEqual([
      {
        id: "redirect:1",
        kind: "redirect",
        label: "later.log",
        path: null,
        available: false,
        lastRead: null,
      },
    ]);
    expect(result.defaultTabId).toBe("redirect:1");
    expect(result.empty).toBe(true);
  });

  test("the script and unknown kinds", () => {
    const result = backgroundWorkSources({
      outputAvailable: true,
      sources: [
        { ...provider, available: true, size: 0 },
        {
          id: "script",
          kind: "script",
          label: "wait.sh",
          path: "/tmp/wait.sh",
          script: { content: "sleep 1\n", truncated: false, lineCount: 1 },
        },
        { id: "x", kind: "future-kind", label: "x" },
      ],
    });
    expect(result.tabs.map((tab) => tab.id)).toEqual(["provider"]);
    expect(result.script).toEqual({
      label: "wait.sh",
      path: "/tmp/wait.sh",
      content: "sleep 1\n",
      truncated: false,
      lineCount: 1,
    });
    expect(result.empty).toBe(true);
  });

  test.each([
    ["wait.sh", "", "sh"],
    ["wait.zsh", "", "sh"],
    ["poll.py", "", "py"],
    ["run", "#!/usr/bin/env python3\nprint(1)", "py"],
    ["run", "#!/bin/bash\n", "sh"],
    ["run", "echo", null],
  ])("highlights %s as %s", (label, content, language) => {
    expect(scriptLanguage(label, content)).toBe(language);
  });
});
