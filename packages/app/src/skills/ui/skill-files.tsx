import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { SectionTitle, SkillBadge } from "@/skills/ui/skill-chrome";
import type { Theme } from "@/styles/theme";

export interface SkillFileView {
  path: string;
  isScript: boolean;
  size?: number;
}

const MAX_LISTED_FILES = 200;

function formatSize(size: number | undefined): string | null {
  if (size === undefined) return null;
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
}

function FileLine({ file }: { file: SkillFileView }) {
  const { t } = useTranslation();
  const size = formatSize(file.size);
  return (
    <View style={styles.fileRow} testID={file.isScript ? "skill-file-script" : "skill-file"}>
      <Text style={file.isScript ? styles.scriptPath : styles.path} numberOfLines={1} selectable>
        {file.path}
      </Text>
      {file.isScript ? <SkillBadge label={t("skillsHub.badges.script")} tone="warning" /> : null}
      {size ? <Text style={styles.size}>{size}</Text> : null}
    </View>
  );
}

/** File list with `scripts/` highlighted first (spec 22.8: shown before install). */
export function SkillFileList({ files }: { files: SkillFileView[] }) {
  const { t } = useTranslation();
  const ordered = useMemo(
    () =>
      [...files].sort(
        (a, b) => Number(b.isScript) - Number(a.isScript) || a.path.localeCompare(b.path),
      ),
    [files],
  );
  const hasScripts = ordered.some((file) => file.isScript);
  const listed = ordered.slice(0, MAX_LISTED_FILES);
  const hidden = ordered.length - listed.length;
  return (
    <View style={styles.section}>
      <SectionTitle title={t("skillsHub.item.files")} />
      {hasScripts ? <Text style={styles.scriptHint}>{t("skillsHub.item.scriptsHint")}</Text> : null}
      {listed.length === 0 ? <Text style={styles.muted}>{t("skillsHub.item.noFiles")}</Text> : null}
      {listed.map((file) => (
        <FileLine key={file.path} file={file} />
      ))}
      {hidden > 0 ? (
        <Text style={styles.muted}>{t("skillsHub.item.moreFiles", { count: hidden })}</Text>
      ) : null}
    </View>
  );
}

/** Spec 22.8 trust warning — the sentence is fixed by the spec. */
export function SkillTrustWarning() {
  const { t } = useTranslation();
  return (
    <Alert
      variant="warning"
      title={t("skillsHub.item.trustTitle")}
      description={t("skillsHub.item.trust")}
      testID="skills-trust-warning"
    />
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  section: { gap: theme.spacing[1.5] },
  fileRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  path: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  scriptPath: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.statusWarning,
  },
  size: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  scriptHint: { fontSize: theme.fontSize.xs, color: theme.colors.statusWarning },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
