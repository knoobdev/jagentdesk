import type { BrowserContext, Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const ASSISTANT_MARKDOWN = [
  "Direct matches:",
  "",
  "Formatted **strong prose**, _emphasized prose_, and ~~struck prose~~.",
  "",
  "- **[First issue](https://example.com/issues/1)**: exact `apply_patch` failure.",
  "- [Second issue](https://example.com/issues/2): repeated sandbox setup.",
  "",
  "5. Fifth item",
  "6. Sixth item",
  "7. Seventh item",
  "8. Eighth item",
  "",
  "Nested list:",
  "",
  "3. Outer three",
  "",
  "   7. Inner seven",
  "   8. Inner eight",
  "   9. Inner nine",
  "",
  "A hard break  ",
  "stays hard.",
  "",
  "www.example.com stays plain Markdown text.",
  "",
  '[docs](https://docs.example.com "Reference") and <https://autolink.example.com>.',
  "",
  "[workspace file](file:///tmp/jagentdesk%20notes.md#L4)",
  "",
  "`https://example.com/generated` stays code, not a generated link.",
  "",
  "```typescript",
  'const answer = "yes";',
  "```",
  "",
  "````text",
  "before",
  "```",
  "after",
  "````",
  "",
  "| Left | Right | Center |",
  "| :-- | --: | :-: |",
  "| Current \\| active | ~~obsolete~~ | ready |",
].join("\n");

const EXPECTED_WHOLE_SELECTION_MARKDOWN = ASSISTANT_MARKDOWN.replace(
  "<https://autolink.example.com>",
  "[https://autolink.example.com](https://autolink.example.com)",
).replace(
  "3. Outer three\n\n   7. Inner seven\n   8. Inner eight\n   9. Inner nine",
  "3. Outer three\n    7. Inner seven\n    8. Inner eight\n    9. Inner nine",
);

interface ClipboardContent {
  html: string;
  plainText: string;
}

async function allowRichClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
}

async function selectAssistantMessage(page: Page): Promise<void> {
  const assistantMessage = page.getByTestId("assistant-message").filter({
    hasText: "Direct matches:",
  });
  await expect(assistantMessage).toBeVisible();
  await assistantMessage.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function selectAssistantText(page: Page, text: string): Promise<void> {
  await selectAssistantTextRange(page, text, text);
}

async function selectAssistantTextRange(
  page: Page,
  startText: string,
  endText: string,
): Promise<void> {
  const assistantMessage = page.getByTestId("assistant-message").filter({
    hasText: "Direct matches:",
  });
  await assistantMessage.evaluate(
    (element, selectedRange) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let startNode: Node | null = null;
      let startOffset = -1;
      let endNode: Node | null = null;
      let endOffset = -1;
      let textNode = walker.nextNode();
      while (textNode) {
        if (!startNode) {
          const offset = textNode.textContent?.indexOf(selectedRange.startText) ?? -1;
          if (offset >= 0) {
            startNode = textNode;
            startOffset = offset;
          }
        }
        if (startNode) {
          const offset = textNode.textContent?.indexOf(selectedRange.endText) ?? -1;
          if (offset >= 0) {
            endNode = textNode;
            endOffset = offset + selectedRange.endText.length;
            break;
          }
        }
        textNode = walker.nextNode();
      }
      if (!startNode || !endNode) {
        throw new Error(
          `Could not find assistant text range: ${selectedRange.startText} — ${selectedRange.endText}`,
        );
      }
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { startText, endText },
  );
}

async function copySelection(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+c");
}

async function readPlainClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function readRichClipboard(page: Page): Promise<ClipboardContent> {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items[0];
    if (!item) {
      throw new Error("Expected clipboard content");
    }
    return {
      html: await (await item.getType("text/html")).text(),
      plainText: await (await item.getType("text/plain")).text(),
    };
  });
}

test("copying an assistant selection preserves Markdown structure and links", async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("@jagentdesk:app-settings", JSON.stringify({ uiFontFamily: "serif" }));
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-selection-copy-",
    title: "Assistant selection copy",
    initialPrompt: "Render the clipboard fixture.",
    featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
  });

  try {
    await allowRichClipboard(context);
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await openAgentRoute(page, agent);

    const assistantMessage = page.getByTestId("assistant-message").filter({
      hasText: "Direct matches:",
    });
    for (const [tag, text] of [
      ["strong", "strong prose"],
      ["em", "emphasized prose"],
      ["s", "struck prose"],
    ]) {
      const formattedProse = assistantMessage
        .locator(`[data-jagentdesk-markdown-tag="${tag}"]`)
        .filter({ hasText: text });
      await expect(formattedProse).toHaveCSS("font-family", "serif");
      await expect(formattedProse).not.toHaveAttribute("data-pmono");
    }
    const inlineCode = assistantMessage
      .locator('[data-jagentdesk-markdown-tag="code"]')
      .filter({ hasText: "apply_patch" });
    await expect(inlineCode).toHaveAttribute("data-pmono", "");

    await selectAssistantMessage(page);
    await copySelection(page);

    const clipboard = await readRichClipboard(page);
    expect(clipboard.plainText).toBe(EXPECTED_WHOLE_SELECTION_MARKDOWN);
    expect(clipboard.html).toContain("<ul>");
    expect(clipboard.html).toContain(
      '<strong><a href="https://example.com/issues/1">First issue</a></strong>',
    );
    expect(clipboard.html).toContain("<code>apply_patch</code>");
    expect(clipboard.html).toContain('<ol start="5">');
    expect(clipboard.html).toContain("A hard break<br>");
    expect(clipboard.html).toContain(
      '<a href="http://www.example.com/">www.example.com</a> stays plain Markdown text.',
    );
    expect(clipboard.html).toContain(
      '<a href="https://docs.example.com/" title="Reference">docs</a>',
    );
    expect(clipboard.html).toContain(
      '<a href="https://autolink.example.com/">https://autolink.example.com</a>',
    );
    expect(clipboard.html).toContain(
      '<a href="file:///tmp/jagentdesk%20notes.md#L4">workspace file</a>',
    );
    expect(clipboard.html).toContain("<code>https://example.com/generated</code>");
    expect(clipboard.html).not.toContain(
      '<a href="https://example.com/generated"><code>https://example.com/generated</code></a>',
    );
    expect(clipboard.html).toContain('<code class="language-typescript">');
    expect(clipboard.html).toContain(
      '<pre><code class="language-text">before\n```\nafter\n</code></pre>',
    );
    expect(clipboard.html).toContain("<table>");
    expect(clipboard.html).toContain('<td style="text-align:left">Current | active</td>');
    expect(clipboard.html.match(/<td\b/g)).toHaveLength(3);
    expect(clipboard.html).toContain("<s>obsolete</s>");
    expect(clipboard.html).toContain('<th style="text-align:left">Left</th>');
    expect(clipboard.html).toContain('<th style="text-align:right">Right</th>');
    expect(clipboard.html).toContain('<th style="text-align:center">Center</th>');

    await selectAssistantText(page, "First");
    await copySelection(page);

    const partialClipboard = await readRichClipboard(page);
    expect(partialClipboard.plainText).toBe("- **[First](https://example.com/issues/1)**");
    expect(partialClipboard.html).toContain(
      '<li><strong><a href="https://example.com/issues/1">First</a></strong></li>',
    );

    await selectAssistantText(page, "docs");
    await copySelection(page);

    const titledLinkClipboard = await readRichClipboard(page);
    expect(titledLinkClipboard.plainText).toBe('[docs](https://docs.example.com "Reference")');
    expect(titledLinkClipboard.html).toContain(
      '<a href="https://docs.example.com/" title="Reference">docs</a>',
    );

    await selectAssistantText(page, "https://autolink.example.com");
    await copySelection(page);

    const autolinkClipboard = await readRichClipboard(page);
    expect(autolinkClipboard.plainText).toBe(
      "[https://autolink.example.com](https://autolink.example.com)",
    );
    expect(autolinkClipboard.html).toContain(
      '<a href="https://autolink.example.com/">https://autolink.example.com</a>',
    );

    await selectAssistantText(page, "workspace file");
    await copySelection(page);

    const fileLinkClipboard = await readRichClipboard(page);
    expect(fileLinkClipboard.plainText).toBe(
      "[workspace file](file:///tmp/jagentdesk%20notes.md#L4)",
    );
    expect(fileLinkClipboard.html).toContain(
      '<a href="file:///tmp/jagentdesk%20notes.md#L4">workspace file</a>',
    );

    await selectAssistantTextRange(page, "Seventh item", "Eighth item");
    await copySelection(page);

    const midListClipboard = await readRichClipboard(page);
    expect(midListClipboard.plainText).toBe("7. Seventh item\n8. Eighth item");
    expect(midListClipboard.html).toContain('<ol start="7">');

    await selectAssistantTextRange(page, "Inner eight", "Inner nine");
    await copySelection(page);

    const nestedListClipboard = await readRichClipboard(page);
    expect(nestedListClipboard.plainText).toBe("3. 8. Inner eight\n    9. Inner nine");
    expect(nestedListClipboard.html).toContain('<ol start="8">');

    await selectAssistantTextRange(page, "Seventh item", "Nested list:");
    await copySelection(page);

    const crossBlockClipboard = await readRichClipboard(page);
    expect(crossBlockClipboard.plainText).toBe("7. Seventh item\n8. Eighth item\n\nNested list:");
    expect(crossBlockClipboard.html).toContain('<ol start="7">');

    await selectAssistantText(page, "Current");
    await copySelection(page);

    const partialTableClipboard = await readRichClipboard(page);
    expect(partialTableClipboard.plainText).toBe("Current");
    expect(partialTableClipboard.html).toContain("<p>Current</p>");
    expect(partialTableClipboard.html).not.toContain("&lt;table");

    await selectAssistantTextRange(page, "Right", "ready");
    await copySelection(page);

    const columnSliceClipboard = await readRichClipboard(page);
    expect(columnSliceClipboard.plainText).toContain("ready");
    expect(columnSliceClipboard.html).not.toContain("<table>");
    expect(columnSliceClipboard.html).toContain("ready");
    expect(columnSliceClipboard.html).toContain("<s>obsolete</s>");
  } finally {
    await agent.cleanup();
  }
});

const QUOTE_BODY = [
  "Draft for the team: **ship it** with [the notes](https://example.com/notes).",
  "",
  "> Nested reply.",
  "",
  "```ts",
  "const quoted = 1;",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  Start --> Done",
  "```",
  "",
  "Thanks!",
].join("\n");

const QUOTE_MARKDOWN = [
  "Text before the quote.",
  "",
  ...QUOTE_BODY.split("\n").map((line) => (line ? `> ${line}` : ">")),
  "",
  "> [!NOTE]",
  "> Heads up before you paste.",
  "",
  "Text after the quote.",
].join("\n");

function assistantMessageBlocks(page: Page): Locator {
  return page.locator("[data-message-id]").filter({ has: page.getByTestId("assistant-message") });
}

function assistantQuote(page: Page, index: number): Locator {
  return assistantMessageBlocks(page).getByRole("blockquote").nth(index);
}

/** A quote's own control is its first, ahead of any nested quote's. */
function quoteCopyControl(quote: Locator): Locator {
  return quote.getByRole("button", { name: "Copy quote" }).first();
}

async function copyQuote(quote: Locator): Promise<void> {
  await quote.hover();
  await quoteCopyControl(quote).click();
  await expect(quote.getByRole("button", { name: "Copied" })).toBeVisible();
}

async function pasteIntoPlainAndRichFields(page: Page): Promise<{ plain: Locator; rich: Locator }> {
  await page.evaluate(() => {
    const fields = document.createElement("div");
    fields.style.cssText = "position: fixed; bottom: 0; left: 0; z-index: 10000; background: white";
    const plainText = document.createElement("textarea");
    plainText.setAttribute("aria-label", "Plain text paste");
    const richText = document.createElement("div");
    richText.contentEditable = "true";
    richText.setAttribute("role", "textbox");
    richText.setAttribute("aria-label", "Rich text paste");
    fields.append(plainText, richText);
    document.body.append(fields);
  });
  const plain = page.getByRole("textbox", { name: "Plain text paste" });
  await plain.focus();
  await page.keyboard.press("ControlOrMeta+v");
  const rich = page.getByRole("textbox", { name: "Rich text paste" });
  await rich.focus();
  await page.keyboard.press("ControlOrMeta+v");
  return { plain, rich };
}

test("a quote's copy control copies only that quote's body", async ({ context, page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-quote-copy-",
    title: "Assistant quote copy",
    initialPrompt: "Render the quote fixture.",
    featureValues: { mockAssistantResponse: QUOTE_MARKDOWN },
  });

  try {
    await allowRichClipboard(context);
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await openAgentRoute(page, agent);
    const quote = assistantQuote(page, 0);
    const nested = assistantQuote(page, 1);
    await expect(quote).toContainText("Thanks!");

    await test.step("an admonition has no copy control", async () => {
      await expect(assistantMessageBlocks(page)).toContainText("Heads up before you paste.");
      await expect(
        assistantMessageBlocks(page).getByRole("button", { name: "Copy quote" }),
      ).toHaveCount(2);
    });

    await test.step("the control appears on hover or keyboard focus", async () => {
      const control = quoteCopyControl(quote);
      await expect(control).toHaveCSS("opacity", "0");
      await quote.hover();
      await expect(control).toHaveCSS("opacity", "1");
      await page.mouse.move(0, 0);
      await expect(control).toHaveCSS("opacity", "0");
      await control.focus();
      await expect(control).toHaveCSS("opacity", "1");
      await control.blur();
    });

    await test.step("copying the quote takes its body, with a diagram as its fence", async () => {
      await expect(quote.getByRole("img", { name: "Diagram" })).toBeVisible({ timeout: 30_000 });
      await copyQuote(quote);
      const copied = await readRichClipboard(page);
      expect(copied.plainText).toBe(QUOTE_BODY);
      expect(copied.html).toContain("<strong>ship it</strong>");
      expect(copied.html).toContain("<blockquote>");
    });

    await test.step("the copy pastes as Markdown and as rich text", async () => {
      const { plain, rich } = await pasteIntoPlainAndRichFields(page);
      await expect(plain).toHaveValue(QUOTE_BODY);
      await expect(rich.locator("strong")).toHaveText("ship it");
      await expect(rich.getByRole("link", { name: "the notes" })).toHaveAttribute(
        "href",
        "https://example.com/notes",
      );
      await expect(rich).not.toContainText("Text before the quote.");
    });

    await test.step("a nested quote copies only itself", async () => {
      await copyQuote(nested);
      await expect
        .poll(async () => (await readRichClipboard(page)).plainText)
        .toBe("Nested reply.");
    });

    await test.step("a code block in the quote keeps its own copy", async () => {
      const code = quote.getByText("const quoted = 1;", { exact: true });
      await code.hover();
      await quote.getByRole("button", { name: "Copy code" }).first().click();
      await expect.poll(() => readPlainClipboard(page)).toBe("const quoted = 1;");
    });

    await test.step("a phone-sized layout shows the control above the full-width text", async () => {
      await page.mouse.move(0, 0);
      await page.setViewportSize({ width: 390, height: 844 });
      const control = quoteCopyControl(quote);
      await expect(control).toHaveCSS("opacity", "1");
      const controlBox = await control.boundingBox();
      const firstLine = await quote.getByText(/^Draft for the team/).boundingBox();
      expect(controlBox && firstLine).toBeTruthy();
      // The text starts below the control instead of wrapping short of it.
      expect(firstLine!.y).toBeGreaterThanOrEqual(controlBox!.y + controlBox!.height);
      expect(firstLine!.x + firstLine!.width).toBeGreaterThan(controlBox!.x);
    });
  } finally {
    await agent.cleanup();
  }
});
