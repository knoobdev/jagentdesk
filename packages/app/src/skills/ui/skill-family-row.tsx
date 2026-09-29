import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SkillEntry } from "@jagentdesk/protocol/native-skills";
import { Switch } from "@/components/ui/switch";
import type { SkillFamily } from "@/skills/skill-families";
import { SkillBadge } from "@/skills/ui/skill-chrome";
import {
  ProviderBadges,
  SkillRow,
  SkillRowBadges,
  SkillRowMenu,
  type SkillRowHandlers,
} from "@/skills/ui/skill-row";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SkillCopyRowProps {
  entry: SkillEntry;
  primary: boolean;
  busy: boolean;
  handlers: SkillRowHandlers;
}

/** One copy of a family: its directory, real path, visible-to, owned, switch, menu. */
function SkillCopyRow({ entry, primary, busy, handlers }: SkillCopyRowProps) {
  const { t } = useTranslation();
  const { onOpen, onToggleEnabled } = handlers;
  const handleOpen = useCallback(() => onOpen(entry), [entry, onOpen]);
  const handleToggle = useCallback(
    (value: boolean) => onToggleEnabled(entry, value),
    [entry, onToggleEnabled],
  );
  return (
    <View style={styles.copy} testID={`skill-copy-${entry.skillId}`}>
      <Pressable style={styles.main} onPress={handleOpen} accessibilityRole="button">
        <View style={styles.head}>
          <Text style={styles.copyDir}>{entry.dir ?? t("skillsHub.family.unknownDir")}</Text>
          {primary ? <SkillBadge label={t("skillsHub.family.primary")} /> : null}
          <SkillRowBadges entry={entry} />
        </View>
        <Text style={styles.path} numberOfLines={2} selectable>
          {entry.realPath}
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
          accessibilityLabel={t("skillsHub.family.enableCopy", {
            name: entry.name,
            dir: entry.dir ?? "",
          })}
          testID={`skill-enabled-${entry.skillId}`}
        />
        <SkillRowMenu entry={entry} handlers={handlers} />
      </View>
    </View>
  );
}

export interface SkillFamilyRowProps {
  family: SkillFamily;
  busyIds: ReadonlySet<string>;
  handlers: SkillRowHandlers;
}

/**
 * One row per skill name within a scope (spec 22.6.1). A single copy renders as
 * a plain skill row; several copies show a copy-count badge, "Copies differ"
 * when their content hashes differ, the union of providers, and expand to the
 * copies with their own switch and menu.
 */
export function SkillFamilyRow({ family, busyIds, handlers }: SkillFamilyRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { primary } = family;
  const handleOpen = useCallback(() => handlers.onOpen(primary), [handlers, primary]);
  const handleExpand = useCallback(() => setExpanded((prev) => !prev), []);
  const expandState = useMemo(() => ({ expanded }), [expanded]);
  if (family.copies.length === 1) {
    return <SkillRow entry={primary} busy={busyIds.has(primary.skillId)} handlers={handlers} />;
  }
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  return (
    <View style={styles.family} testID={`skill-family-${family.key}`}>
      <View style={styles.familyHead}>
        <Pressable style={styles.main} onPress={handleOpen} accessibilityRole="button">
          <View style={styles.head}>
            <Text style={styles.name} numberOfLines={1}>
              {family.name}
            </Text>
            <SkillBadge label={t(`skillsHub.scope.${family.scope}`)} />
            <SkillBadge
              label={t("skillsHub.family.copies", { count: family.copies.length })}
              tone="accent"
            />
            {family.contentDiffers ? (
              <SkillBadge label={t("skillsHub.family.differ")} tone="warning" />
            ) : null}
          </View>
          <Text style={styles.description} numberOfLines={2}>
            {primary.description || t("marketplace.card.noDescription")}
          </Text>
          <ProviderBadges providers={family.visibleTo} />
        </Pressable>
        <Pressable
          onPress={handleExpand}
          style={styles.expand}
          accessibilityRole="button"
          accessibilityState={expandState}
          accessibilityLabel={t(
            expanded ? "skillsHub.family.hideCopies" : "skillsHub.family.showCopies",
            {
              count: family.copies.length,
            },
          )}
          testID={`skill-family-expand-${family.key}`}
        >
          <Chevron size={16} uniProps={mutedColor} />
        </Pressable>
      </View>
      {expanded ? (
        <View style={styles.copies}>
          {family.copies.map((copy) => (
            <SkillCopyRow
              key={copy.skillId}
              entry={copy}
              primary={copy.skillId === primary.skillId}
              busy={busyIds.has(copy.skillId)}
              handlers={handlers}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  family: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  familyHead: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  main: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  name: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  description: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted, lineHeight: 18 },
  expand: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  copies: { gap: theme.spacing[2] },
  copy: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
  },
  copyDir: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  path: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  invalid: { fontSize: theme.fontSize.xs, color: theme.colors.statusDanger },
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
}));
