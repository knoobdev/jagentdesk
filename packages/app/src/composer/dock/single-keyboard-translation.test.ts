import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ComposerDock's KeyboardTranslateView lifts the content and the composer together. A screen that
// also translates its dock content by the keyboard moves the transcript up twice: on an iPhone the
// whole chat lands behind the header and the area above the composer goes blank.
const DOCK_SCREENS = [
  "../../panels/agent-panel.tsx",
  "../draft/workspace-tab.tsx",
  "../../screens/new-workspace-screen.tsx",
];

function findKeyboardTranslations(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  let rendersDock = false;
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (tag === "ComposerDock") rendersDock = true;
      if (tag === "KeyboardTranslateView") found.push(node.getText(source));
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useKeyboardShiftStyle" &&
      /mode:\s*"translate"/.test(node.arguments[0]?.getText(source) ?? "")
    ) {
      found.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(rendersDock).toBe(true);
  return found;
}

describe("ComposerDock screens", () => {
  it.each(DOCK_SCREENS)("leave keyboard translation to the dock in %s", (path) => {
    expect(findKeyboardTranslations(path)).toEqual([]);
  });
});
