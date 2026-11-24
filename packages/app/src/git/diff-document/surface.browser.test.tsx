import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { ParsedDiffFile } from "@jagentdesk/protocol/messages";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { lineNumberGutterWidth } from "@/components/code-insets";
import { DiffDocument } from "./index";
import { DiffDocumentWorkspaceCacheProvider } from "./workspace-cache";

const source = "const answer = calculateTotal(6, 7);";
const files: ParsedDiffFile[] = [
  {
    path: "answer.ts",
    isNew: true,
    isDeleted: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 1,
        lines: [{ type: "add", content: source }],
      },
    ],
  },
];
const preferences = {
  layout: "unified" as const,
  wrapLines: true,
  codeFontSize: 13,
  monoFontFamily: "monospace",
};
const mode = { kind: "commit" as const };
const toast = {
  show() {},
  copied() {},
  error(message: string) {
    throw new Error(message);
  },
};
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  host = document.createElement("div");
  host.style.cssText = "display:flex;width:800px;height:400px";
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <ToastApiProvider api={toast}>
        <DiffDocumentWorkspaceCacheProvider>
          <DiffDocument files={files} displayPreferences={preferences} mode={mode} />
        </DiffDocumentWorkspaceCacheProvider>
      </ToastApiProvider>,
    ),
  );
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function copySelection() {
  const scroll = host.querySelector('[data-testid="git-diff-scroll"]');
  if (!scroll) throw new Error("Diff scroll owner missing");
  const clipboardData = new DataTransfer();
  scroll.dispatchEvent(
    new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
  );
  return clipboardData.getData("text/plain");
}
function pointInAnswer() {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Canvas context missing");
  context.font = "13px monospace";
  return {
    x: lineNumberGutterWidth(1, 13) + 8 + context.measureText("const ans").width,
    y: 30 + 19.5 * 0.5,
  };
}
it("copies a whole word selected by a real double click on the canvas", async () => {
  await page.getByTestId("git-diff-scroll").dblClick({ position: pointInAnswer() });
  expect(copySelection()).toBe("answer");
});
it("copies a whole source line selected by a real triple click on the canvas", async () => {
  await page.getByTestId("git-diff-scroll").tripleClick({ position: pointInAnswer() });
  expect(copySelection()).toBe(source);
});
