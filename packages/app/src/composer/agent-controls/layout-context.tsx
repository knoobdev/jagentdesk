import { createContext, useContext, type ReactNode } from "react";
import {
  type ComposerControlPresentation,
  resolveComposerControlPresentation,
} from "@/composer/agent-controls/layout";
import { toolbarGlyphsFor, type ToolbarGlyphs } from "@/components/ui/control-geometry";

interface ComposerControlLayoutValue {
  glyphs: ToolbarGlyphs;
  presentation: ComposerControlPresentation;
}

const DEFAULT_LAYOUT: ComposerControlLayoutValue = {
  glyphs: toolbarGlyphsFor("pointer"),
  presentation: resolveComposerControlPresentation("full"),
};

const ComposerControlLayoutContext = createContext(DEFAULT_LAYOUT);

export function ComposerControlLayoutProvider({
  value,
  children,
}: {
  value: ComposerControlLayoutValue;
  children: ReactNode;
}) {
  return (
    <ComposerControlLayoutContext.Provider value={value}>
      {children}
    </ComposerControlLayoutContext.Provider>
  );
}

export function useComposerControlLayout(): ComposerControlLayoutValue {
  return useContext(ComposerControlLayoutContext);
}
