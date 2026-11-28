import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface TimelineRowSheetProps {
  visible: boolean;
  /** The user closed the sheet. */
  onClose: () => void;
  /** The sheet finished its exit animation; the host unmounts it. */
  onDismiss: () => void;
}

export type TimelineRowSheetRender = (props: TimelineRowSheetProps) => ReactNode;

interface TimelineRowSheetContextValue {
  /** Opens a sheet. `key` names what it shows, so its row can show itself as open. */
  openRowSheet: (key: string, render: TimelineRowSheetRender) => void;
  /** The key of the open sheet, or null. */
  openKey: string | null;
}

interface HostedSheet {
  id: number;
  key: string;
  render: TimelineRowSheetRender;
  visible: boolean;
}

const TimelineRowSheetContext = createContext<TimelineRowSheetContextValue | null>(null);

export function useTimelineRowSheet(): TimelineRowSheetContextValue {
  const context = useContext(TimelineRowSheetContext);
  if (!context) {
    throw new Error("useTimelineRowSheet must be used within a TimelineRowSheetProvider");
  }
  return context;
}

/**
 * Hosts the sheets a timeline row opens ("View block", "View handoff", turn stats on phones) above
 * the list, as `ToolCallSheetProvider` does for tool calls (Paseo's pattern). Rows are virtualized:
 * on phones LegendList unmounts a row once it scrolls past the draw distance, which happens while
 * the agent streams and the list follows the end. A sheet whose open state lived in the row closed
 * with it. Here the sheet stays open until the user closes it.
 */
export function TimelineRowSheetProvider({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<HostedSheet | null>(null);
  const nextId = useRef(0);
  const openRowSheet = useCallback((key: string, render: TimelineRowSheetRender) => {
    nextId.current += 1;
    setSheet({ id: nextId.current, key, render, visible: true });
  }, []);
  const close = useCallback(() => {
    setSheet((current) => (current?.visible ? { ...current, visible: false } : current));
  }, []);
  const dismiss = useCallback(() => {
    setSheet((current) => (current && !current.visible ? null : current));
  }, []);
  const openKey = sheet?.visible ? sheet.key : null;
  const value = useMemo(() => ({ openRowSheet, openKey }), [openRowSheet, openKey]);
  return (
    <TimelineRowSheetContext.Provider value={value}>
      {children}
      {sheet ? (
        <Fragment key={sheet.id}>
          {sheet.render({ visible: sheet.visible, onClose: close, onDismiss: dismiss })}
        </Fragment>
      ) : null}
    </TimelineRowSheetContext.Provider>
  );
}
