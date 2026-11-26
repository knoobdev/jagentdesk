import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  ToastViewport,
  useToastHost,
  type ToastApi,
  type ToastState,
} from "@/components/toast-host";
import { ToastApiProvider, useToast } from "@/contexts/toast-context";

const SidebarPersistentToastContext = createContext<((toast: ToastState | null) => void) | null>(
  null,
);
const SidebarAppToastContext = createContext<ToastApi | null>(null);

/**
 * Shows toasts raised by the sidebar's list over its bottom edge, just above the footer.
 *
 * A collapsed sidebar stays mounted and its rows still handle shortcuts, so while it is hidden
 * their toasts go to the app's host instead. The sidebar's API stays stable across open and close
 * so that toggling the panel doesn't re-render every row.
 */
export function SidebarToastRegion({ active, children }: { active: boolean; children: ReactNode }) {
  const appToast = useToast();
  const { api: sidebarToast, toast, dismiss } = useToastHost();
  const [persistentToast, setPersistentToast] = useState<ToastState | null>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
    return () => {
      // An archive holds on to this API, so a failure that lands later needs a host on screen.
      activeRef.current = false;
      // A toast must not outlive its visibility: its dismissal is what ends an archive's undo.
      dismiss();
    };
  }, [active, dismiss]);

  const api = useMemo<ToastApi>(() => {
    const visibleHost = () => (activeRef.current ? sidebarToast : appToast);
    return {
      show: (content, options) => visibleHost().show(content, options),
      copied: (label) => visibleHost().copied(label),
      error: (message) => visibleHost().error(message),
    };
  }, [appToast, sidebarToast]);

  return (
    <View style={styles.region}>
      <ToastApiProvider api={api}>
        <SidebarAppToastContext.Provider value={appToast}>
          <SidebarPersistentToastContext.Provider value={setPersistentToast}>
            {children}
          </SidebarPersistentToastContext.Provider>
        </SidebarAppToastContext.Provider>
        <ToastViewport
          toast={toast}
          persistentToast={persistentToast}
          onDismiss={dismiss}
          placement="sidebar"
        />
      </ToastApiProvider>
    </View>
  );
}

/** Returns the enclosing app-level toast API so sidebar callers can report errors without displacing an active sidebar undo toast. */
export function useSidebarAppToast(): ToastApi {
  const fallbackToast = useToast();
  return useContext(SidebarAppToastContext) ?? fallbackToast;
}

/**
 * Displays a persistent toast in the enclosing `SidebarToastRegion`, stacked below any active
 * transient toast so controls stay reachable while a previous toast is up.
 */
export function useSidebarPersistentToast(toast: ToastState | null): void {
  const setPersistentToast = useContext(SidebarPersistentToastContext);
  useEffect(() => {
    setPersistentToast?.(toast);
  }, [setPersistentToast, toast]);
  useEffect(() => {
    return () => {
      setPersistentToast?.(null);
    };
  }, [setPersistentToast]);
}

const styles = StyleSheet.create({
  region: {
    position: "relative",
    flex: 1,
    minHeight: 0,
  },
});
