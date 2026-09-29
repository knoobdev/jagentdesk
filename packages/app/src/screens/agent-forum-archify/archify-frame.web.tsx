import { useEffect, useMemo, useRef, useState } from "react";
import { ARCHIFY_REPLAY_MESSAGE, ARCHIFY_SIZE_MESSAGE } from "./archify-document";
import { fitArchifyFrameHeight } from "./archify-frame-height";
import type { ArchifyFrameProps } from "./archify-frame-types";

// ADR-0021 §4 (same isolation as the file-pane HTML preview): `allow-scripts` only, so the diagram
// runs archify's viewer in an opaque origin with no access to the app's DOM, cookies or storage,
// and no downloads, popups or top navigation. The CSP inside the document blocks every fetch.
const SANDBOX = "allow-scripts";

export function ArchifyFrame({ document, replayToken, height, title, testID }: ArchifyFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const lastReplayTokenRef = useRef(replayToken);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const frameHeight = fitArchifyFrameHeight(contentHeight, height);
  const style = useMemo(
    () => ({ width: "100%", height: frameHeight, border: "none", display: "block" }) as const,
    [frameHeight],
  );

  useEffect(() => {
    setContentHeight(null);
    const onMessage = (event: MessageEvent) => {
      // Only the frame's own window may resize it.
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data?.type !== ARCHIFY_SIZE_MESSAGE || typeof data.height !== "number") return;
      setContentHeight(data.height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [document]);

  useEffect(() => {
    // Replay only on a change after mount: a (re)loaded document already plays its first pass.
    if (replayToken === lastReplayTokenRef.current) return;
    lastReplayTokenRef.current = replayToken;
    // The frame has an opaque origin, so "*" is the only target origin that reaches it.
    frameRef.current?.contentWindow?.postMessage({ type: ARCHIFY_REPLAY_MESSAGE }, "*");
  }, [replayToken]);

  return (
    <iframe
      ref={frameRef}
      data-testid={testID}
      title={title}
      srcDoc={document}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      style={style}
    />
  );
}
