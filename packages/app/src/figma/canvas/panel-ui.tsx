import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { jiraStyles } from "@/jira/ui/styles";

// Shared building blocks for the canvas-side panels (inspect, toolbar popovers). Labels run the
// section rail; values render in mono so numbers align the way Figma's own inspect does.

const styles = StyleSheet.create({
  section: { gap: 8 },
  row: { width: 72 },
  value: { flex: 1, minWidth: 0, alignItems: "flex-end" },
});

export function PanelSection({
  title,
  children,
  right,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={jiraStyles.row}>
        <Text style={jiraStyles.sectionLabel}>{title}</Text>
        <View style={jiraStyles.spacer} />
        {right}
      </View>
      <View style={styles.section}>{children}</View>
    </View>
  );
}

export function PanelRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={jiraStyles.row}>
      <Text style={[jiraStyles.textMuted, styles.row]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.value}>{children}</View>
    </View>
  );
}

export function MonoText({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <Text style={muted ? jiraStyles.textSmall : jiraStyles.mono} numberOfLines={2}>
      {children}
    </Text>
  );
}
