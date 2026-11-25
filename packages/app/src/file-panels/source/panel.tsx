import { useState, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { RetainedPanel } from "@/components/retained-panel";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
export type TextFileView = "preview" | "source";
export function useTextFileView(
  params: WorkspaceFileLocation,
  revision: number,
): [TextFileView, (view: TextFileView) => void] {
  const lineTarget = params.lineStart ? revision : null;
  const [view, setView] = useState<TextFileView>(lineTarget === null ? "preview" : "source");
  const [shownLineTarget, setShownLineTarget] = useState(lineTarget);
  if (lineTarget !== null && lineTarget !== shownLineTarget) {
    setShownLineTarget(lineTarget);
    setView("source");
  }
  return [view, setView];
}
// Preserve each scroll owner and the editor buffer across view switches.
export function RetainedFileView({ active, children }: { active: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(active);
  if (active && !shown) setShown(true);
  if (!shown) return null;
  return (
    <RetainedPanel active={active} style={styles.view}>
      {children}
    </RetainedPanel>
  );
}
const styles = StyleSheet.create({ view: { minHeight: 0 } });
