import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { ACTIVITY_GRAPH_STATUS_MESSAGE } from "@jagentdesk/protocol/agent-activity-graph";
import { ACTIVITY_GRAPH_VIEW_MESSAGE } from "./activity-graph-document";
import type {
  ActivityGraphFrameHandle,
  ActivityGraphFrameProps,
} from "./activity-graph-frame-types";
import { acceptSelectMessage } from "./activity-graph-target";

// ADR-0021 §4 on web/Electron: `allow-scripts` only (opaque origin, no storage/cookies, no
// downloads, popups or top navigation); the CSP in the document blocks every fetch. The only
// message accepted from the frame is `jad-archify-select` for a node of the shown version (31.6).
const SANDBOX = "allow-scripts";
const FRAME_STYLE = { width: "100%", height: "100%", border: "none", display: "block" } as const;

export const ActivityGraphFrame = forwardRef<ActivityGraphFrameHandle, ActivityGraphFrameProps>(
  function ActivityGraphFrame({ document, nodeIndex, onSelect, onLoad, title, testID }, ref) {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const nodeIndexRef = useRef(nodeIndex);
    nodeIndexRef.current = nodeIndex;
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;

    useImperativeHandle(
      ref,
      () => ({
        postStatus(nodes) {
          // The frame has an opaque origin, so "*" is the only target origin that reaches it.
          frameRef.current?.contentWindow?.postMessage(
            { type: ACTIVITY_GRAPH_STATUS_MESSAGE, nodes },
            "*",
          );
        },
        view(action, nodeId) {
          frameRef.current?.contentWindow?.postMessage(
            { type: ACTIVITY_GRAPH_VIEW_MESSAGE, action, ...(nodeId ? { nodeId } : {}) },
            "*",
          );
        },
      }),
      [],
    );

    useEffect(() => {
      const onMessage = (event: MessageEvent) => {
        // Only the frame's own window, and only a node of the version it shows.
        if (event.source !== frameRef.current?.contentWindow) return;
        const nodeId = acceptSelectMessage(event.data, nodeIndexRef.current);
        if (nodeId) onSelectRef.current(nodeId);
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, []);

    const style = useMemo(() => FRAME_STYLE, []);
    return (
      <iframe
        ref={frameRef}
        data-testid={testID}
        title={title}
        srcDoc={document}
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
        style={style}
        onLoad={onLoad}
      />
    );
  },
);
