import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Minus, Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  SSH_TERMINAL_FONT_SIZE_MAX,
  SSH_TERMINAL_FONT_SIZE_MIN,
  type SshTerminalAppearance,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { Button } from "@/components/ui/button";
import type { ThemeName } from "@/styles/theme";
import {
  TERMINAL_THEME_NAMES,
  terminalPaletteFor,
  type ResolvedTerminalAppearance,
} from "./appearance";
import { sshStyles } from "./ui";

export interface TerminalAppearancePickerProps {
  /** The values set on this server or group itself. */
  value: SshTerminalAppearance;
  /** What this server/group would get without its own values (from its parents). */
  inherited: ResolvedTerminalAppearance;
  /** Fallback font size when nothing in the chain sets one. */
  defaultFontSize: number;
  onChange: (next: SshTerminalAppearance) => void;
}

/**
 * Terminal theme and font size for a server or group (spec 25.2, 25.4). "Inherit"
 * clears the field so the nearest parent group's value applies.
 */
export function TerminalAppearancePicker({
  value,
  inherited,
  defaultFontSize,
  onChange,
}: TerminalAppearancePickerProps) {
  const { t } = useTranslation();
  const fontSize = value.fontSize ?? inherited.fontSize ?? defaultFontSize;
  const setFontSize = useCallback(
    (next: number) => {
      const clamped = Math.min(
        SSH_TERMINAL_FONT_SIZE_MAX,
        Math.max(SSH_TERMINAL_FONT_SIZE_MIN, next),
      );
      onChange({ ...value, fontSize: clamped });
    },
    [onChange, value],
  );
  const selectTheme = useCallback(
    (theme: ThemeName | undefined) => onChange({ ...value, theme }),
    [onChange, value],
  );
  const smaller = useCallback(() => setFontSize(fontSize - 1), [setFontSize, fontSize]);
  const larger = useCallback(() => setFontSize(fontSize + 1), [setFontSize, fontSize]);
  const inheritFontSize = useCallback(
    () => onChange({ ...value, fontSize: undefined }),
    [onChange, value],
  );
  const inheritedThemeLabel = inherited.theme
    ? t(`settings.appearance.theme.options.${inherited.theme}`)
    : t("ssh.snippets.appearance.appTheme");
  return (
    <View style={sshStyles.stack} testID="ssh-terminal-appearance">
      <Text style={sshStyles.rowTitle}>{t("ssh.snippets.appearance.theme")}</Text>
      <View style={sshStyles.chips}>
        <ThemeOption
          name={undefined}
          label={t("ssh.snippets.appearance.inherit", { value: inheritedThemeLabel })}
          active={value.theme === undefined}
          onSelect={selectTheme}
        />
        {TERMINAL_THEME_NAMES.map((name) => (
          <ThemeOption
            key={name}
            name={name}
            label={t(`settings.appearance.theme.options.${name}`)}
            active={value.theme === name}
            onSelect={selectTheme}
          />
        ))}
      </View>
      <Text style={sshStyles.rowTitle}>{t("ssh.snippets.appearance.fontSize")}</Text>
      <View style={sshStyles.inlineRow}>
        <Button
          size="sm"
          variant="outline"
          leftIcon={Minus}
          onPress={smaller}
          disabled={fontSize <= SSH_TERMINAL_FONT_SIZE_MIN}
          accessibilityLabel={t("ssh.snippets.appearance.smaller")}
        />
        <Text style={sshStyles.rowTitle} testID="ssh-terminal-font-size">
          {fontSize}
        </Text>
        <Button
          size="sm"
          variant="outline"
          leftIcon={Plus}
          onPress={larger}
          disabled={fontSize >= SSH_TERMINAL_FONT_SIZE_MAX}
          accessibilityLabel={t("ssh.snippets.appearance.larger")}
        />
        {value.fontSize !== undefined ? (
          <Button size="sm" variant="ghost" onPress={inheritFontSize}>
            {t("ssh.snippets.appearance.useInherited")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

/** One theme choice; `name` undefined is the "Inherit" choice (no preview). */
function ThemeOption({
  name,
  label,
  active,
  onSelect,
}: {
  name: ThemeName | undefined;
  label: string;
  active: boolean;
  onSelect: (name: ThemeName | undefined) => void;
}) {
  const select = useCallback(() => onSelect(name), [onSelect, name]);
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={select}
      style={active ? styles.optionActive : styles.option}
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      accessibilityLabel={label}
      testID={`ssh-terminal-theme-${name ?? "inherit"}`}
    >
      {name ? <ThemePreview name={name} /> : null}
      <Text style={styles.optionLabel}>{label}</Text>
    </Pressable>
  );
}

function ThemePreview({ name }: { name: ThemeName }) {
  const palette = terminalPaletteFor(name);
  const previewStyle = useMemo(
    () => [styles.preview, { backgroundColor: palette.background }],
    [palette.background],
  );
  const textStyle = useMemo(
    () => [styles.previewText, { color: palette.foreground }],
    [palette.foreground],
  );
  return (
    <View style={previewStyle}>
      <Text style={textStyle}>$_</Text>
      <View style={styles.swatches}>
        <Swatch color={palette.red} />
        <Swatch color={palette.green} />
        <Swatch color={palette.yellow} />
        <Swatch color={palette.blue} />
        <Swatch color={palette.magenta} />
      </View>
    </View>
  );
}

function Swatch({ color }: { color: string }) {
  const style = useMemo(() => [styles.swatch, { backgroundColor: color }], [color]);
  return <View style={style} />;
}

const styles = StyleSheet.create((theme) => ({
  option: {
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    justifyContent: "center",
  },
  optionActive: {
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.accent,
    justifyContent: "center",
  },
  optionLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  preview: {
    width: 96,
    height: 40,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing[1],
    justifyContent: "space-between",
  },
  previewText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  swatches: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  swatch: {
    width: 10,
    height: 6,
    borderRadius: theme.borderRadius.sm,
  },
}));
