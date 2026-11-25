import { createContext, useCallback, useContext } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import { ICON_SIZE } from "@/styles/theme";

export { extraMutedIconColorMapping, mutedIconColorMapping } from "@/components/ui/icon-color";

export type IconButtonChromeSize = "large" | "small";

const SMALL_ICON_BUTTON_SIZE = 20;
const COMPACT_SMALL_ICON_BUTTON_SIZE = 32;

export interface IconButtonChromeState {
  hovered?: boolean;
  pressed?: boolean;
  open?: boolean;
  active?: boolean;
}

function resolveIconButtonFrame(size: IconButtonChromeSize, compact: boolean) {
  if (size === "large") return styles.large;
  return compact ? styles.smallCompact : styles.small;
}

interface IconButtonChromeOptions {
  size: IconButtonChromeSize;
  state?: IconButtonChromeState;
  compact?: boolean;
  disabled?: boolean;
  round?: boolean;
  style?: StyleProp<ViewStyle>;
}

const IconButtonChromeContext = createContext<"default" | "header-island">("default");

/** A container owns the chrome of its icon actions, including custom menu and badge triggers. */
export const IconButtonChromeProvider = IconButtonChromeContext.Provider;

/** The same state callback works with Pressable, TooltipTrigger, and DropdownMenuTrigger. */
export function useIconButtonChromeStyle({
  size,
  compact,
  disabled,
  round,
  style,
  active,
}: Omit<IconButtonChromeOptions, "state"> & { active?: boolean }) {
  const scope = useContext(IconButtonChromeContext);
  return useCallback(
    (state: IconButtonChromeState) =>
      iconButtonChromeStyle({
        size: scope === "header-island" ? "large" : size,
        compact,
        disabled,
        round: scope === "header-island" || round,
        style,
        state: { ...state, active: active || state.active },
      }),
    [scope, size, compact, disabled, round, style, active],
  );
}

/** Shared hitbox and interaction chrome for icon-only header and toolbar controls. */
export function iconButtonChromeStyle({
  size,
  state,
  compact = false,
  disabled = false,
  style,
  round = false,
}: IconButtonChromeOptions): StyleProp<ViewStyle> {
  const highlighted = state?.active || state?.hovered || state?.pressed || state?.open;
  return [
    resolveIconButtonFrame(size, compact),
    round ? styles.round : null,
    style,
    highlighted ? styles.highlighted : null,
    disabled ? styles.disabled : null,
  ];
}

/** Frame-only form for non-interactive placeholders that must preserve header alignment. */
export function iconButtonChromeFrameStyle(
  size: IconButtonChromeSize,
  compact = false,
): StyleProp<ViewStyle> {
  return resolveIconButtonFrame(size, compact);
}

export function iconButtonChromeGlyphSize(size: IconButtonChromeSize, compact = false): number {
  if (size === "large") return ICON_SIZE.md;
  return compact ? 18 : 14;
}

export function smallIconButtonChromeFrameSize(compact = false): number {
  return compact ? COMPACT_SMALL_ICON_BUTTON_SIZE : SMALL_ICON_BUTTON_SIZE;
}

// Draw toolbar focus rings inside controls whose parents clip overflow.
const FOCUS_RING_INSET = -2;
export function useIconButtonChromeGlyphSize(size: IconButtonChromeSize, compact = false): number {
  const scope = useContext(IconButtonChromeContext);
  return iconButtonChromeGlyphSize(scope === "header-island" ? "large" : size, compact);
}

const styles = StyleSheet.create((theme) => ({
  large: {
    width: {
      xs: 32,
      md: HEADER_CONTROL_HEIGHT,
    },
    height: {
      xs: 32,
      md: HEADER_CONTROL_HEIGHT,
    },
    padding: 0,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineOffset: FOCUS_RING_INSET,
  },
  small: {
    width: SMALL_ICON_BUTTON_SIZE,
    height: SMALL_ICON_BUTTON_SIZE,
    padding: 0,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineOffset: FOCUS_RING_INSET,
  },
  smallCompact: {
    width: COMPACT_SMALL_ICON_BUTTON_SIZE,
    height: COMPACT_SMALL_ICON_BUTTON_SIZE,
    padding: 0,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineOffset: FOCUS_RING_INSET,
  },
  round: { borderRadius: theme.borderRadius.full },
  highlighted: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
}));
