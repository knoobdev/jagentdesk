import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { PairDaemonSection } from "./pair-daemon-section";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { PairDeviceSection } from "@/desktop/components/pair-device-section";

export interface PairDeviceModalProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  testID?: string;
}

const SNAP_POINTS: string[] = ["78%", "94%"];

export function PairDeviceModal({ serverId, visible, onClose, testID }: PairDeviceModalProps) {
  const { t } = useTranslation();
  const [pairDaemon, setPairDaemon] = useState(false);
  const openDaemonPairing = useCallback(() => setPairDaemon(true), []);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.pairDevices.rowTitle") }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={820}
      testID={testID}
    >
      {pairDaemon ? (
        <PairDaemonSection serverId={serverId} onClose={onClose} />
      ) : (
        <View>
          <PairDeviceSection serverId={serverId} onClose={onClose} />
          <Button variant="outline" onPress={openDaemonPairing}>
            Pair a daemon
          </Button>
        </View>
      )}
    </AdaptiveModalSheet>
  );
}
