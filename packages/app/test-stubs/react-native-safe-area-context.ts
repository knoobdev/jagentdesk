import { createContext, useContext } from "react";
// The package ships untranspiled Flow, which the unit project cannot parse. Insets are a device
// fact; tests can provide them through the same context as the real package.
const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 } as const;

export const SafeAreaInsetsContext = createContext<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>(ZERO_INSETS);
export const useSafeAreaInsets = () => useContext(SafeAreaInsetsContext);
export const useSafeAreaFrame = () => ({ x: 0, y: 0, width: 0, height: 0 });
export const SafeAreaProvider = ({ children }: { children?: unknown }) => children;
export const SafeAreaView = ({ children }: { children?: unknown }) => children;
export const initialWindowMetrics = {
  insets: ZERO_INSETS,
  frame: { x: 0, y: 0, width: 0, height: 0 },
};
