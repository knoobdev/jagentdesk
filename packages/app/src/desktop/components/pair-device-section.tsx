import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, TextInput, View, useWindowDimensions } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as QRCode from "qrcode";
import { SvgXml } from "react-native-svg";
import { Check, Copy, RotateCw, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonGetPairingOfferResponse } from "@jagentdesk/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useFetchQuery } from "@/data/query";
import { daemonPairingOfferQueryKey } from "@/data/daemon-pairing";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { PendingPairingRequest } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface PairDeviceSectionProps {
  serverId: string;
  onClose: () => void;
}

type PairingOfferPayload = DaemonGetPairingOfferResponse["payload"];

function useActivePairingRequests(requests: PendingPairingRequest[]): PendingPairingRequest[] {
  const [pairingClock, setPairingClock] = useState(() => Date.now());

  useEffect(() => {
    if (!requests.some((request) => request.status === "pending")) {
      return;
    }
    const timer = setInterval(() => setPairingClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [requests]);

  return requests.filter(
    (request) => request.status === "completed" || request.expiresAtMs > pairingClock,
  );
}

export function PairDeviceSection({ serverId, onClose }: PairDeviceSectionProps) {
  const { t } = useTranslation();
  const { width: viewportWidth } = useWindowDimensions();
  const client = useHostRuntimeClient(serverId);
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);
  const isConnected = runtimeSnapshot?.connectionStatus === "online";
  const isDisconnected =
    runtimeSnapshot?.connectionStatus === "offline" ||
    runtimeSnapshot?.connectionStatus === "error";
  const [copied, setCopied] = useState(false);
  const [cancellingRequestIds, setCancellingRequestIds] = useState<Set<string>>(() => new Set());
  const [cancelError, setCancelError] = useState<string | null>(null);
  const forceRefreshRef = useRef(true);

  const pairingQuery = useFetchQuery({
    queryKey: daemonPairingOfferQueryKey(serverId),
    queryFn: async () => {
      const forceRefresh = forceRefreshRef.current;
      forceRefreshRef.current = false;
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.getDaemonPairingOffer({ forceRefresh });
    },
    // Pairing is a JAgentDesk daemon capability, not a renderer feature-gate.
    // The status message can arrive after this panel mounts; gating the query
    // on that message left the panel stuck at "Pairing offer unavailable"
    // even though the daemon RPC was healthy.
    enabled: Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    retry: 1,
  });

  const qrQuery = useFetchQuery({
    queryKey: ["daemon-pairing-offer-qr", pairingQuery.data?.url],
    queryFn: () =>
      QRCode.toString(pairingQuery.data?.url ?? "", {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
        width: 480,
      }),
    enabled: Boolean(pairingQuery.data?.url),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
  });

  const handleCopyLink = useCallback(async () => {
    if (!pairingQuery.data?.url) return;
    await Clipboard.setStringAsync(pairingQuery.data.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [pairingQuery.data?.url]);
  const handleCopyPress = useCallback(() => {
    void handleCopyLink();
  }, [handleCopyLink]);
  const handleCancelPairing = useCallback(
    async (requestId: string) => {
      if (!client) {
        setCancelError(t("workspace.terminal.hostDisconnected"));
        return;
      }
      setCancelError(null);
      setCancellingRequestIds((current) => new Set(current).add(requestId));
      try {
        const result = await client.pairingDeviceCancel({ targetRequestId: requestId });
        if (!result.ok) {
          throw new Error(result.error ?? "Pairing request is no longer pending");
        }
      } catch (error) {
        setCancelError(error instanceof Error ? error.message : String(error));
      } finally {
        setCancellingRequestIds((current) => {
          const next = new Set(current);
          next.delete(requestId);
          return next;
        });
      }
    },
    [client, t],
  );
  const handleRetry = useCallback(() => {
    forceRefreshRef.current = true;
    void pairingQuery.refetch();
  }, [pairingQuery]);
  const qrSvg = useMemo(() => qrQuery.data ?? null, [qrQuery.data]);
  const activePairingRequests = useActivePairingRequests(
    runtimeSnapshot?.pendingPairingRequests ??
      (runtimeSnapshot?.pendingPairingRequest ? [runtimeSnapshot.pendingPairingRequest] : []),
  );

  return (
    <View testID="pair-device-content">
      <PairDeviceBody
        isPending={pairingQuery.isPending}
        isDisconnected={isDisconnected}
        error={pairingQuery.error}
        offer={pairingQuery.data}
        qrSvg={qrSvg}
        qrError={qrQuery.isError}
        pairingRequests={activePairingRequests}
        cancellingRequestIds={cancellingRequestIds}
        cancelError={cancelError}
        isWideLayout={viewportWidth >= 720}
        copied={copied}
        onRetry={handleRetry}
        onClose={onClose}
        onCopy={handleCopyPress}
        onCancel={handleCancelPairing}
      />
    </View>
  );
}

interface PairDeviceBodyProps {
  isPending: boolean;
  isDisconnected: boolean;
  error: Error | null;
  offer: PairingOfferPayload | undefined;
  qrSvg: string | null;
  qrError: boolean;
  pairingRequests: PendingPairingRequest[];
  cancellingRequestIds: Set<string>;
  cancelError: string | null;
  isWideLayout: boolean;
  copied: boolean;
  onRetry: () => void;
  onClose: () => void;
  onCopy: () => void;
  onCancel: (requestId: string) => void;
}

function PairDeviceBody(props: PairDeviceBodyProps) {
  const { t } = useTranslation();
  let offerContent: ReactNode;
  if (props.isDisconnected) {
    offerContent = (
      <OfferLoadError message={t("workspace.terminal.hostDisconnected")} onRetry={props.onRetry} />
    );
  } else if (props.isPending) {
    offerContent = <Text style={styles.stateLine}>{t("pairing.device.loadingOffer")}</Text>;
  } else if (props.error) {
    offerContent = <OfferLoadError message={props.error.message} onRetry={props.onRetry} />;
  } else if (props.offer?.tailnetEnabled === false || !props.offer?.url) {
    offerContent = <Text style={styles.stateLine}>{t("pairing.device.unavailable")}</Text>;
  } else {
    offerContent = <PairingOffer {...props} offer={props.offer} />;
  }

  return (
    <View style={[styles.body, props.isWideLayout && styles.bodyWide]}>
      <View style={props.isWideLayout ? styles.requestColumn : undefined}>
        <PairingRequestPanel
          requests={props.pairingRequests}
          cancellingRequestIds={props.cancellingRequestIds}
          cancelError={props.cancelError}
          onCancel={props.onCancel}
        />
      </View>
      <View style={props.isWideLayout ? styles.offerColumn : undefined}>{offerContent}</View>
    </View>
  );
}

function OfferLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert variant="error" description={message}>
      <Button variant="outline" size="sm" leftIcon={RotateCw} onPress={onRetry}>
        {t("pairing.device.retry")}
      </Button>
    </Alert>
  );
}

function PairingOffer(props: PairDeviceBodyProps & { offer: PairingOfferPayload }) {
  const { t } = useTranslation();
  return (
    <View style={styles.offer}>
      <Text style={styles.offerHint}>
        Copy this link or scan the QR code. After the mobile device joins Tailscale, this desktop
        will show the device request and six-digit code in this panel.
      </Text>
      <View style={styles.qrTile}>
        <PairingQr svg={props.qrSvg} isError={props.qrError} />
      </View>
      <View style={styles.linkRow}>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.linkInput}
            value={props.offer.url}
            readOnly
            selectTextOnFocus
            accessibilityLabel={t("pairing.link.label")}
          />
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={props.copied ? Check : Copy}
          onPress={props.onCopy}
        >
          {props.copied ? t("pairing.device.copied") : t("pairing.device.copy")}
        </Button>
      </View>
    </View>
  );
}

function PairingRequestPanel({
  requests,
  cancellingRequestIds,
  cancelError,
  onCancel,
}: {
  requests: PendingPairingRequest[];
  cancellingRequestIds: Set<string>;
  cancelError: string | null;
  onCancel: (requestId: string) => void;
}) {
  const request = requests.at(-1);
  if (!request) {
    return (
      <View style={styles.requestPanel} testID="pairing-request-panel">
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.requestTitle}>Waiting for a device connection…</Text>
        <Text style={styles.requestDescription}>
          Enter the pairing link in the mobile app first. Device details and a unique verification
          code will appear here after that device reaches this host.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.requestPanel} testID="pairing-request-panel">
      {cancelError ? <Alert variant="error" description={cancelError} /> : null}
      <Text style={styles.requestTitle}>Device connection request</Text>
      <Text style={styles.requestCount}>
        {request.status === "pending"
          ? "1 device waiting for verification"
          : "Device pairing completed"}
      </Text>
      <Text style={styles.requestDescription}>
        Confirm this device and enter the displayed code in the matching mobile app.
      </Text>
      <View style={styles.requestList}>
        <PairingRequestCard
          request={request}
          cancelling={cancellingRequestIds.has(request.requestId)}
          onCancel={onCancel}
        />
      </View>
    </View>
  );
}

function PairingRequestCard({
  request,
  cancelling,
  onCancel,
}: {
  request: PendingPairingRequest;
  cancelling: boolean;
  onCancel: (requestId: string) => void;
}) {
  const isCompleted = request.status === "completed";
  const deviceName = request.deviceName ?? "Device identity pending";
  const deviceKey = request.devicePublicKeyB64
    ? request.devicePublicKeyB64.slice(0, 8) + "…" + request.devicePublicKeyB64.slice(-8)
    : "Waiting for device key";
  const remainingMs = Math.max(0, request.expiresAtMs - Date.now());
  const remainingSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const countdown = [minutes, seconds.toString().padStart(2, "0")].join(":");
  const handleCancel = useCallback(
    () => onCancel(request.requestId),
    [onCancel, request.requestId],
  );

  return (
    <View style={styles.requestCard} testID="pairing-request-device">
      <View style={styles.requestCardHeader}>
        <Text style={styles.cardTitle}>
          {isCompleted ? "Device connected successfully" : "Device connection request"}
        </Text>
        {!isCompleted ? <Text style={styles.countdown}>{countdown}</Text> : null}
      </View>
      <Text style={styles.infoLabel}>Device</Text>
      <Text style={styles.infoValue}>{deviceName}</Text>
      <Text style={styles.infoLabel}>Device key</Text>
      <Text style={styles.infoValue}>{deviceKey}</Text>
      {request.deviceId ? (
        <>
          <Text style={styles.infoLabel}>Paired device ID</Text>
          <Text style={styles.infoValue}>{request.deviceId}</Text>
        </>
      ) : null}
      {!isCompleted ? (
        <View style={styles.codeCard} testID="pairing-request-code">
          <Text style={styles.codeLabel}>6-digit verification code</Text>
          <Text style={styles.code}>{request.pairingCode}</Text>
          <Text style={styles.expiryLabel}>Expires in {countdown}</Text>
        </View>
      ) : null}
      {!isCompleted ? (
        <View style={styles.requestActions}>
          <Button
            variant="outline"
            size="sm"
            leftIcon={X}
            disabled={cancelling}
            loading={cancelling}
            onPress={handleCancel}
            testID="pairing-request-decline"
          >
            Decline
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function PairingQr({ svg, isError }: { svg: string | null; isError: boolean }) {
  const { t } = useTranslation();
  if (svg) {
    return (
      <SvgXml
        xml={svg}
        style={styles.qrImage}
        accessibilityRole="image"
        accessibilityLabel={t("pairing.device.qrAccessibility")}
      />
    );
  }
  if (isError) {
    return <Text style={styles.hint}>{t("pairing.device.qrUnavailable")}</Text>;
  }
  return <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />;
}

const styles = StyleSheet.create((theme) => ({
  stateLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
  body: {
    gap: theme.spacing[4],
  },
  bodyWide: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[4],
  },
  requestColumn: {
    flex: 1,
    minWidth: 0,
  },
  offerColumn: {
    flex: 1,
    minWidth: 0,
  },
  offer: {
    gap: theme.spacing[4],
  },
  offerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  qrTile: {
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    width: 304,
    maxWidth: "100%",
    aspectRatio: 1,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.palette.white,
  },
  qrImage: {
    width: "100%",
    height: "100%",
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inputWrapper: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  linkInput: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    outlineStyle: "none",
  } as object,
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  requestPanel: {
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  requestList: {
    gap: theme.spacing[3],
  },
  requestCard: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  requestCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  requestActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  cardTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  requestCount: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  requestTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  requestDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    textAlign: "center",
  },
  deviceInfoCard: {
    alignSelf: "stretch",
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  infoLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  infoValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  codeCard: {
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  codeLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  code: {
    color: theme.colors.foreground,
    fontSize: 30,
    fontWeight: theme.fontWeight.bold,
    letterSpacing: 5,
  },
  countdown: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  expiryLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
