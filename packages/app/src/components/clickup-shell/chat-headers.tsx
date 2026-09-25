import { memo, useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { User } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import type { Theme } from "@/styles/theme";
import { CLICKUP_AVATAR_SIZE } from "./chat-layout";

const avatarIconMapping = (theme: Theme) => ({ color: theme.chrome.createForeground });
const ThemedUser = withUnistyles(User);

function providerDisplayName(provider: string | undefined): string {
  if (!provider) return "Agent";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** ClickUp chat message header: round avatar, bold name, muted meta, then optional actions. */
function MessageHeader({
  avatarStyle,
  name,
  meta,
  children,
  renderAvatarIcon,
}: {
  avatarStyle: "user" | "agent";
  name: string;
  meta?: string | null;
  children?: ReactNode;
  renderAvatarIcon: () => ReactNode;
}) {
  return (
    <View style={styles.header}>
      <View style={avatarStyle === "user" ? styles.userAvatar : styles.agentAvatar}>
        {renderAvatarIcon()}
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {name}
      </Text>
      {meta ? (
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

function renderUserIcon() {
  return <ThemedUser size={15} strokeWidth={2.2} uniProps={avatarIconMapping} />;
}

/** "You" header over the user's message (violet avatar, as ClickUp's own-user avatar). */
export const ClickUpUserHeader = memo(function ClickUpUserHeader({
  time,
  children,
}: {
  time: string;
  children?: ReactNode;
}) {
  return (
    <MessageHeader avatarStyle="user" name="You" meta={time} renderAvatarIcon={renderUserIcon}>
      {children}
    </MessageHeader>
  );
});

/** Agent header at the start of each agent turn: provider mark avatar, provider name, model. */
export const ClickUpAgentHeader = memo(function ClickUpAgentHeader({
  provider,
  model,
}: {
  provider?: string;
  model?: string | null;
}) {
  const ProviderIcon = useMemo(() => withUnistyles(getProviderIcon(provider ?? "")), [provider]);
  const renderIcon = useCallback(
    () => <ProviderIcon size={15} uniProps={agentIconMapping} />,
    [ProviderIcon],
  );
  return (
    <MessageHeader
      avatarStyle="agent"
      name={providerDisplayName(provider)}
      meta={model}
      renderAvatarIcon={renderIcon}
    />
  );
});

const agentIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const styles = StyleSheet.create((theme: Theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[1],
    minHeight: CLICKUP_AVATAR_SIZE,
  },
  userAvatar: {
    width: CLICKUP_AVATAR_SIZE,
    height: CLICKUP_AVATAR_SIZE,
    borderRadius: CLICKUP_AVATAR_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.chrome.createBackground,
  },
  agentAvatar: {
    width: CLICKUP_AVATAR_SIZE,
    height: CLICKUP_AVATAR_SIZE,
    borderRadius: CLICKUP_AVATAR_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.chrome.outlineBackground,
    borderWidth: 1,
    borderColor: theme.chrome.outlineBorder,
  },
  name: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  meta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
}));
