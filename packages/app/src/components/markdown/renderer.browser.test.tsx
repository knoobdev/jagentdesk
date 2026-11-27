import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ToastProvider } from "@/contexts/toast-context";
import { MarkdownRenderer } from "./renderer";

it("parses headings and fenced code through the patched WASM engine", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  try {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          {/* The code block's copy button reports through a toast. */}
          <ToastProvider>
            <MarkdownRenderer
              text={"# Rendered heading\n\n```typescript\nconst answer = 42;\n```"}
            />
          </ToastProvider>
        </QueryClientProvider>,
      ),
    );
    await expect.poll(() => host.querySelector("h1")?.textContent).toBe("Rendered heading");
    expect(host.querySelector('[data-jagentdesk-markdown-tag="pre"]')?.textContent).toContain(
      "const answer = 42;",
    );
    expect(host.textContent).not.toContain("```typescript");
  } finally {
    act(() => root.unmount());
    host.remove();
    client.clear();
  }
});

it("renders a table whose header row directly follows a bold line", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  try {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MarkdownRenderer
            text={"**Câu chữ mới cần anh duyệt:**\n| Chỗ | Chữ |\n|---|---|\n| Pill | Activated |"}
          />
        </QueryClientProvider>,
      ),
    );
    await expect.poll(() => host.querySelectorAll("table tr").length).toBe(2);
    expect(host.querySelector("strong")?.textContent).toBe("Câu chữ mới cần anh duyệt:");
    expect(host.textContent).not.toContain("|---|");
    expect(host.textContent).not.toContain("| Chỗ");
  } finally {
    act(() => root.unmount());
    host.remove();
    client.clear();
  }
});
