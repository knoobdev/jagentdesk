import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { ArrowDown, ArrowUp, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  createControlGeometry,
  resolveControlInteractionStyles,
} from "@/components/ui/control-geometry";
import { isWeb } from "@/constants/platform";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { getShortcutOs } from "@/utils/shortcut-platform";

export { isFindShortcut } from "@/terminal/runtime/terminal-find-shortcut";
export interface FindShortcutPlatform {
  isMac: boolean;
}

/** The platform every Find surface judges the shortcut against. */
export function findShortcutPlatform(): FindShortcutPlatform {
  return { isMac: getShortcutOs() === "mac" };
}

const iconColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const FieldTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ArrowUpIcon = withUnistyles(ArrowUp, iconColorMapping);
const ArrowDownIcon = withUnistyles(ArrowDown, iconColorMapping);
const CloseIcon = withUnistyles(X, iconColorMapping);

export interface PaneFindHandle {
  focus(): void;
}

export interface PaneFindProps {
  query: string;
  status: string;
  canNavigate: boolean;
  onQueryChange(query: string): void;
  onNext(): void;
  onPrevious(): void;
  onClose(): void;
  replace?: {
    value: string;
    onChange(value: string): void;
    onReplace(): void;
    onReplaceAll(): void;
  };
}

const GLYPH_SIZE = 16;

/** Pane-local chrome. The content owner supplies search state and commands. */
export const PaneFind = forwardRef<PaneFindHandle, PaneFindProps>(function PaneFind(
  { query, status, canNavigate, onQueryChange, onNext, onPrevious, onClose },
  ref,
) {
  const { t } = useTranslation();
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  const focus = useCallback(() => {
    input.current?.focus();
  }, []);
  useImperativeHandle(ref, () => ({ focus }), [focus]);

  const fieldStyle = useMemo(
    () => [
      styles.field,
      resolveControlInteractionStyles(
        {
          controlRest: styles.controlRest,
          controlHover: styles.controlHover,
          controlActive: styles.controlActive,
        },
        { focused },
      ),
    ],
    [focused],
  );

  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent as TextInputKeyPressEventData & {
        shiftKey?: boolean;
        isComposing?: boolean;
      };
      if (isImeComposingKeyboardEvent(key)) return;
      if (key.key !== "Escape" && key.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (key.key === "Escape") onClose();
      else if (key.shiftKey) onPrevious();
      else onNext();
    },
    [onClose, onNext, onPrevious],
  );

  const onWidgetKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImeComposingKeyboardEvent(event.nativeEvent)) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  return (
    <View
      style={styles.widget}
      accessibilityLabel={t("paneFind.title")}
      {...(isWeb ? { onKeyDown: onWidgetKeyDown } : {})}
    >
      <View style={fieldStyle}>
        <FieldTextInput
          ref={input}
          autoFocus
          selectTextOnFocus
          value={query}
          onChangeText={onQueryChange}
          onKeyPress={onKeyPress}
          onFocus={onFocus}
          onBlur={onBlur}
          accessibilityLabel={t("paneFind.placeholder")}
          placeholder={t("paneFind.placeholder")}
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          returnKeyType="search"
          style={styles.input}
        />
        <Text
          style={styles.status}
          role="status"
          accessibilityLabel={t("paneFind.matches")}
          accessibilityLiveRegion="polite"
        >
          {status}
        </Text>
      </View>
      <Pressable
        accessibilityLabel={t("paneFind.previous")}
        disabled={!canNavigate}
        onPress={onPrevious}
        style={styles.control}
      >
        <ArrowUpIcon size={GLYPH_SIZE} />
      </Pressable>
      <Pressable
        accessibilityLabel={t("paneFind.next")}
        disabled={!canNavigate}
        onPress={onNext}
        style={styles.control}
      >
        <ArrowDownIcon size={GLYPH_SIZE} />
      </Pressable>
      <Pressable accessibilityLabel={t("paneFind.close")} onPress={onClose} style={styles.control}>
        <CloseIcon size={GLYPH_SIZE} />
      </Pressable>
    </View>
  );
});

const FIND_WIDGET_WIDTH = 340;
const CONTROL_SIZE = 28;

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    widget: {
      width: FIND_WIDGET_WIDTH,
      maxWidth: "100%",
      flexDirection: "row",
      alignItems: "center",
      padding: theme.spacing[1.5],
      gap: theme.spacing[1],
      backgroundColor: theme.colors.surface1,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.lg,
      ...theme.shadow.md,
    },
    field: {
      flex: 1,
      minWidth: 0,
      minHeight: CONTROL_SIZE,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[2],
      backgroundColor: theme.colors.surface2,
      borderRadius: theme.borderRadius.md,
    },
    controlRest: { ...geometry.controlRest },
    controlHover: { ...geometry.controlHover },
    controlActive: { ...geometry.controlActive },
    input: {
      flex: 1,
      minWidth: 0,
      paddingHorizontal: 0,
      paddingVertical: 0,
      color: theme.colors.foreground,
      outlineWidth: 0,
      outlineColor: "transparent",
      ...geometry.fieldTextSm,
    },
    status: {
      flexShrink: 0,
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    control: {
      width: CONTROL_SIZE,
      height: CONTROL_SIZE,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.borderRadius.md,
    },
  };
});
