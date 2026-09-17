import type { TextStyle } from "react-native";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";

export interface ArtifactHtmlPreviewProps {
  html: string;
}

const EMPTY_TEXT_STYLE: TextStyle = {};

// Fallback (non-web, non-native platforms / SSR): show the HTML source rather than a live preview.
export function ArtifactHtmlPreview({ html }: ArtifactHtmlPreviewProps) {
  return (
    <HighlightedCodeBlock
      code={html}
      language="html"
      inheritedStyles={EMPTY_TEXT_STYLE}
      textStyle={EMPTY_TEXT_STYLE}
    />
  );
}
