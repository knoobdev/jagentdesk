import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import { DeviceIcon, UploadIcon } from "./icons";
import { useMutation } from "@tanstack/react-query";
import type {
  DaemonClient,
  SideloadAccountSummary,
  SideloadDevice,
  SideloadInstallProgress,
  SideloadIpaInfo,
  SideloadOptions,
} from "@jagentdesk/client/internal/daemon-client";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { isWeb } from "@/constants/platform";
import { useFilePicker } from "@/hooks/use-file-picker";
import { useSessionStore } from "@/stores/session-store";
import { AndroidInstallCard } from "./android-panel";
import { KeyedSwitch, MutationButton, ValueButton } from "./buttons";
import { HostBrowseSheet } from "./host-browse-sheet";
import { unwrap, useSideloadAccounts, useSideloadDevices, type JobEvent } from "./queries";
import { sideloadStyles as styles } from "./styles";

// 26.5 / 26.9 Install: choose an IPA (upload it from this device — Choose file… or drop it on
// desktop — or pick one on the host with Browse host…), a device and an account, set the
// advanced options, then follow each step the daemon reports. There is no free-text path field.

type Mode = "sign_install" | "install_as_is" | "export";
const MODE_OPTIONS = [
  { value: "sign_install" as const, label: "Sign & install" },
  { value: "install_as_is" as const, label: "Install as-is" },
  { value: "export" as const, label: "Export signed IPA" },
];
const STEP_LABELS: Record<SideloadInstallProgress["step"], string> = {
  inspect: "Check IPA",
  login: "Sign in",
  register_device: "Register device",
  certificate: "Certificate",
  app_id: "App IDs",
  profile: "Profiles",
  sign: "Sign",
  install: "Install",
  export: "Export",
};

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/** "Hide sensitive info" (26.5): masks UDIDs, emails and team ids in the job log. */
export function maskSensitive(text: string): string {
  return text
    .replace(/[0-9A-F]{8}-[0-9A-F]{16}|[0-9a-f]{40}/gi, "••••••••")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "•••@•••")
    .replace(/\b[A-Z0-9]{10}\b/g, "••••••••••");
}

// `path`: a file picked on the daemon host with Browse host….
type UploadInput = { bytes: Uint8Array; fileName: string } | { path: string };

async function uploadToDaemon(client: DaemonClient, input: UploadInput): Promise<SideloadIpaInfo> {
  let path: string;
  if ("path" in input) {
    path = input.path;
  } else {
    const uploaded = await client.uploadFile({
      fileName: input.fileName,
      mimeType: "application/octet-stream",
      bytes: input.bytes,
    });
    if (uploaded.error || !uploaded.file) throw new Error(uploaded.error ?? "Upload failed");
    path = uploaded.file.path;
  }
  const ipa = unwrap(await client.sideloadCall("sideload.ipa.upload.request", { path })).ipa;
  if (!ipa) throw new Error("The daemon could not read the IPA");
  return ipa;
}

/** Desktop: drop an .ipa on the zone (browser and Electron both give File bytes). */
function useDropZone(onFile: (file: File) => void) {
  const ref = useRef<View>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!isWeb) return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;
    const over = (event: DragEvent) => {
      event.preventDefault();
      setActive(true);
    };
    const leave = () => setActive(false);
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setActive(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) onFile(file);
    };
    node.addEventListener("dragover", over);
    node.addEventListener("dragleave", leave);
    node.addEventListener("drop", drop);
    return () => {
      node.removeEventListener("dragover", over);
      node.removeEventListener("dragleave", leave);
      node.removeEventListener("drop", drop);
    };
  }, [onFile]);
  return { ref, active };
}

export function InstallSection({
  client,
  serverId,
  jobs,
}: {
  client: DaemonClient;
  serverId: string;
  jobs: Record<string, JobEvent[]>;
}) {
  const devices = useSideloadDevices(client, serverId);
  const accounts = useSideloadAccounts(client, serverId);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const list = devices.data?.devices ?? [];
  const device = list.find((candidate) => candidate.id === deviceId) ?? null;
  const { refetch } = devices;
  const refresh = useCallback(() => void refetch(), [refetch]);
  // COMPAT(sideloadHostBrowse): v0.9.48 daemons do not answer sideload.host.browse.
  const hostBrowse = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.sideloadHostBrowse === true,
  );

  return (
    <ScrollView contentContainerStyle={styles.section} testID="sideload-install">
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Device</Text>
          <ValueButton
            size="sm"
            variant="ghost"
            leftIcon={RefreshCw}
            value={undefined}
            onValue={refresh}
            loading={devices.isFetching}
          >
            Refresh
          </ValueButton>
        </View>
        {devices.isPending ? <Text style={styles.muted}>Looking for devices…</Text> : null}
        {devices.error ? <Text style={styles.errorText}>{errorText(devices.error)}</Text> : null}
        {!devices.isPending && list.length === 0 ? (
          <Text style={styles.muted}>
            No device found. Plug the phone in with its cable and unlock it. iPhone or iPad: tap
            Trust on the Trust This Computer prompt. Android: allow USB debugging when the phone
            asks (turn it on in Developer options first).
          </Text>
        ) : null}
        {list.map((candidate) => (
          <DeviceRow
            key={`${candidate.platform}:${candidate.id}`}
            device={candidate}
            selected={deviceId === candidate.id}
            onSelect={setDeviceId}
          />
        ))}
        {devices.data?.iosUnavailableReason ? (
          <Text style={styles.muted}>iOS: {devices.data.iosUnavailableReason}</Text>
        ) : null}
        {devices.data?.androidUnavailableReason ? (
          <Text style={styles.muted}>Android: {devices.data.androidUnavailableReason}</Text>
        ) : null}
      </View>
      {device?.platform === "android" ? (
        <AndroidInstallCard
          client={client}
          serverId={serverId}
          device={device}
          hostBrowse={hostBrowse}
        />
      ) : (
        <IosInstall
          client={client}
          serverId={serverId}
          hostBrowse={hostBrowse}
          device={device}
          accounts={accounts.data ?? []}
          jobs={jobs}
        />
      )}
    </ScrollView>
  );
}

function DeviceRow({
  device,
  selected,
  onSelect,
}: {
  device: SideloadDevice;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const kind = device.platform === "ios" ? "IPA" : "APK";
  return (
    <View
      style={selected ? styles.choiceSelected : styles.choice}
      testID={`sideload-device-${device.id}`}
    >
      <View style={device.ready ? styles.dotOn : styles.dotOff} />
      <DeviceIcon size={16} />
      <View style={styles.grow}>
        <Text style={styles.text} numberOfLines={1}>
          {device.name} · {device.platform === "ios" ? "iOS" : "Android"} {device.osVersion}
        </Text>
        <Text style={styles.mono} numberOfLines={1}>
          {device.model} · {device.connection === "wifi" ? "Wi-Fi" : "USB"} · {device.id}
        </Text>
        {device.notReadyReason ? (
          <Text style={styles.errorText}>{device.notReadyReason}</Text>
        ) : null}
      </View>
      <ValueButton
        size="sm"
        variant={selected ? "secondary" : "outline"}
        value={device.id}
        onValue={onSelect}
        disabled={!device.ready}
      >
        {`Install ${kind}`}
      </ValueButton>
    </View>
  );
}

function IpaPicker({
  client,
  serverId,
  hostBrowse,
  onIpa,
}: {
  client: DaemonClient;
  serverId: string;
  hostBrowse: boolean;
  onIpa: (ipa: SideloadIpaInfo) => void;
}) {
  const { pickFiles } = useFilePicker();
  const [browsing, setBrowsing] = useState(false);
  const closeBrowse = useCallback(() => setBrowsing(false), []);
  const upload = useMutation({
    mutationFn: (input: UploadInput) => uploadToDaemon(client, input),
    onSuccess: onIpa,
  });
  const { mutate } = upload;
  const choose = useMutation({
    mutationFn: async () => {
      const file = (await pickFiles())?.[0];
      if (file) mutate({ bytes: await file.readBytes(), fileName: file.fileName });
    },
  });
  const onDrop = useCallback(
    (file: File) => {
      void file.arrayBuffer().then((buffer) => {
        mutate({ bytes: new Uint8Array(buffer), fileName: file.name });
        return undefined;
      });
    },
    [mutate],
  );
  const onHostPick = useCallback((path: string) => mutate({ path }), [mutate]);
  const drop = useDropZone(onDrop);
  return (
    <View
      ref={drop.ref}
      style={drop.active ? styles.dropZoneActive : styles.dropZone}
      testID="sideload-drop"
    >
      <UploadIcon size={20} />
      <Text style={styles.title}>
        {isWeb ? "Drop an .ipa here or choose a file" : "Choose an .ipa"}
      </Text>
      <View style={styles.wrapRow}>
        <MutationButton
          size="sm"
          mutation={choose}
          variables={undefined}
          disabled={upload.isPending}
          testID="sideload-choose-ipa"
        >
          Choose file…
        </MutationButton>
        {hostBrowse ? (
          <ValueButton
            size="sm"
            variant="outline"
            value={true}
            onValue={setBrowsing}
            disabled={upload.isPending}
            testID="sideload-browse-host"
          >
            Browse host…
          </ValueButton>
        ) : null}
      </View>
      {upload.isPending ? <Text style={styles.muted}>Uploading and checking the IPA…</Text> : null}
      {upload.error ? <Text style={styles.errorText}>{errorText(upload.error)}</Text> : null}
      {choose.error ? <Text style={styles.errorText}>{errorText(choose.error)}</Text> : null}
      {hostBrowse ? (
        <HostBrowseSheet
          visible={browsing}
          client={client}
          serverId={serverId}
          kind="ios"
          onClose={closeBrowse}
          onPick={onHostPick}
        />
      ) : null}
    </View>
  );
}

function canStartJob(input: {
  ipa: SideloadIpaInfo | null;
  mode: Mode;
  account: SideloadAccountSummary | null;
  device: SideloadDevice | null;
}): boolean {
  if (!input.ipa) return false;
  if (input.mode !== "install_as_is" && !input.account) return false;
  if (input.mode === "export") return true;
  return input.device?.platform === "ios" && input.device.ready;
}

async function startJob(input: {
  client: DaemonClient;
  ipa: SideloadIpaInfo | null;
  mode: Mode;
  account: SideloadAccountSummary | null;
  device: SideloadDevice | null;
  options: SideloadOptions;
  autoRefresh: boolean | null;
}): Promise<string> {
  const { client, ipa, mode, account, device, options, autoRefresh } = input;
  if (!ipa) throw new Error("Choose an IPA first.");
  const payload =
    mode === "export"
      ? await client.sideloadCall("sideload.export.start.request", {
          path: ipa.path,
          accountId: account?.id ?? "",
          options,
        })
      : await client.sideloadCall("sideload.install.start.request", {
          path: ipa.path,
          deviceUdid: device?.id ?? "",
          mode,
          options,
          ...(mode === "sign_install" && account ? { accountId: account.id } : {}),
          ...(autoRefresh === null ? {} : { autoRefresh }),
        });
  const started = unwrap(payload).jobId;
  if (!started) throw new Error("The daemon did not start the job");
  return started;
}

function IosInstall({
  client,
  serverId,
  hostBrowse,
  device,
  accounts,
  jobs,
}: {
  client: DaemonClient;
  serverId: string;
  hostBrowse: boolean;
  device: SideloadDevice | null;
  accounts: SideloadAccountSummary[];
  jobs: Record<string, JobEvent[]>;
}) {
  const [ipa, setIpa] = useState<SideloadIpaInfo | null>(null);
  const [mode, setMode] = useState<Mode>("sign_install");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [options, setOptions] = useState<SideloadOptions>({});
  const [autoRefresh, setAutoRefresh] = useState<boolean | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const account = accounts.find((candidate) => candidate.id === accountId) ?? accounts[0] ?? null;
  const start = useMutation({
    mutationFn: () => startJob({ client, ipa, mode, account, device, options, autoRefresh }),
    onSuccess: setJobId,
  });
  const cancel = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await client.sideloadCall("sideload.install.cancel.request", { jobId: id })),
  });
  const events = jobId ? (jobs[jobId] ?? []) : [];
  const last = events.at(-1) ?? null;
  const waiting = jobId !== null && last === null;
  const running = start.isPending || last?.state === "running" || waiting;
  const ready = canStartJob({ ipa, mode, account, device });

  return (
    <>
      <IpaPicker client={client} serverId={serverId} hostBrowse={hostBrowse} onIpa={setIpa} />
      {ipa ? <IpaCard ipa={ipa} /> : null}
      <View style={styles.card}>
        <Text style={styles.label}>Mode</Text>
        <SegmentedControl options={MODE_OPTIONS} value={mode} onValueChange={setMode} size="sm" />
        {mode === "install_as_is" ? null : (
          <AccountPicker
            accounts={accounts}
            selected={account?.id ?? null}
            onSelect={setAccountId}
          />
        )}
        <View style={styles.start}>
          <ValueButton
            size="sm"
            variant="ghost"
            value={!advanced}
            onValue={setAdvanced}
            testID="sideload-advanced-toggle"
          >
            {advanced ? "Hide advanced options" : "Advanced options"}
          </ValueButton>
        </View>
        {advanced ? (
          <AdvancedOptions
            client={client}
            ipa={ipa}
            options={options}
            onChange={setOptions}
            autoRefresh={autoRefresh ?? account?.kind === "free"}
            onAutoRefresh={setAutoRefresh}
          />
        ) : null}
      </View>
      <StartControls
        start={start}
        cancel={cancel}
        jobId={jobId}
        running={running}
        ready={ready}
        mode={mode}
        hasDevice={device !== null}
      />
      {events.length > 0 ? <JobLog events={events} /> : null}
    </>
  );
}

interface Runnable<TVariables> {
  mutate: (variables: TVariables) => void;
  isPending: boolean;
  variables?: TVariables;
  error: Error | null;
}

function StartControls({
  start,
  cancel,
  jobId,
  running,
  ready,
  mode,
  hasDevice,
}: {
  start: Runnable<void>;
  cancel: Runnable<string>;
  jobId: string | null;
  running: boolean;
  ready: boolean;
  mode: Mode;
  hasDevice: boolean;
}) {
  return (
    <>
      <View style={styles.wrapRow}>
        <MutationButton
          mutation={start}
          variables={undefined}
          disabled={!ready || running}
          testID="sideload-install-run"
        >
          {mode === "export" ? "Export signed IPA" : "Install"}
        </MutationButton>
        {running && jobId ? (
          <MutationButton variant="outline" mutation={cancel} variables={jobId}>
            Cancel
          </MutationButton>
        ) : null}
        {mode !== "export" && !hasDevice ? (
          <Text style={styles.muted}>Choose an iOS device above.</Text>
        ) : null}
      </View>
      {start.error ? (
        <Alert variant="error" title="Could not start" description={errorText(start.error)} />
      ) : null}
    </>
  );
}

function AccountPicker({
  accounts,
  selected,
  onSelect,
}: {
  accounts: SideloadAccountSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>Apple account</Text>
      {accounts.length === 0 ? (
        <Text style={styles.muted}>Add an Apple account in the Accounts tab first.</Text>
      ) : null}
      {accounts.map((candidate) => (
        <AccountChoice
          key={candidate.id}
          account={candidate}
          selected={candidate.id === selected}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

function accountLine(account: SideloadAccountSummary): string {
  const kind = account.kind === "free" ? "Free" : "Paid";
  const left =
    account.appIdsLimit === null
      ? ""
      : ` · ${account.appIdsLimit - account.appIdsUsed} App IDs left this week`;
  const signIn = account.signedIn ? "" : " · sign in again first";
  return `${kind}${left}${signIn}`;
}

function AccountChoice({
  account,
  selected,
  onSelect,
}: {
  account: SideloadAccountSummary;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <View style={selected ? styles.choiceSelected : styles.choice}>
      <View style={selected ? styles.radioOn : styles.radioOff} />
      <View style={styles.grow}>
        <Text style={styles.text} numberOfLines={1}>
          {account.appleId}
        </Text>
        <Text style={styles.muted}>{accountLine(account)}</Text>
      </View>
      <ValueButton size="sm" variant="ghost" value={account.id} onValue={onSelect}>
        Use
      </ValueButton>
    </View>
  );
}

function IpaCard({ ipa }: { ipa: SideloadIpaInfo }) {
  const extensions = ipa.extensions.map((extension) => extension.name).join(", ");
  return (
    <View style={styles.card} testID="sideload-ipa-card">
      <Text style={styles.title}>{ipa.name}</Text>
      <Text style={styles.mono}>
        {ipa.bundleId} · {ipa.version} · iOS {ipa.minimumOs ?? "?"}+ ·{" "}
        {ipa.architectures.join(", ")} · {(ipa.sizeBytes / 1_048_576).toFixed(2)} MB
      </Text>
      {ipa.extensions.length > 0 ? (
        <Text style={styles.muted}>Extensions (each needs an App ID): {extensions}</Text>
      ) : null}
      {ipa.encrypted ? (
        <Alert
          variant="error"
          title="Encrypted IPA"
          description="This IPA is still FairPlay-encrypted (App Store copy). It will not run after re-signing; use a decrypted IPA."
        />
      ) : null}
    </View>
  );
}

type TextOption = "appName" | "bundleId" | "minimumOs";
type FlagOption = "removeDeviceRestrictions" | "fileSharing" | "removeAllExtensions";

function OptionText({
  name,
  label,
  placeholder,
  value,
  onOption,
}: {
  name: TextOption;
  label: string;
  placeholder: string;
  value: string;
  onOption: (name: TextOption, value: string) => void;
}) {
  const change = useCallback((text: string) => onOption(name, text), [name, onOption]);
  return (
    <View style={styles.field}>
      <Text style={styles.text}>{label}</Text>
      <AdaptiveTextInput
        initialValue={value}
        onChangeText={change}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        testID={`sideload-option-${name}`}
      />
    </View>
  );
}

function SwitchRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.rowBetween}>
      <View style={styles.grow}>
        <Text style={styles.text}>{label}</Text>
        {hint ? <Text style={styles.muted}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function useOptionSetters(
  onChange: (update: (previous: SideloadOptions) => SideloadOptions) => void,
) {
  const setText = useCallback(
    (name: TextOption, value: string) =>
      onChange((previous) => ({ ...previous, [name]: value.trim() === "" ? undefined : value })),
    [onChange],
  );
  const setFlag = useCallback(
    (name: FlagOption, value: boolean) =>
      onChange((previous) => {
        if (name === "removeAllExtensions") {
          return { ...previous, removeExtensions: value ? "all" : [] };
        }
        return { ...previous, [name]: value };
      }),
    [onChange],
  );
  const keepExtension = useCallback(
    (bundleId: string, keep: boolean) =>
      onChange((previous) => {
        const removed = Array.isArray(previous.removeExtensions) ? previous.removeExtensions : [];
        const next = keep ? removed.filter((id) => id !== bundleId) : [...removed, bundleId];
        return { ...previous, removeExtensions: next };
      }),
    [onChange],
  );
  return { setText, setFlag, keepExtension };
}

function useOptionUploads(
  client: DaemonClient,
  onChange: (update: (previous: SideloadOptions) => SideloadOptions) => void,
) {
  const { pickFiles } = useFilePicker();
  return useMutation({
    mutationFn: async (target: "icon" | "inject") => {
      const files = (await pickFiles()) ?? [];
      const paths: string[] = [];
      for (const file of files) {
        const uploaded = await client.uploadFile({
          fileName: file.fileName,
          mimeType: file.mimeType,
          bytes: await file.readBytes(),
        });
        if (uploaded.error || !uploaded.file) {
          throw new Error(uploaded.error ?? `Uploading ${file.fileName} failed`);
        }
        paths.push(uploaded.file.path);
      }
      return { target, paths };
    },
    onSuccess: ({ target, paths }) =>
      onChange((previous) => {
        if (target === "icon") return paths[0] ? { ...previous, iconPath: paths[0] } : previous;
        return { ...previous, inject: [...(previous.inject ?? []), ...paths] };
      }),
  });
}

function AdvancedOptions({
  client,
  ipa,
  options,
  onChange,
  autoRefresh,
  onAutoRefresh,
}: {
  client: DaemonClient;
  ipa: SideloadIpaInfo | null;
  options: SideloadOptions;
  onChange: (update: (previous: SideloadOptions) => SideloadOptions) => void;
  autoRefresh: boolean;
  onAutoRefresh: (value: boolean) => void;
}) {
  const { setText, setFlag, keepExtension } = useOptionSetters(onChange);
  const uploads = useOptionUploads(client, onChange);
  const removeAll = options.removeExtensions === "all";
  const removed = Array.isArray(options.removeExtensions) ? options.removeExtensions : [];
  const injected = (options.inject ?? []).map((file) => file.split(/[\\/]/).pop()).join(", ");
  const bundlePlaceholder = ipa ? `${ipa.bundleId} (change to install a second copy)` : "Bundle ID";
  return (
    <View style={styles.field} testID="sideload-advanced">
      <OptionText
        name="appName"
        label="App name"
        placeholder={ipa?.name ?? "Name on the home screen"}
        value={options.appName ?? ""}
        onOption={setText}
      />
      <OptionText
        name="bundleId"
        label="Bundle ID"
        placeholder={bundlePlaceholder}
        value={options.bundleId ?? ""}
        onOption={setText}
      />
      <OptionText
        name="minimumOs"
        label="Minimum iOS"
        placeholder={ipa?.minimumOs ?? "e.g. 15.0"}
        value={options.minimumOs ?? ""}
        onOption={setText}
      />
      <SwitchRow label="Remove device restrictions" hint="Drops UISupportedDevices">
        <KeyedSwitch
          name="removeDeviceRestrictions"
          value={options.removeDeviceRestrictions === true}
          onToggle={setFlag}
          label="Remove device restrictions"
        />
      </SwitchRow>
      <SwitchRow label="File sharing" hint="Shows the app’s Documents in Files and on the computer">
        <KeyedSwitch
          name="fileSharing"
          value={options.fileSharing === true}
          onToggle={setFlag}
          label="File sharing"
        />
      </SwitchRow>
      <SwitchRow label="Remove all extensions" hint="Each extension costs an App ID">
        <KeyedSwitch
          name="removeAllExtensions"
          value={removeAll}
          onToggle={setFlag}
          label="Remove all extensions"
        />
      </SwitchRow>
      {!removeAll && ipa
        ? ipa.extensions.map((extension) => (
            <SwitchRow key={extension.bundleId} label={`Keep ${extension.name}`}>
              <KeyedSwitch
                name={extension.bundleId}
                value={!removed.includes(extension.bundleId)}
                onToggle={keepExtension}
                label={`Keep ${extension.name}`}
              />
            </SwitchRow>
          ))
        : null}
      <SwitchRow
        label="Auto refresh"
        hint="Re-sign before it expires (on by default for free accounts)"
      >
        <Switch
          value={autoRefresh}
          onValueChange={onAutoRefresh}
          accessibilityLabel="Auto refresh"
        />
      </SwitchRow>
      <View style={styles.rowBetween}>
        <Text style={styles.text}>App icon {options.iconPath ? "· chosen" : ""}</Text>
        <MutationButton size="sm" variant="outline" mutation={uploads} variables="icon">
          Choose PNG…
        </MutationButton>
      </View>
      <View style={styles.rowBetween}>
        <View style={styles.grow}>
          <Text style={styles.text}>Inject</Text>
          <Text style={styles.muted}>{injected || ".dylib, .framework, .bundle or .deb"}</Text>
        </View>
        <MutationButton size="sm" variant="outline" mutation={uploads} variables="inject">
          Add files…
        </MutationButton>
      </View>
      {uploads.error ? <Text style={styles.errorText}>{errorText(uploads.error)}</Text> : null}
    </View>
  );
}

function jobTitle(last: SideloadInstallProgress): string {
  if (last.state === "running") return `${STEP_LABELS[last.step]}…`;
  return last.state === "done" ? "Done" : "Stopped";
}

function stepMark(input: { failed: boolean; running: boolean }): string {
  if (input.failed) return "✕";
  return input.running ? "…" : "✓";
}

function JobOutcome({ last, show }: { last: JobEvent; show: (text: string) => string }) {
  if (last.state === "failed" || last.state === "cancelled") {
    return <Alert variant="error" title={last.code ?? "failed"} description={show(last.message)} />;
  }
  if (last.state !== "done") return null;
  if (last.outputPath) {
    return (
      <Text style={styles.successText}>Signed IPA saved on the host: {show(last.outputPath)}</Text>
    );
  }
  return (
    <Text style={styles.successText}>
      Installed. On the device, trust the developer in Settings → General → VPN & Device Management,
      then open the app.
    </Text>
  );
}

function JobLog({ events }: { events: JobEvent[] }) {
  const [hide, setHide] = useState(false);
  const last = events.at(-1)!;
  const steps = useMemo(() => {
    const seen: SideloadInstallProgress["step"][] = [];
    for (const event of events) if (!seen.includes(event.step)) seen.push(event.step);
    return seen;
  }, [events]);
  const show = useCallback((text: string) => (hide ? maskSensitive(text) : text), [hide]);
  const stopped = last.state === "failed" || last.state === "cancelled";
  const progressStyle = useMemo(
    () => [styles.progressFill, { width: `${last.percent ?? 0}%` as const }],
    [last.percent],
  );
  return (
    <View style={styles.card} testID="sideload-job">
      <View style={styles.rowBetween}>
        <Text style={styles.label}>{jobTitle(last)}</Text>
        <View style={styles.row}>
          <Text style={styles.muted}>Hide sensitive info</Text>
          <Switch value={hide} onValueChange={setHide} accessibilityLabel="Hide sensitive info" />
        </View>
      </View>
      <View style={styles.wrapRow}>
        {steps.map((step) => {
          const current = step === last.step;
          const failed = current && stopped;
          const mark = stepMark({ failed, running: current && last.state === "running" });
          return (
            <Text key={step} style={failed ? styles.errorText : styles.muted}>
              {`${mark} ${STEP_LABELS[step]}`}
            </Text>
          );
        })}
      </View>
      {last.percent !== null && last.state === "running" ? (
        <View style={styles.progressTrack}>
          <View style={progressStyle} />
        </View>
      ) : null}
      <JobOutcome last={last} show={show} />
      <View style={styles.logBox}>
        {events.map((event) => (
          <Text key={event.seq} style={styles.mono}>
            {show(`${STEP_LABELS[event.step]}: ${event.message}`)}
          </Text>
        ))}
      </View>
    </View>
  );
}
