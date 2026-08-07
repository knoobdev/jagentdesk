import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

export function FilePanelBar({
  size,
  lineCount,
}: {
  size: number;
  lineCount?: number;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.chrome} testID="file-panel-bar">
      <View style={styles.row}>
        <View style={styles.metadata}>
          <Text
            style={styles.whisper}
            accessibilityLabel={t("panels.file.editor.fileSize", { size: formatFileSize(size) })}
          >
            {formatFileSize(size)}
          </Text>
          {lineCount !== undefined ? (
            <Text
              style={styles.whisper}
              accessibilityLabel={t("panels.file.editor.lines", { count: lineCount })}
            >
              {t("panels.file.editor.lines", { count: lineCount })}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create((theme) => ({
  chrome: {
    flexShrink: 0,
    backgroundColor: theme.colors.surface1,
  },
  row: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  metadata: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  whisper: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.xs },
}));
