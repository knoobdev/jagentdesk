import { useCallback, useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { BrowserAutomationPendingDialog } from "@jagentdesk/protocol/browser-automation/rpc-schemas";
import { Button } from "@/components/ui/button";
import { getDesktopHost, type DesktopBrowserDialogEvent } from "@/desktop/host";

const TITLE_KEYS = {
  alert: "workspace.browser.dialog.alertTitle",
  confirm: "workspace.browser.dialog.confirmTitle",
  prompt: "workspace.browser.dialog.promptTitle",
} as const;

function isDialogEvent(payload: unknown): payload is DesktopBrowserDialogEvent {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { browserId?: unknown }).browserId === "string"
  );
}

/** The tab's pending JavaScript dialog; null when none. Updates when the agent answers it. */
function usePendingDialog(browserId: string): BrowserAutomationPendingDialog | null {
  const [dialog, setDialog] = useState<BrowserAutomationPendingDialog | null>(null);
  useEffect(() => {
    const host = getDesktopHost();
    let active = true;
    void host?.browser
      ?.getDialog?.(browserId)
      .then((current) => {
        if (active) setDialog(current ?? null);
        return undefined;
      })
      .catch(() => undefined);
    const unsubscribe = host?.events?.on?.("browser-dialog", (payload) => {
      if (isDialogEvent(payload) && payload.browserId === browserId) {
        setDialog(payload.pendingDialog);
      }
    });
    return () => {
      active = false;
      if (typeof unsubscribe === "function") unsubscribe();
      else void unsubscribe?.then((dispose) => dispose());
    };
  }, [browserId]);
  return dialog;
}

/**
 * alert/confirm/prompt of an agentic tab (ADR-0025), shown in the tab instead of a native box.
 * The agent answers the same dialog with browser_dialog; whoever answers first wins.
 */
export function BrowserDialogBar({ browserId }: { browserId: string }) {
  const { t } = useTranslation();
  const dialog = usePendingDialog(browserId);
  const [text, setText] = useState("");
  const dialogId = dialog?.id ?? null;
  const defaultValue = dialog?.defaultValue ?? "";

  useEffect(() => {
    setText(defaultValue);
  }, [dialogId, defaultValue]);

  const answer = useCallback(
    (action: "accept" | "dismiss") => {
      void getDesktopHost()
        ?.browser?.answerDialog?.(browserId, {
          action,
          ...(dialog?.type === "prompt" ? { text } : {}),
        })
        .catch(() => undefined);
    },
    [browserId, dialog?.type, text],
  );

  const accept = useCallback(() => answer("accept"), [answer]);
  const dismiss = useCallback(() => answer("dismiss"), [answer]);

  if (!dialog) return null;
  const title = t(TITLE_KEYS[dialog.type]);

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <View style={styles.card} accessibilityRole="alert" testID="browser-dialog-bar">
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {dialog.message ? (
          <Text numberOfLines={6} selectable style={styles.message}>
            {dialog.message}
          </Text>
        ) : null}
        {dialog.type === "prompt" ? (
          <ThemedInput
            accessibilityLabel={t("workspace.browser.dialog.promptTitle")}
            autoFocus
            onChangeText={setText}
            onSubmitEditing={accept}
            style={styles.input}
            uniProps={placeholderMapping}
            value={text}
          />
        ) : null}
        <View style={styles.footer}>
          <Text numberOfLines={2} style={styles.hint}>
            {t("workspace.browser.dialog.hint")}
          </Text>
          <View style={styles.actions}>
            {dialog.type === "alert" ? null : (
              <Button variant="ghost" size="sm" onPress={dismiss}>
                {t("workspace.browser.dialog.dismiss")}
              </Button>
            )}
            <Button variant="default" size="sm" onPress={accept}>
              {t("workspace.browser.dialog.accept")}
            </Button>
          </View>
        </View>
      </View>
    </View>
  );
}

const ThemedInput = withUnistyles(TextInput);
const placeholderMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    padding: theme.spacing[3],
    alignItems: "center",
  },
  card: {
    width: "100%",
    maxWidth: 440,
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  input: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hint: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
