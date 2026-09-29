import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type TextInputProps,
} from "react-native";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  createControlGeometry,
  resolveControlInteractionStyles,
} from "@/components/ui/control-geometry";
import { isWeb } from "@/constants/platform";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { getShortcutOs } from "@/utils/shortcut-platform";

import { isFindShortcut, type FindShortcutPlatform } from "./find-shortcut";

export { isFindShortcut, type FindShortcutPlatform } from "./find-shortcut";

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
const ChevronDownIcon = withUnistyles(ChevronDown, iconColorMapping);
const ChevronRightIcon = withUnistyles(ChevronRight, iconColorMapping);

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

/**
 * The bordered box around one Find input. It owns the field chrome so the query
 * row and the replacement row land on the same rails, and so the match count can
 * sit inside the query box instead of widening the widget.
 */
const FindField = forwardRef<
  TextInput,
  {
    label: string;
    value: string;
    trailing?: ReactNode;
    onChangeText(value: string): void;
    onKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>): void;
    autoFocus?: boolean;
    returnKeyType?: TextInputProps["returnKeyType"];
  }
>(function FindField(
  { label, value, trailing, onChangeText, onKeyPress, autoFocus, returnKeyType },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
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
  return (
    <View style={fieldStyle}>
      <FieldTextInput
        ref={ref}
        autoFocus={autoFocus}
        selectTextOnFocus
        value={value}
        onChangeText={onChangeText}
        onKeyPress={onKeyPress}
        onFocus={onFocus}
        onBlur={onBlur}
        accessibilityLabel={label}
        placeholder={label}
        autoCapitalize="none"
        autoCorrect={false}
        blurOnSubmit={false}
        returnKeyType={returnKeyType}
        style={styles.input}
      />
      {trailing}
    </View>
  );
});

/** Pane-local chrome. The content owner supplies search state and commands. */
export const PaneFind = forwardRef<PaneFindHandle, PaneFindProps>(function PaneFind(
  { query, status, canNavigate, onQueryChange, onNext, onPrevious, onClose, replace },
  ref,
) {
  const { t } = useTranslation();
  const input = useRef<TextInput>(null);
  const [replaceExpanded, setReplaceExpanded] = useState(false);
  const focus = useCallback(() => {
    input.current?.focus();
  }, []);
  useImperativeHandle(ref, () => ({ focus }), [focus]);

  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent as TextInputKeyPressEventData & {
        shiftKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
        altKey?: boolean;
        isComposing?: boolean;
      };
      if (isImeComposingKeyboardEvent(key)) return;
      const shortcut = {
        key: key.key,
        metaKey: key.metaKey === true,
        ctrlKey: key.ctrlKey === true,
        shiftKey: key.shiftKey === true,
        altKey: key.altKey === true,
      };
      if (isFindShortcut(shortcut, findShortcutPlatform())) {
        // RN Web inputs stop keydown before the pane's document listener.
        event.preventDefault();
        event.stopPropagation();
        focus();
        return;
      }
      if (key.key !== "Escape" && key.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (key.key === "Escape") onClose();
      else if (key.shiftKey) onPrevious();
      else onNext();
    },
    [focus, onClose, onNext, onPrevious],
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
  const toggleReplace = useCallback(() => setReplaceExpanded((expanded) => !expanded), []);
  const toggleState = useMemo(() => ({ expanded: replaceExpanded }), [replaceExpanded]);
  const matchCount = useMemo(
    () => (
      <Text
        style={styles.status}
        role="status"
        accessibilityLabel={t("paneFind.matches")}
        accessibilityLiveRegion="polite"
      >
        {status}
      </Text>
    ),
    [status, t],
  );

  return (
    <View
      style={styles.widget}
      accessibilityLabel={t("paneFind.title")}
      {...(isWeb ? { onKeyDown: onWidgetKeyDown } : {})}
    >
      {replace ? (
        <View style={styles.gutter}>
          <Pressable
            accessibilityLabel={t("paneFind.toggleReplace")}
            accessibilityState={toggleState}
            onPress={toggleReplace}
            style={styles.control}
          >
            {replaceExpanded ? (
              <ChevronDownIcon size={GLYPH_SIZE} />
            ) : (
              <ChevronRightIcon size={GLYPH_SIZE} />
            )}
          </Pressable>
        </View>
      ) : null}
      <View style={styles.rows}>
        <View style={styles.row}>
          <FindField
            ref={input}
            autoFocus
            label={t("paneFind.placeholder")}
            value={query}
            returnKeyType="search"
            trailing={matchCount}
            onChangeText={onQueryChange}
            onKeyPress={onKeyPress}
          />
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
          <Pressable
            accessibilityLabel={t("paneFind.close")}
            onPress={onClose}
            style={styles.control}
          >
            <CloseIcon size={GLYPH_SIZE} />
          </Pressable>
        </View>
        {replace && replaceExpanded ? (
          <View style={styles.row}>
            <FindField
              label={t("paneFind.replaceWith")}
              value={replace.value}
              onChangeText={replace.onChange}
              onKeyPress={onKeyPress}
            />
            <Button
              variant="ghost"
              size="xs"
              style={styles.replaceAction}
              disabled={!canNavigate}
              onPress={replace.onReplace}
            >
              {t("paneFind.replace")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              style={styles.replaceAction}
              disabled={!canNavigate}
              onPress={replace.onReplaceAll}
            >
              {t("paneFind.replaceAll")}
            </Button>
          </View>
        ) : null}
      </View>
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
      padding: theme.spacing[1.5],
      gap: theme.spacing[1],
      backgroundColor: theme.colors.surface1,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.lg,
      ...theme.shadow.md,
    },
    // The disclosure column spans both rows so the two fields share a leading rail.
    gutter: { height: CONTROL_SIZE, alignItems: "center", justifyContent: "center", flexShrink: 0 },
    rows: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
    row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
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
    // Ghost actions sit on the field's rail, so they carry the field's padding.
    replaceAction: { paddingHorizontal: theme.spacing[2] },
  };
});
