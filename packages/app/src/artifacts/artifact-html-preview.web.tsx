import { useMemo } from "react";
import type { ArtifactHtmlPreviewProps } from "./artifact-html-preview";

// Live HTML/SVG artifact preview (web: electron renderer + guest web surface). Rendered in a
// heavily SANDBOXED iframe: allow-scripts for interactive artifacts, but NO allow-same-origin, so
// the artifact can't touch the app's origin, storage, cookies, or the parent DOM. Untrusted
// agent/guest-visible content — treat as hostile.
export function ArtifactHtmlPreview({ html }: ArtifactHtmlPreviewProps) {
  const style = useMemo<React.CSSProperties>(
    () => ({ width: "100%", height: "100%", border: "none", background: "#fff" }),
    [],
  );
  return (
    <iframe
      title="Artifact preview"
      sandbox="allow-scripts"
      srcDoc={html}
      style={style}
      referrerPolicy="no-referrer"
    />
  );
}
