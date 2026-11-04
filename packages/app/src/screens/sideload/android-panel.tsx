import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import type { DaemonClient, SideloadDevice } from "@jagentdesk/client/internal/daemon-client";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { useFilePicker } from "@/hooks/use-file-picker";
import { MutationButton, ValueButton } from "./buttons";
import { unwrap } from "./queries";
import { sideloadStyles as styles } from "./styles";

// 26.8 Android: install an .apk, split APKs or an .apks bundle with adb; pair wireless
// debugging with the code the phone shows (Android 11+). No re-signing.

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

export function AndroidInstallCard({
  client,
  device,
}: {
  client: DaemonClient;
  device: SideloadDevice;
}) {
  const { pickFiles } = useFilePicker();
  const install = useMutation({
    mutationFn: async () => {
      const files = (await pickFiles()) ?? [];
      if (files.length === 0) return null;
      const paths: string[] = [];
      for (const file of files) {
        const uploaded = await client.uploadFile({
          fileName: file.fileName,
          mimeType: file.mimeType,
          bytes: await file.readBytes(),
        });
        if (uploaded.error || !uploaded.file)
          throw new Error(uploaded.error ?? `Uploading ${file.fileName} failed`);
        paths.push(uploaded.file.path);
      }
      return unwrap(
        await client.sideloadCall(
          "android.install.start.request",
          { serial: device.id, paths },
          { timeout: 20 * 60_000 },
        ),
      ).output;
    },
  });
  return (
    <View style={styles.card} testID="sideload-android-install">
      <Text style={styles.label}>Install on {device.name}</Text>
      <Text style={styles.muted}>
        Choose one .apk, several split .apk files of one app, or one .apks / .xapk bundle.
      </Text>
      <MutationButton mutation={install} variables={undefined} disabled={!device.ready}>
        Choose APK and install…
      </MutationButton>
      {install.data ? (
        <Text style={styles.successText}>Installed: {install.data.split("\n").at(-1)}</Text>
      ) : null}
      {install.error ? (
        <Alert variant="error" title="adb install failed" description={errorText(install.error)} />
      ) : null}
    </View>
  );
}

export function AndroidPairingCard({
  client,
  onPaired,
}: {
  client: DaemonClient;
  onPaired: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pairAddress, setPairAddress] = useState("");
  const [code, setCode] = useState("");
  const [connectAddress, setConnectAddress] = useState("");
  const pair = useMutation({
    mutationFn: async () =>
      unwrap(
        await client.sideloadCall("android.pair.start.request", {
          pairAddress: pairAddress.trim(),
          code: code.trim(),
          ...(connectAddress.trim() ? { connectAddress: connectAddress.trim() } : {}),
        }),
      ).output,
    onSuccess: onPaired,
  });
  if (!open) {
    return (
      <ValueButton
        variant="ghost"
        size="sm"
        value={true}
        onValue={setOpen}
        testID="sideload-android-pair-open"
      >
        Pair an Android device over Wi-Fi…
      </ValueButton>
    );
  }
  return (
    <View style={styles.card} testID="sideload-android-pair">
      <Text style={styles.label}>Pair wireless debugging</Text>
      <Text style={styles.muted}>
        On the phone: Developer options → Wireless debugging → Pair device with pairing code. Enter
        the address and code it shows, and the address listed under Wireless debugging to connect.
      </Text>
      <AdaptiveTextInput
        initialValue=""
        onChangeText={setPairAddress}
        placeholder="Pairing address, e.g. <ip>:37251"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.inputMono}
      />
      <AdaptiveTextInput
        initialValue=""
        onChangeText={setCode}
        placeholder="6-digit pairing code"
        keyboardType="number-pad"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.inputMono}
      />
      <AdaptiveTextInput
        initialValue=""
        onChangeText={setConnectAddress}
        placeholder="Connect address, e.g. <ip>:41027"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.inputMono}
      />
      <View style={styles.wrapRow}>
        <MutationButton
          size="sm"
          mutation={pair}
          variables={undefined}
          disabled={!pairAddress.trim() || code.trim().length !== 6}
        >
          Pair
        </MutationButton>
        <ValueButton size="sm" variant="ghost" value={false} onValue={setOpen}>
          Close
        </ValueButton>
      </View>
      {pair.data ? <Text style={styles.successText}>{pair.data}</Text> : null}
      {pair.error ? (
        <Alert variant="error" title="Pairing failed" description={errorText(pair.error)} />
      ) : null}
    </View>
  );
}
