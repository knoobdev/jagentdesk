// A page's head inside the phone's bot panel: Back with where it goes, then the page's title, as
// Orca's SheetHeader with `onBack` (mobile/src/components/nav-bar/SheetHeader.tsx) heads each pushed
// page (`MobileBotSoulAndMemory.tsx:110-113`).
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });

export function PhonePageHeader({
  title,
  backLabel,
  onBack,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        style={styles.back}
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        testID="phone-page-back"
      >
        <ThemedChevronLeft size={20} uniProps={foreground} />
      </Pressable>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  header: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, fontSize: 17, fontWeight: "600", color: theme.colors.foreground },
}));
