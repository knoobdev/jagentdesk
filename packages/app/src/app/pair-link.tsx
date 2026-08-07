import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PairLinkModal } from "@/components/pair-link-modal";

export default function PairLinkRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string }>();
  const source = params.source === "onboarding" ? "onboarding" : "settings";

  return (
    <View style={{ flex: 1 }}>
      <PairLinkModal
        visible
        source={source}
        title="Pair with JAgentDesk desktop"
        onClose={() => router.back()}
        onCancel={() => router.back()}
      />
    </View>
  );
}
