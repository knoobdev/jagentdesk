import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
  type ReactElement,
} from "react";

interface ComposerKeyboardScopeValue {
  isActiveComposer: boolean;
  isInputFocused: boolean;
}

const ComposerKeyboardScopeContext = createContext<ComposerKeyboardScopeValue>({
  isActiveComposer: false,
  isInputFocused: false,
});

export function ComposerKeyboardScopeProvider({
  isActiveComposer,
  isInputFocused,
  children,
}: PropsWithChildren<ComposerKeyboardScopeValue>): ReactElement {
  const value = useMemo(
    () => ({ isActiveComposer, isInputFocused }),
    [isActiveComposer, isInputFocused],
  );
  return (
    <ComposerKeyboardScopeContext.Provider value={value}>
      {children}
    </ComposerKeyboardScopeContext.Provider>
  );
}

export function useComposerKeyboardScope(): ComposerKeyboardScopeValue {
  return useContext(ComposerKeyboardScopeContext);
}
