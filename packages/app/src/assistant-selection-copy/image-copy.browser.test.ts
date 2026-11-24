import { afterEach, expect, it } from "vitest";
import { createAssistantSelectionClipboardContent } from "./content.web";

const messages: HTMLElement[] = [];
function mountMessage(html: string) {
  const message = document.createElement("div");
  message.dataset.testid = "assistant-message";
  message.innerHTML = html;
  document.body.append(message);
  messages.push(message);
  return message;
}
function copy(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return createAssistantSelectionClipboardContent(selection)?.plainText;
}
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  for (const message of messages.splice(0)) message.remove();
});

it.each(["<img src='blob:https://localhost/preview'>", "<span>Image failed to load</span>"])(
  "copies the original source and alt text of a rendered image: %s",
  (image) => {
    const message = mountMessage(
      `<div data-jagentdesk-markdown-tag="img" data-jagentdesk-markdown-src="https://localhost/chart.png" data-jagentdesk-markdown-alt="chart">${image}</div>`,
    );
    const range = document.createRange();
    range.selectNodeContents(message);
    expect(copy(range)).toBe("![chart](https://localhost/chart.png)");
  },
);
