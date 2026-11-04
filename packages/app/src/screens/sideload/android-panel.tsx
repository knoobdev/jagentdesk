import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import type { DaemonClient, SideloadDevice } from "@jagentdesk/client/internal/daemon-client";
import { Alert } from "@/components/ui/alert";
import { useFilePicker } from "@/hooks/use-file-picker";
import { MutationButton, ValueButton } from "./buttons";
import { HostBrowseSheet } from "./host-browse-sheet";
import { unwrap } from "./queries";
import { sideloadStyles as styles } from "./styles";

// 26.8 Android: install an .apk, split APKs or an .apks bundle with adb on a phone plugged in
// with its USB cable. No re-signing. The file is uploaded from this device (Choose file…) or
// picked on the host (Browse host…); there is no free-text path field (26.9).

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function AndroidInstallCard({
  client,
  serverId,
  device,
  hostBrowse,
}: {
  client: DaemonClient;
  serverId: string;
  device: SideloadDevice;
  hostBrowse: boolean;
}) {
  const { pickFiles } = useFilePicker();
  // Daemon paths of the chosen files: upload results or one file picked on the host.
  const [paths, setPaths] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const closeBrowse = useCallback(() => setBrowsing(false), []);
  const onHostPick = useCallback((path: string) => setPaths([path]), []);
  const choose = useMutation({
    mutationFn: async () => {
      const files = (await pickFiles()) ?? [];
      if (files.length === 0) return;
      const uploaded: string[] = [];
      for (const file of files) {
        const result = await client.uploadFile({
          fileName: file.fileName,
          mimeType: file.mimeType,
          bytes: await file.readBytes(),
        });
        if (result.error || !result.file)
          throw new Error(result.error ?? `Uploading ${file.fileName} failed`);
        uploaded.push(result.file.path);
      }
      setPaths(uploaded);
    },
  });
  const install = useMutation({
    mutationFn: async (files: string[]) =>
      unwrap(
        await client.sideloadCall(
          "android.install.start.request",
          { serial: device.id, paths: files },
          { timeout: 20 * 60_000 },
        ),
      ).output,
  });
  return (
    <View style={styles.card} testID="sideload-android-install">
      <Text style={styles.label}>Install on {device.name}</Text>
      <Text style={styles.muted}>
        Choose one .apk, several split .apk files of one app, or one .apks / .xapk bundle.
      </Text>
      <View style={styles.wrapRow}>
        <MutationButton
          size="sm"
          variant="outline"
          mutation={choose}
          variables={undefined}
          testID="sideload-android-choose"
        >
          Choose file…
        </MutationButton>
        {hostBrowse ? (
          <ValueButton
            size="sm"
            variant="outline"
            value={true}
            onValue={setBrowsing}
            testID="sideload-android-browse-host"
          >
            Browse host…
          </ValueButton>
        ) : null}
      </View>
      {paths.length > 0 ? (
        <Text style={styles.mono} numberOfLines={2}>
          {paths.map(fileName).join(", ")}
        </Text>
      ) : null}
      {choose.error ? <Text style={styles.errorText}>{errorText(choose.error)}</Text> : null}
      <View style={styles.start}>
        <MutationButton
          mutation={install}
          variables={paths}
          disabled={!device.ready || paths.length === 0 || choose.isPending}
          testID="sideload-android-install-run"
        >
          Install
        </MutationButton>
      </View>
      {install.data ? (
        <Text style={styles.successText}>Installed: {install.data.split("\n").at(-1)}</Text>
      ) : null}
      {install.error ? (
        <Alert variant="error" title="adb install failed" description={errorText(install.error)} />
      ) : null}
      {hostBrowse ? (
        <HostBrowseSheet
          visible={browsing}
          client={client}
          serverId={serverId}
          kind="android"
          onClose={closeBrowse}
          onPick={onHostPick}
        />
      ) : null}
    </View>
  );
}
