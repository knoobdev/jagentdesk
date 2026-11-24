import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/markdown/renderer";

export function PlanCard({
  title,
  description,
  text,
  footer,
  disableOuterSpacing = false,
  testID,
}: {
  title?: string;
  description?: string;
  text: string;
  footer?: ReactNode;
  disableOuterSpacing?: boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("agentStream.permission.plan");

  const containerStyle = useMemo(
    () => [styles.container, disableOuterSpacing && styles.containerCompact],
    [disableOuterSpacing],
  );
  return (
    <View testID={testID} style={containerStyle}>
      <Text style={styles.title}>{resolvedTitle}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      <MarkdownRenderer text={text} />
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
  },
  containerCompact: {
    marginVertical: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  footer: {
    gap: theme.spacing[2],
  },
}));
