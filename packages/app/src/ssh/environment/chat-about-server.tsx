import { useMutation } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react-native";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import {
  startServerChat,
  type StartServerChatInput,
  type StartedServerChat,
} from "./start-server-chat";

export type StartServerChatState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "failed"; message: string };

export interface ServerChatStarter {
  state: StartServerChatState;
  start: (input: StartServerChatInput) => void;
  dismissError: () => void;
}

/** Creates the server chat agent and hands it to `onStarted` (open the dock or the Chat tab). */
export function useStartServerChat(
  onStarted: (chat: StartedServerChat) => void,
): ServerChatStarter {
  const mutation = useMutation({ mutationFn: startServerChat, onSuccess: onStarted });
  const { mutate, reset } = mutation;
  const start = useCallback((input: StartServerChatInput) => mutate(input), [mutate]);
  if (mutation.isPending) return { state: { kind: "starting" }, start, dismissError: reset };
  if (mutation.error) {
    return {
      state: { kind: "failed", message: mutation.error.message },
      start,
      dismissError: reset,
    };
  }
  return { state: { kind: "idle" }, start, dismissError: reset };
}

export interface ChatAboutServerButtonProps {
  state: StartServerChatState;
  onPress: () => void;
  onDismissError: () => void;
}

/**
 * Entry point to the server's chat agent from the server screen header (desktop: opens the chat
 * pane on the right; mobile: switches to the Chat tab). Full-width on compact layouts.
 */
export function ChatAboutServerButton({
  state,
  onPress,
  onDismissError,
}: ChatAboutServerButtonProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const isStarting = state.kind === "starting";
  return (
    <View style={isCompact ? styles.compact : styles.inline}>
      <Button
        variant="default"
        size={isCompact ? "md" : "sm"}
        leftIcon={MessageSquare}
        loading={isStarting}
        disabled={isStarting}
        onPress={onPress}
        testID="ssh-environment-chat"
      >
        {isStarting ? t("ssh.environment.chatStarting") : t("ssh.environment.chat")}
      </Button>
      {state.kind === "failed" ? (
        <Alert variant="error" title={t("ssh.environment.chatFailed")} description={state.message}>
          <Button variant="ghost" size="sm" onPress={onDismissError}>
            {t("common.actions.dismiss")}
          </Button>
        </Alert>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  inline: { alignItems: "flex-end", gap: theme.spacing[2] },
  compact: { alignSelf: "stretch", gap: theme.spacing[2] },
}));
