// Cancel asks why: the reason stays on the item and goes to the bot. Nothing is deleted.
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/items/BotItemCancelDialog.tsx:1-76.
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { BotItem } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { Theme } from "@/styles/theme";

export function BotItemCancelDialog({
  items,
  onCancel,
  onClose,
}: {
  /** The items to cancel; null while closed. */
  items: readonly BotItem[] | null;
  onCancel: (reason: string) => void;
  onClose: () => void;
}) {
  if (!items) return null;
  return <CancelSheet items={items} onCancel={onCancel} onClose={onClose} />;
}

function CancelSheet({
  items,
  onCancel,
  onClose,
}: {
  items: readonly BotItem[];
  onCancel: (reason: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const count = items.length;
  const submit = useCallback(() => {
    if (reason.trim()) onCancel(reason.trim());
  }, [reason, onCancel]);
  const header = useMemo(
    () => ({
      title:
        count === 1
          ? t("bots.items.cancel.titleOne", { title: items[0]?.title ?? "" })
          : t("bots.items.cancel.titleMany", { count }),
    }),
    [count, items, t],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="ghost" size="sm" onPress={onClose} testID="bot-item-cancel-keep">
          {t("bots.items.cancel.keep")}
        </Button>
        <Button
          variant="default"
          size="sm"
          disabled={!reason.trim()}
          onPress={submit}
          testID="bot-item-cancel-confirm"
        >
          {count === 1
            ? t("bots.items.cancel.confirmOne")
            : t("bots.items.cancel.confirmMany", { count })}
        </Button>
      </View>
    ),
    [onClose, t, reason, submit, count],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      onDismiss={onClose}
      footer={footer}
      desktopMaxWidth={384}
      testID="bot-item-cancel-dialog"
    >
      <Text style={styles.why}>{t("bots.items.cancel.why")}</Text>
      <FormTextInput
        autoFocus
        value={reason}
        initialValue=""
        webControlled
        onChangeText={setReason}
        placeholder={t("bots.items.cancel.placeholder")}
        accessibilityLabel={t("bots.items.cancel.placeholder")}
        onSubmitEditing={submit}
        size="sm"
        testID="bot-item-cancel-reason"
      />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  why: { marginBottom: 10, fontSize: 13, lineHeight: 18, color: theme.colors.foregroundMuted },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
}));
