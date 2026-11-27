// Schedules filtered by a bot (spec 37.4.4: the bot panel's "All {{count}} automations" opens
// Schedules filtered by the bot). A pill like the host filter: "All schedules" or the bot's
// automations, with every bot that owns a schedule to pick from.
import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Bot as BotIcon, ChevronDown, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ScheduleBotGlyph,
  scheduleBotName,
  useScheduleBot,
} from "@/components/schedules/schedule-bot";

const ThemedBot = withUnistyles(BotIcon);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedX = withUnistyles(X);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface ScheduleBotFilterValue {
  serverId: string;
  botId: string;
}

function sameBot(a: ScheduleBotFilterValue | null, b: ScheduleBotFilterValue): boolean {
  return a?.serverId === b.serverId && a.botId === b.botId;
}

function BotOption({
  option,
  selected,
  onSelect,
}: {
  option: ScheduleBotFilterValue;
  selected: boolean;
  onSelect: (value: ScheduleBotFilterValue) => void;
}): ReactElement {
  const bot = useScheduleBot(option.serverId, option.botId);
  const select = useCallback(() => onSelect(option), [onSelect, option]);
  const leading = useMemo(
    () => <ScheduleBotGlyph serverId={option.serverId} bot={bot} size={16} />,
    [bot, option.serverId],
  );
  return (
    <DropdownMenuItem
      leading={leading}
      selected={selected}
      showSelectedCheck
      onSelect={select}
      testID={`schedules-bot-filter-${option.botId}`}
    >
      {scheduleBotName(bot)}
    </DropdownMenuItem>
  );
}

export function ScheduleBotFilter({
  bots,
  value,
  onChange,
}: {
  /** Every bot that owns a loaded schedule, and the one filtered by. */
  bots: readonly ScheduleBotFilterValue[];
  value: ScheduleBotFilterValue | null;
  onChange: (value: ScheduleBotFilterValue | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const bot = useScheduleBot(value?.serverId ?? "", value?.botId);
  const name = scheduleBotName(bot);
  const label = value
    ? t("bots.jad.schedulesScreen.filteredBy", { name })
    : t("bots.jad.schedulesScreen.allSchedules");
  const clear = useCallback(() => onChange(null), [onChange]);
  const triggerStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      pressed && styles.triggerPressed,
    ],
    [],
  );
  return (
    <View style={styles.wrap}>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`${t("bots.jad.schedulesScreen.filterLabel")}: ${label}`}
          testID="schedules-bot-filter-trigger"
        >
          {value ? (
            <ScheduleBotGlyph serverId={value.serverId} bot={bot} size={16} />
          ) : (
            <ThemedBot size={14} uniProps={muted} />
          )}
          <Text style={styles.triggerText} numberOfLines={1}>
            {label}
          </Text>
          <ThemedChevronDown size={14} uniProps={muted} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width={240}>
          <DropdownMenuItem
            selected={value === null}
            showSelectedCheck
            onSelect={clear}
            testID="schedules-bot-filter-all"
          >
            {t("bots.jad.schedulesScreen.allSchedules")}
          </DropdownMenuItem>
          {bots.length > 0 ? <DropdownMenuSeparator /> : null}
          {bots.map((option) => (
            <BotOption
              key={`${option.serverId}:${option.botId}`}
              option={option}
              selected={sameBot(value, option)}
              onSelect={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {value ? (
        <Pressable
          onPress={clear}
          hitSlop={8}
          style={styles.clear}
          accessibilityRole="button"
          accessibilityLabel={t("bots.jad.schedulesScreen.removeFilter", { name })}
          testID="schedules-bot-filter-clear"
        >
          <ThemedX size={14} uniProps={muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    alignSelf: "flex-start",
    flexShrink: 1,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface3,
  },
  triggerText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  clear: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
}));
