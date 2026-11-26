import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * An agent whose turn has ended but whose background work still runs keeps the "running" dot;
 * the tooltip says why (spec 38 §4.4b). Other dots pass through untouched.
 */
export function BackgroundWorkStatusTooltip({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): ReactNode {
  const { t } = useTranslation();
  if (!active) return children;
  return (
    <Tooltip delayDuration={300} enabledOnDesktop>
      <TooltipTrigger asChild>
        <View testID="background-work-status-dot">{children}</View>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" offset={8}>
        <Text style={styles.text}>{t("message.backgroundWork.running")}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: { fontSize: theme.fontSize.xs, color: theme.colors.foreground },
}));
