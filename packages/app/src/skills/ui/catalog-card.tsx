import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SkillCatalogItem } from "@jagentdesk/protocol/native-skills";
import { Button } from "@/components/ui/button";
import { shortRevision } from "@/skills/native-skill-logic";
import { SkillBadge } from "@/skills/ui/skill-chrome";
import type { Theme } from "@/styles/theme";

interface CatalogCardProps {
  item: SkillCatalogItem;
  onOpen: (item: SkillCatalogItem) => void;
}

function CatalogCardBadges({ item }: { item: SkillCatalogItem }) {
  const { t } = useTranslation();
  const revision = shortRevision(item.revision);
  return (
    <View style={styles.badges}>
      {item.kind === "plugin" ? <SkillBadge label={t("skillsHub.badges.plugin")} /> : null}
      {item.hasScripts ? <SkillBadge label={t("skillsHub.badges.scripts")} tone="warning" /> : null}
      {item.invalidReason ? (
        <SkillBadge label={t("skillsHub.badges.invalid")} tone="danger" />
      ) : null}
      {item.category ? <SkillBadge label={item.category} /> : null}
      {revision ? <SkillBadge label={revision} /> : null}
    </View>
  );
}

/** A browsed skill or provider plugin, in the Marketplace card layout (spec 22.6). */
export function CatalogCard({ item, onOpen }: CatalogCardProps) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => onOpen(item), [item, onOpen]);
  const unavailable = Boolean(item.invalidReason);
  let installLabel = t("skillsHub.card.install");
  if (item.installed) installLabel = t("skillsHub.card.installed");
  else if (unavailable) installLabel = t("skillsHub.card.unavailable");
  return (
    <Pressable
      style={styles.card}
      onPress={handleOpen}
      testID={`skill-catalog-card-${item.itemId}`}
    >
      <View style={styles.head}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name}
        </Text>
      </View>
      <Text style={styles.origin} numberOfLines={1}>
        {t("skillsHub.card.from", { origin: item.origin })}
      </Text>
      <Text style={styles.description} numberOfLines={2}>
        {item.description || t("marketplace.card.noDescription")}
      </Text>
      <CatalogCardBadges item={item} />
      <View style={styles.footer}>
        <Button
          variant={item.installed ? "outline" : "default"}
          size="sm"
          onPress={handleOpen}
          disabled={item.installed || unavailable}
          leftIcon={item.installed ? Check : undefined}
          testID={`skill-catalog-install-${item.itemId}`}
        >
          {installLabel}
        </Button>
        <Button variant="outline" size="sm" onPress={handleOpen}>
          {t("skillsHub.card.details")}
        </Button>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  head: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  name: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  origin: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  description: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
    minHeight: 36,
  },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  footer: { flexDirection: "row", gap: theme.spacing[2], marginTop: theme.spacing[1] },
}));
