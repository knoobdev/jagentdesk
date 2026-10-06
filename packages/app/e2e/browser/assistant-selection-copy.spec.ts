import type { BrowserContext } from "@playwright/test";
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

/**
 * Select an element from the end of the text before it. A drag that starts in the gap
 * above a block anchors there, so nothing outside the element is highlighted.
 */
async function selectAssistantElementFromEndOf(
  page: Page,
  startText: string,
  selector: string,
): Promise<void> {
  await assistantMessageBlocks(page).evaluateAll(
    (blocks, selected) => {
      let startNode: Text | null = null;
      for (const block of blocks) {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.endsWith(selected.startText)) {
            startNode = walker.currentNode as Text;
          }
        }
      }
      const end = blocks.map((block) => block.querySelector(selected.selector)).find(Boolean);
      if (!startNode || !end) {
        throw new Error(`Could not find ${selected.startText} — ${selected.selector}`);
      }
      const range = document.createRange();
      range.setStart(startNode, startNode.length);
      range.setEnd(end, end.childNodes.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { startText, selector },
  );
}

/** A drag over an image alone selects it inside its rendered frame. */
async function selectAssistantImage(page: Page): Promise<void> {
  await assistantMessageBlocks(page)
    .locator("img")
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNode(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
}

/** Press in the gap below the image and drag to the end of `text` in the block after it. */
async function dragFromBelowImageTo(page: Page, text: string): Promise<void> {
  const blocks = assistantMessageBlocks(page);
  const target = blocks.getByText(text);
  await target.scrollIntoViewIfNeeded();
  const frame = await blocks.locator('[data-jagentdesk-markdown-tag="img"]').boundingBox();
  const end = await target.evaluate((element, selectedText) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const offset = node.textContent?.indexOf(selectedText) ?? -1;
      if (offset >= 0) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + selectedText.length);
        const box = range.getBoundingClientRect();
        return { x: box.right - 1, y: box.top + box.height / 2, left: box.left };
      }
    }
    throw new Error(`Could not find ${selectedText}`);
  }, text);
  if (!frame) {
    throw new Error("Expected a rendered image");
  }
  await page.mouse.move(end.left + 5, frame.y + frame.height + 4);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
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
    expect(fileLinkClipboard.plainText).toBe("[workspace file](file:///tmp/jagentdesk%20notes.md#L4)");
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

    // A partial selection loses its `pre` wrapper, so the code reaches Turndown as
    // prose unless it is diverted first: the line break and the indentation go, and
    // Markdown-significant characters get escaped.
    await selectAssistantAcrossCodeLines(page, "const", "return");
    await copySelection(page);

    const codeLinesClipboard = await readRichClipboard(page);
    expect(codeLinesClipboard.plainText).toBe('const answer = "yes";\n  return');
    expect(codeLinesClipboard.html).toContain('<pre><code class="language-typescript">');

    // Selecting inside code expresses an intent to copy code, even when the selection
    // contains every character in the block.
    await selectAssistantElement(
      page,
      '[data-paseo-markdown-language="typescript"] [data-paseo-markdown-tag="code"]',
    );
    await copySelection(page);

    const completeCodeClipboard = await readRichClipboard(page);
    expect(completeCodeClipboard.plainText).toBe('const answer = "yes";\n  return answer;');

    // Touching the block before it without selecting any of its text is still a
    // selection inside the code.
    await selectAssistantElementFromEndOf(
      page,
      "not a generated link.",
      '[data-paseo-markdown-language="typescript"] [data-paseo-markdown-tag="code"]',
    );
    await copySelection(page);

    expect((await readRichClipboard(page)).plainText).toBe(
      'const answer = "yes";\n  return answer;',
    );

    // Crossing the block boundary expresses an intent to carry its Markdown structure.
    await selectAssistantAcrossCodeLines(page, "const", "After code.");
    await copySelection(page);

    const crossedCodeClipboard = await readRichClipboard(page);
    expect(crossedCodeClipboard.plainText).toBe(
      '```typescript\nconst answer = "yes";\n  return answer;\n```\n\nAfter code.',
    );

    // Selecting a whole line runs off its end into the newline node. A trailing
    // newline auto-executes the line when it is pasted into a terminal.
    await selectAssistantAcrossCodeLines(page, "const", "  ");
    await copySelection(page);

    expect((await readRichClipboard(page)).plainText).toBe('const answer = "yes";');

    // The block's own Copy button had the same hazard: a Markdown fence body ends in
    // a newline, and the button copied it raw.
    const typescriptFence = assistantMessage.locator('[data-paseo-markdown-language="typescript"]');
    // The button is opacity 0 / pointerEvents none until the fence is hovered.
    await typescriptFence.hover();
    await typescriptFence.locator("[data-paseo-markdown-ignore]").click();

    expect(await readPlainClipboard(page)).toBe('const answer = "yes";\n  return answer;');

    // A blank line before the closing fence leaves the body ending in two newlines,
    // so stripping only the terminal one still hands the terminal an executable line.
    const bashFence = assistantMessage.locator('[data-paseo-markdown-language="bash"]');
    await bashFence.hover();
    await bashFence.locator("[data-paseo-markdown-ignore]").click();

    expect(await readPlainClipboard(page)).toBe("echo trailing");
  } finally {
    await agent.cleanup();
  }
});

test("copying a selection across an assistant image keeps its Markdown source and alt text", async ({
  context,
  page,
}) => {
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-selection-copy-image-",
    title: "Assistant selection copy image",
    initialPrompt: "Render the image fixture.",
    featureValues: {
      mockAssistantResponse: [
        "Before the image.",
        "",
        `![chart](${image})`,
        "",
        "After the image.",
      ].join("\n"),
    },
  });

  try {
    await allowRichClipboard(context);
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await openAgentRoute(page, agent);
    await expect(assistantMessageBlocks(page).locator("img")).toHaveCount(1);

    await selectAssistantTextRange(page, "Before the image.", "After the image.");
    await copySelection(page);

    expect((await readRichClipboard(page)).plainText).toBe(
      `Before the image.\n\n![chart](${image})\n\nAfter the image.`,
    );

    await selectAssistantImage(page);
    await copySelection(page);

    expect((await readRichClipboard(page)).plainText).toBe(`![chart](${image})`);

    await dragFromBelowImageTo(page, "After the");
    await copySelection(page);

    expect((await readRichClipboard(page)).plainText).toBe("After the");
  } finally {
    await agent.cleanup();
  }
});
