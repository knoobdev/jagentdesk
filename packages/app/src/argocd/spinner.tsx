import { withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The inline (14) or page-level ("large") loading spinner in the muted color. */
export function ArgoCdSpinner({ size }: { size: number | "large" }) {
  return <ThemedSpinner size={size} uniProps={mutedColor} />;
}
