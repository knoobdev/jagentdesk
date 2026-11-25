import { withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "../../../../packages/app/src/plugins/builtin/host-api";

// The app spinner in the theme's muted color.
export const Spinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
