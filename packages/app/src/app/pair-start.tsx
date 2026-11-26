import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { loadPendingPairingOffer } from "@/pairing/pending-pairing-offer";
import { ConnectWorkstationScreen } from "@/components/connect-workstation-screen";

export default function PairStartScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ step?: string }>();
  const [pendingChecked, setPendingChecked] = useState(false);

  useEffect(() => {
    let active = true;
    void loadPendingPairingOffer()
      .then((pending) => {
        if (!active) return undefined;
        if (pending) {
          router.replace("/pair-verify" as Href);
          return undefined;
        }
        setPendingChecked(true);
        return undefined;
      })
      .catch(() => {
        if (active) setPendingChecked(true);
      });
    return () => {
      active = false;
    };
  }, [router]);

  if (!pendingChecked) {
    return <View style={styles.root} />;
  }

  return (
    <ConnectWorkstationScreen initialStep={params.step === "connect" ? "connect" : "welcome"} />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
