// An item's links as chips under its title: a worker (its state glyph; opens the worker), "PR #N"
// (opens the PR), a web link, a home file (opens in the centre beside Home Chat), an automation.
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/items/BotItemLinkChips.tsx:1-401
// and BotItemLinks.tsx (the rows' names). Live PR state and checks (Orca `use-bot-item-live-pr.ts`)
// need a PR read the bots contract doesn't have yet; the chip names the PR only.
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Bot, BotItemLink } from "@jagentdesk/protocol/bots/types";
import { useBotPanelStore } from "@/bots/panel-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openExternalUrl } from "@/utils/open-external-url";
import type { Theme } from "@/styles/theme";
import { botItemPrNumber, isBotItemWorkerFailed } from "./item-rules";

function hostOf(url: string): string {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return match?.[1] ?? url;
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/** Settled workers go last, so the ones still moving and the PRs keep their place first. */
function chipOrder(links: readonly BotItemLink[]): BotItemLink[] {
  const settled = (link: BotItemLink) =>
    link.kind === "dispatch" && link.state !== "working" && link.state !== "unknown";
  const moving = links.filter((link) => !settled(link));
  return moving.concat(links.filter(settled));
}

export function BotItemLinkChips({
  serverId,
  bot,
  links,
}: {
  serverId: string;
  bot: Bot;
  links: readonly BotItemLink[] | undefined;
}) {
  const { t } = useTranslation();
  if (!links || links.length === 0) return null;
  return (
    <View
      style={styles.chips}
      accessibilityLabel={t("bots.items.view.links")}
      testID="bot-item-links"
    >
      {chipOrder(links).map((link) => (
        <LinkChip key={`${link.kind}:${link.ref}`} serverId={serverId} botId={bot.id} link={link} />
      ))}
    </View>
  );
}

function workerDot(
  link: Extract<BotItemLink, { kind: "dispatch" }>,
): "running" | "failed" | "done" {
  if (link.state === "working" || link.state === "unknown") return "running";
  return isBotItemWorkerFailed(link) ? "failed" : "done";
}

function chipLabel(
  link: BotItemLink,
  t: (key: string, values?: Record<string, unknown>) => string,
) {
  switch (link.kind) {
    case "dispatch":
      return link.title ?? link.ref;
    case "pr": {
      const number = botItemPrNumber(link.ref);
      return number === null ? link.ref : t("bots.items.link.pr", { number });
    }
    case "url":
      return hostOf(link.ref);
    case "file":
      return baseName(link.ref);
    case "automation":
      return link.name ?? t("bots.items.link.automation");
  }
}

function LinkChip({
  serverId,
  botId,
  link,
}: {
  serverId: string;
  botId: string;
  link: BotItemLink;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => {
    switch (link.kind) {
      case "dispatch":
        navigateToAgent({ serverId, agentId: link.ref });
        return;
      case "pr":
        if (link.url) void openExternalUrl(link.url);
        return;
      case "url":
        void openExternalUrl(link.ref);
        return;
      case "file":
        useBotPanelStore.getState().setOpenFile(botId, link.ref);
        return;
      case "automation":
        return;
    }
  }, [link, serverId, botId]);
  const opens = link.kind !== "automation" && (link.kind !== "pr" || Boolean(link.url));
  let suffix: string | undefined;
  if (link.kind === "automation")
    suffix = link.active ? t("bots.items.link.automationOn") : t("bots.items.link.automationEnded");
  return (
    <Chip
      label={chipLabel(link, t)}
      suffix={suffix}
      dot={link.kind === "dispatch" ? workerDot(link) : undefined}
      onPress={opens ? press : undefined}
      testID={`bot-item-link-${link.kind}`}
    />
  );
}

function Chip({
  label,
  suffix,
  dot,
  onPress,
  testID,
}: {
  label: string;
  suffix?: string;
  dot?: "running" | "failed" | "done";
  onPress?: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={styles.chip}
      accessibilityRole={onPress ? "link" : undefined}
      accessibilityLabel={suffix ? `${label} · ${suffix}` : label}
      testID={testID}
    >
      {dot ? (
        <View
          style={[
            styles.dot,
            dot === "running" && styles.dotRunning,
            dot === "failed" && styles.dotFailed,
            dot === "done" && styles.dotDone,
          ]}
        />
      ) : null}
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {suffix ? (
        <Text style={styles.suffix} numberOfLines={1}>
          {suffix}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  chip: {
    height: 24,
    maxWidth: 240,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotRunning: { backgroundColor: theme.colors.palette.amber[500] },
  dotFailed: { backgroundColor: theme.colors.palette.red[500] },
  dotDone: { backgroundColor: theme.colors.palette.green[500] },
  label: { flexShrink: 1, fontSize: 12, color: theme.colors.foreground },
  suffix: { fontSize: 11, color: theme.colors.foregroundMuted },
}));
