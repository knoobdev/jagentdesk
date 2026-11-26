import { useCallback, useMemo, useState } from "react";
import { Pressable } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { BookmarkPlus } from "lucide-react-native";
import {
  isWeb,
  useToast,
  type BuiltinMessageActionProps,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { MemoryEditorSheet } from "./memory-editor-sheet";

/** The text the user selected in the chat, else the whole message. */
function selectedOrWhole(getContent: () => string): string {
  if (isWeb) {
    const selection = window.getSelection()?.toString().trim();
    if (selection) return selection;
  }
  return getContent().trim();
}

/** "Remember this" (spec 41 §2): a project memory from the message, editable before saving. */
export function RememberThisAction({ serverId, agentId, getContent }: BuiltinMessageActionProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const open = useCallback(
    () => setText(selectedOrWhole(getContent).slice(0, 1_000)),
    [getContent],
  );
  const close = useCallback(() => setText(null), []);
  const showSaved = useCallback(() => toast.show(t("memory.rememberedToast")), [t, toast]);
  const target = useMemo(
    () => ({
      kind: "create" as const,
      scope: "project" as const,
      projectId: null,
      agentId,
      text: text ?? "",
    }),
    [agentId, text],
  );
  return (
    <>
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={t("memory.rememberThis")}
        style={buttonStyle}
        testID="message-remember-this"
      >
        <ThemedIcon size={14} uniProps={mutedColor} />
      </Pressable>
      {text !== null ? (
        <MemoryEditorSheet
          serverId={serverId}
          target={target}
          onClose={close}
          onSaved={showSaved}
        />
      ) : null}
    </>
  );
}

function buttonStyle({ hovered }: { hovered?: boolean }) {
  return [styles.button, hovered ? styles.hovered : null];
}

const ThemedIcon = withUnistyles(BookmarkPlus);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme: Theme) => ({
  button: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  hovered: { backgroundColor: theme.colors.surface2 },
}));
