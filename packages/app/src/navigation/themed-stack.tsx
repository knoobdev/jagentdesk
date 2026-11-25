import { Stack } from "expo-router";
import { type ComponentProps, type ReactNode, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";

type NativeStackNavigationOptions = Exclude<
  NonNullable<ComponentProps<typeof Stack>["screenOptions"]>,
  (...args: never[]) => unknown
>;

interface ThemedStackBaseProps {
  backgroundColor: string;
  children?: ReactNode;
  screenOptions?: NativeStackNavigationOptions;
  screenLayout?: ComponentProps<typeof Stack>["screenLayout"];
}

function ThemedStackBase({
  backgroundColor,
  children,
  screenOptions,
  screenLayout,
}: ThemedStackBaseProps) {
  const themedScreenOptions = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...screenOptions,
      contentStyle: [{ backgroundColor }, screenOptions?.contentStyle],
    }),
    [backgroundColor, screenOptions],
  );

  return (
    <Stack screenOptions={themedScreenOptions} screenLayout={screenLayout}>
      {children}
    </Stack>
  );
}

export const ThemedStack = withUnistyles(ThemedStackBase, (theme) => ({
  backgroundColor: theme.colors.surface0,
}));
