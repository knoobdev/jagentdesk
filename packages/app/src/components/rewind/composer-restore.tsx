import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

interface RewindComposerRestoreContextValue {
  restoreTextIfComposerEmpty: (text: string) => void;
}

interface RewindComposerRestoreProviderProps {
  text: string;
  getText?: () => string;
  onRewindComplete?: (restored: boolean) => void;
  setText: (text: string) => void;
  children: ReactNode;
}

const RewindComposerRestoreContext = createContext<RewindComposerRestoreContextValue | null>(null);

export function restoreComposerTextIfEmpty(input: {
  currentText: string;
  rewoundText: string;
}): string {
  if (input.currentText.length > 0) {
    return input.currentText;
  }
  return input.rewoundText;
}

export function RewindComposerRestoreProvider({
  text,
  getText,
  onRewindComplete,
  setText,
  children,
}: RewindComposerRestoreProviderProps) {
  const textRef = useRef(text);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const restoreTextIfComposerEmpty = useCallback(
    (rewoundText: string) => {
      const currentText = getText?.() ?? textRef.current;
      const nextText = restoreComposerTextIfEmpty({
        currentText,
        rewoundText,
      });
      if (nextText !== currentText) {
        setText(nextText);
      }
      onRewindComplete?.(nextText !== currentText);
    },
    [setText, getText, onRewindComplete],
  );

  const value = useMemo(() => ({ restoreTextIfComposerEmpty }), [restoreTextIfComposerEmpty]);

  return (
    <RewindComposerRestoreContext.Provider value={value}>
      {children}
    </RewindComposerRestoreContext.Provider>
  );
}

export function useRewindComposerRestore(): RewindComposerRestoreContextValue | null {
  return useContext(RewindComposerRestoreContext);
}
