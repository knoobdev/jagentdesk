import {
  default as React,
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Pressable, Text, TextInput, View, type TextInputProps } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, Loader2 } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import type { Theme } from "@/styles/theme";
import { figmaStyles } from "./styles";

// Connection auth states rendered by AuthDot — mirrors the daemon's FigmaAuthState values
// (connected / needs_reauth / error) plus an offline tone for the sidebar.
export type AuthDotTone = "ok" | "needs-auth" | "expired" | "offline";

// Visual building blocks shared by the Figma surfaces (spec 32.2–32.6). Leaf visuals only,
// theme tokens throughout, mirroring the Jira surface kit.

export type ThemedIcon = ComponentType<{ size?: number; uniProps?: (theme: Theme) => object }>;

export const tint = {
  fg: (theme: Theme) => ({ color: theme.colors.foreground }),
  muted: (theme: Theme) => ({ color: theme.colors.foregroundMuted }),
  faint: (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted }),
  brand: (theme: Theme) => ({ color: theme.colors.accent }),
  red: (theme: Theme) => ({ color: theme.colors.statusDanger }),
  amber: (theme: Theme) => ({ color: theme.colors.statusWarning }),
  green: (theme: Theme) => ({ color: theme.colors.statusSuccess }),
};

const ThemedCircleAlert = withUnistyles(CircleAlert) as ThemedIcon;
const ThemedLoader2 = withUnistyles(Loader2) as ThemedIcon;
const ThemedChevronRight = withUnistyles(ChevronRight) as ThemedIcon;
const ThemedChevronDown = withUnistyles(ChevronDown) as ThemedIcon;
const ThemedCopy = withUnistyles(Copy) as ThemedIcon;
const ThemedCheck = withUnistyles(Check) as ThemedIcon;

export function ErrorBanner({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <View style={figmaStyles.errorBanner} testID="figma-error">
      <ThemedCircleAlert size={16} uniProps={tint.red} />
      <Text style={figmaStyles.errorText}>{message}</Text>
      {action}
    </View>
  );
}

export function EmptyState({
  title,
  body,
  action,
  testID,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  testID?: string;
}) {
  return (
    <View style={figmaStyles.empty} testID={testID}>
      <Text style={figmaStyles.emptyTitle}>{title}</Text>
      {body ? <Text style={figmaStyles.emptyMessage}>{body}</Text> : null}
      {action}
    </View>
  );
}

export function Spinner({ testID }: { testID?: string }) {
  return (
    <View style={figmaStyles.spinner} testID={testID ?? "figma-spinner"}>
      <ThemedLoader2 size={20} uniProps={tint.muted} />
    </View>
  );
}

export function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <View style={figmaStyles.section}>
      <View style={figmaStyles.rowBetween}>
        <Text style={figmaStyles.sectionHeading}>{title}</Text>
        {action}
      </View>
      {hint ? <Text style={figmaStyles.sectionHint}>{hint}</Text> : null}
    </View>
  );
}

export function DisclosureRow({
  expanded,
  onToggle,
  title,
  subtitle,
  testID,
}: {
  expanded: boolean;
  onToggle: () => void;
  title: string;
  subtitle?: string;
  testID?: string;
}) {
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  const state = useMemo(() => ({ expanded }), [expanded]);
  return (
    <Pressable
      style={figmaStyles.pressableRow}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={state}
      testID={testID}
    >
      <Chevron size={14} uniProps={tint.faint} />
      <View style={figmaStyles.flex1}>
        <Text style={figmaStyles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? <Text style={figmaStyles.rowSubtle}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={figmaStyles.section}>
      <Text style={figmaStyles.label}>{label}</Text>
      {children}
    </View>
  );
}

const ThemedTextInput = withUnistyles(TextInput);
const placeholderTint = (theme: Theme) => ({ placeholderTextColor: theme.colors.foregroundMuted });

export function Input(props: TextInputProps) {
  return (
    <ThemedTextInput
      accessibilityLabel={props.placeholder}
      {...props}
      style={figmaStyles.input}
      uniProps={placeholderTint}
    />
  );
}

export function Badge({ label, testID }: { label: string; testID?: string }) {
  return (
    <View style={figmaStyles.badge} testID={testID}>
      <Text style={figmaStyles.badgeText}>{label}</Text>
    </View>
  );
}

/**
 * Small status dot for connection auth states: green when connected, amber when the token needs
 * re-auth, red when expired, muted when offline.
 */
const DOT_STYLE_KEY: Record<AuthDotTone, "dotOk" | "dotWarn" | "dotExpired" | "dotOffline"> = {
  ok: "dotOk",
  expired: "dotExpired",
  "needs-auth": "dotWarn",
  offline: "dotOffline",
};

export function AuthDot({ tone, testID }: { tone: AuthDotTone; testID?: string }) {
  return (
    <View style={figmaStyles[DOT_STYLE_KEY[tone]]} testID={testID ?? `figma-auth-dot-${tone}`} />
  );
}

export function CopyButton({
  value,
  label,
  testID,
}: {
  value: string;
  label?: string;
  testID?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void Clipboard.setStringAsync(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        return true;
      })
      .catch(() => undefined);
  }, [value]);
  return (
    <Pressable
      style={figmaStyles.pressableRow}
      onPress={onCopy}
      accessibilityRole="button"
      testID={testID ?? "figma-copy"}
    >
      {copied ? (
        <ThemedCheck size={14} uniProps={tint.green} />
      ) : (
        <ThemedCopy size={14} uniProps={tint.muted} />
      )}
      <Text style={figmaStyles.rowTitle}>{copied ? "Copied" : (label ?? "Copy")}</Text>
    </Pressable>
  );
}
