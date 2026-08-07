import type { Doc } from "~/docs";

export function DocsSourceFooter({ doc }: { doc: Doc }) {
  return (
    <footer className="docs-source-footer">
      <span>Source: {doc.sourcePath}</span>
    </footer>
  );
}
