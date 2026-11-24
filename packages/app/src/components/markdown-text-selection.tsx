import { createContext, type ReactNode, useContext } from "react";

export type MarkdownTextSurface = "prose" | "table-cell" | "control";

const MarkdownTextSurfaceContext = createContext<MarkdownTextSurface>("prose");

export function MarkdownTableCellText({ children }: { children: ReactNode }) {
  return <MarkdownTextSurfaceContext value="table-cell">{children}</MarkdownTextSurfaceContext>;
}

export function useMarkdownTextSurface(): MarkdownTextSurface {
  return useContext(MarkdownTextSurfaceContext);
}

export function iosMarkdownTextIsSelectable(surface: MarkdownTextSurface): boolean {
  return surface === "prose";
}

export function MarkdownTextSelection({
  selectable,
  children,
}: {
  selectable: boolean;
  children: ReactNode;
}) {
  const surface = useMarkdownTextSurface();
  return (
    <MarkdownTextSurfaceContext value={selectable ? surface : "control"}>
      {children}
    </MarkdownTextSurfaceContext>
  );
}
