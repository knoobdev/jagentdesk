import type { FigmaFile } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaLocationPatch } from "./nav";

export function filterSavedFigmaFiles(files: readonly FigmaFile[], search: string): FigmaFile[] {
  const needle = search.trim().toLocaleLowerCase();
  return files.filter((file) => file.name.toLocaleLowerCase().includes(needle));
}

// Only navigation and reading the saved index are capabilities of Browse. Adding a file or
// authenticating a website belongs to neither operation. A failed read remains a failed read.
export async function openFigmaFiles(
  ports: {
    go: (patch: FigmaLocationPatch) => void;
    refresh: (connectionId: string) => Promise<unknown>;
  },
  connectionId: string,
): Promise<void> {
  ports.go({
    connectionId,
    view: "files",
    fileKey: null,
    pageId: null,
    nodeId: null,
    version: null,
  });
  await ports.refresh(connectionId);
}
