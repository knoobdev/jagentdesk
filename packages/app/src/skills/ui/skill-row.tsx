import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { MoreVertical } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SkillEntry } from "@jagentdesk/protocol/native-skills";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { skillProviderLabel } from "@/skills/native-skill-logic";
import { SkillBadge } from "@/skills/ui/skill-chrome";
import type { Theme } from "@/styles/theme";

const ThemedMoreVertical = withUnistyles(MoreVertical);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface SkillRowHandlers {
  onOpen: (entry: SkillEntry) => void;
  onToggleEnabled: (entry: SkillEntry, enabled: boolean) => void;
  onCopyPath: (entry: SkillEntry) => void;
  onTrain: (entry: SkillEntry) => void;
  onFork: (entry: SkillEntry) => void;
  onUninstall: (entry: SkillEntry) => void;
}

interface SkillRowProps {
  entry: SkillEntry;
  busy: boolean;
  handlers: SkillRowHandlers;
}

function SkillRowBadges({ entry }: { entry: SkillEntry }) {
  const { t } = useTranslation();
  return (
    <View style={styles.badges}>
      <SkillBadge label={t(`skillsHub.scope.${entry.scope}`)} />
      {entry.owned ? <SkillBadge label={t("skillsHub.badges.owned")} tone="accent" /> : null}
      {entry.status === "invalid" ? (
        <SkillBadge label={t("skillsHub.badges.invalid")} tone="danger" />
      ) : null}
      {entry.enabled ? null : <SkillBadge label={t("skillsHub.badges.disabled")} tone="warning" />}
      {entry.hasScripts ? <SkillBadge label={t("skillsHub.badges.scripts")} /> : null}
    </View>
  );
}

function SkillRowMenu({ entry, handlers }: { entry: SkillEntry; handlers: SkillRowHandlers }) {
  const { t } = useTranslation();
  const handleCopy = useCallback(() => handlers.onCopyPath(entry), [entry, handlers]);
  const handleTrain = useCallback(() => handlers.onTrain(entry), [entry, handlers]);
  const handleFork = useCallback(() => handlers.onFork(entry), [entry, handlers]);
  const handleUninstall = useCallback(() => handlers.onUninstall(entry), [entry, handlers]);
  const handleOpen = useCallback(() => handlers.onOpen(entry), [entry, handlers]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        accessibilityLabel={t("skillsHub.row.menu", { name: entry.name })}
        testID={`skill-row-menu-${entry.skillId}`}
        style={styles.kebab}
      >
        <ThemedMoreVertical size={16} uniProps={mutedColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" minWidth={180}>
        <DropdownMenuItem onSelect={handleOpen} testID={`skill-action-details-${entry.skillId}`}>
          {t("skillsHub.row.details")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleCopy} testID={`skill-action-path-${entry.skillId}`}>
          {t("skillsHub.row.openPath")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleTrain} testID={`skill-action-train-${entry.skillId}`}>
          {t("skillsHub.row.train")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleFork} testID={`skill-action-fork-${entry.skillId}`}>
          {t("skillsHub.row.fork")}
        </DropdownMenuItem>
        <DropdownMenuItem
          destructive
          onSelect={handleUninstall}
          testID={`skill-action-uninstall-${entry.skillId}`}
        >
          {t("skillsHub.row.uninstall")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const MAX_PROVIDER_BADGES = 5;

/** Spec 22.6 "badge provider thấy được": one badge per provider that reads this skill. */
function ProviderBadges({ providers }: { providers: string[] }) {
  const { t } = useTranslation();
  const labels = useMemo(() => providers.map(skillProviderLabel), [providers]);
  if (labels.length === 0) {
    return <Text style={styles.meta}>{t("skillsHub.row.notVisible")}</Text>;
  }
  const shown = labels.slice(0, MAX_PROVIDER_BADGES);
  const hidden = labels.length - shown.length;
  return (
    <View
      style={styles.badges}
      accessibilityLabel={t("skillsHub.row.visibleTo", { providers: labels.join(", ") })}
    >
      {shown.map((label) => (
        <SkillBadge key={label} label={label} />
      ))}
      {hidden > 0 ? <SkillBadge label={`+${hidden}`} /> : null}
    </View>
  );
}

/** One installed skill (spec 22.6): name, description, badges, visible-to, switch, menu. */
export function SkillRow({ entry, busy, handlers }: SkillRowProps) {
  const { t } = useTranslation();
  const { onOpen, onToggleEnabled } = handlers;
  const handleOpen = useCallback(() => onOpen(entry), [entry, onOpen]);
  const handleToggle = useCallback(
    (value: boolean) => onToggleEnabled(entry, value),
    [entry, onToggleEnabled],
  );
  return (
    <View style={styles.row} testID={`skill-row-${entry.skillId}`}>
      <Pressable style={styles.main} onPress={handleOpen} accessibilityRole="button">
        <View style={styles.head}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.name}
          </Text>
          <SkillRowBadges entry={entry} />
        </View>
        <Text style={styles.description} numberOfLines={2}>
          {entry.description || t("marketplace.card.noDescription")}
        </Text>
        <ProviderBadges providers={entry.visibleTo} />
        {entry.invalidReason ? (
          <Text style={styles.invalid} numberOfLines={2}>
            {entry.invalidReason}
          </Text>
        ) : null}
      </Pressable>
      <View style={styles.controls}>
        <Switch
          value={entry.enabled}
          onValueChange={handleToggle}
          disabled={busy}
          accessibilityLabel={t("skillsHub.row.enable", { name: entry.name })}
          testID={`skill-enabled-${entry.skillId}`}
        />
        <SkillRowMenu entry={entry} handlers={handlers} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
  },
  main: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  name: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
  description: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted, lineHeight: 18 },
  meta: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  invalid: { fontSize: theme.fontSize.xs, color: theme.colors.statusDanger },
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  kebab: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
}));
