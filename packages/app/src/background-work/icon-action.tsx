import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Text } from "react-native";
import { Check, Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-api-context";
import { ICON_SIZE } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check, mutedIconColorMapping);
const ThemedCopy = withUnistyles(Copy, mutedIconColorMapping);

const COPIED_RESET_MS = 1500;

/**
 * An icon action in the background task detail (spec 04 §27c): 28 × 28, radius 6, a tooltip and
 * an accessible name. The fill is `surface2`, not the toolbar's `interactionHighlight`: the detail
 * sits on a `surface1` popover, and in Gumloop Dark that highlight is `surface1` itself.
 */
export function DetailIconAction({
  children,
  label,
  onPress,
  testID,
}: {
  /** The glyph, 14 px muted. */
  children: ReactNode;
  label: string;
  onPress: () => void;
  testID?: string;
}): ReactElement {
  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={frameStyle}
        testID={testID}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function frameStyle({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) {
  return [styles.frame, (hovered || pressed) && styles.frameActive];
}

/** Copy as an icon that turns into a check for a moment once the clipboard has it. */
export function DetailCopyAction({
  label,
  onCopy,
  testID,
}: {
  label: string;
  /** Resolves false, or rejects, when nothing was written. */
  onCopy: () => Promise<boolean>;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );
  const copy = useCallback(async () => {
    const written = await onCopy().catch(() => false);
    if (!written) {
      toast.error(t("common.errors.unableToCopy"));
      return;
    }
    setCopied(true);
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [onCopy, t, toast]);
  const press = useCallback(() => void copy(), [copy]);
  const Glyph = copied ? ThemedCheck : ThemedCopy;
  return (
    <DetailIconAction
      label={copied ? t("message.backgroundWork.detail.copied") : label}
      onPress={press}
      testID={testID}
    >
      <Glyph size={ICON_SIZE.sm} />
    </DetailIconAction>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  frameActive: { backgroundColor: theme.colors.surface2 },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
