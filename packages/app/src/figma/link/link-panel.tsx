import { default as React, useCallback, useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import type { FigmaLinkStatus } from "@jagentdesk/protocol/figma/rpc-schemas";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { callFigma, errorMessage } from "@/figma/api";
import {
  CopyButton,
  DisclosureRow,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  SectionHeading,
  Spinner,
} from "@/figma/ui/primitives";
import { figmaStyles } from "@/figma/ui/styles";
import { useFigmaLinkPushInvalidator, useFigmaLinkStatus } from "@/figma/queries";

// The Figma Link panel (spec 32.4): the daemon-side WebSocket server state, the plugin import
// path, connected files, the 6-digit pairing code, revoke, and the run_script setting with its
// warning. State comes from figma.link.status and refreshes on figma.link.changed pushes.

const CODE_PATTERN = /^\d{6}$/;

function serverStateLine(status: FigmaLinkStatus): { label: string; ok: boolean } {
  if (status.server === "listening") return { label: `Listening on port ${status.port}`, ok: true };
  if (status.server === "port_in_use")
    return { label: `Port ${status.port} is in use by another app`, ok: false };
  return { label: "Stopped", ok: false };
}

export function FigmaLinkPanel({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const status = useFigmaLinkStatus(serverId);
  useFigmaLinkPushInvalidator(serverId);
  const [code, setCode] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        status.refetch();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [status],
  );

  const pair = useCallback(
    () => run(() => callFigma(client, "figma.link.pair.request", { code })),
    [client, code, run],
  );
  const revoke = useCallback(
    () => run(() => callFigma(client, "figma.link.revoke.request", {})),
    [client, run],
  );
  const toggleRunScript = useCallback(
    (next: boolean) =>
      run(() => callFigma(client, "figma.link.settings.request", { runScriptEnabled: next })),
    [client, run],
  );
  const changeCode = useCallback(
    (text: string) => setCode(text.replace(/[^\d]/g, "").slice(0, 6)),
    [],
  );
  const onPair = useCallback(() => {
    void pair();
  }, [pair]);
  const onRevoke = useCallback(() => {
    void revoke();
  }, [revoke]);
  const onToggleRunScript = useCallback(
    (next: boolean) => {
      void toggleRunScript(next);
    },
    [toggleRunScript],
  );
  const toggleImport = useCallback(() => setImportOpen((open) => !open), []);

  if (status.isLoading) return <Spinner testID="figma-link-loading" />;
  if (status.error) return <ErrorBanner message={errorMessage(status.error)} />;
  const current = status.data;
  if (!current) return <EmptyState title="Figma Link is unavailable on this host." />;

  const state = serverStateLine(current);
  const linked = current.files.filter((file) => file.paired);

  return (
    <ScrollView
      style={figmaStyles.screen}
      contentContainerStyle={figmaStyles.scrollContent}
      testID="figma-link-panel"
    >
      <View style={figmaStyles.card} testID="figma-link-server">
        <SectionHeading
          title="Server"
          hint="The daemon exposes a local WebSocket the Figma plugin connects to."
        />
        <View style={figmaStyles.row}>
          <View
            style={state.ok ? figmaStyles.dotOk : figmaStyles.dotWarn}
            testID="figma-link-server-dot"
          />
          <Text style={figmaStyles.rowTitle}>{state.label}</Text>
        </View>
        {current.server === "port_in_use" ? (
          <Text style={figmaStyles.rowSubtle}>
            Close the other app holding the port, or restart the daemon.
          </Text>
        ) : null}
      </View>

      <View style={figmaStyles.card} testID="figma-link-plugin">
        <SectionHeading title="Plugin" />
        <Text style={figmaStyles.rowTitle} testID="figma-link-plugin-state">
          {current.pluginInstalled
            ? `Installed${current.pluginVersion ? ` · v${current.pluginVersion}` : ""}`
            : "Not installed"}
        </Text>
        {current.manifestPath ? (
          <View style={figmaStyles.rowBetween} testID="figma-link-manifest">
            <Text style={figmaStyles.mono} numberOfLines={1}>
              {current.manifestPath}
            </Text>
            <CopyButton
              value={current.manifestPath}
              label="Copy"
              testID="figma-link-manifest-copy"
            />
          </View>
        ) : (
          <Text style={figmaStyles.rowSubtle}>
            The manifest path is only available on the host machine.
          </Text>
        )}
        <DisclosureRow
          expanded={importOpen}
          onToggle={toggleImport}
          title="How to import in Figma Desktop"
          testID="figma-link-import-toggle"
        />
        {importOpen ? (
          <View style={figmaStyles.section} testID="figma-link-import-steps">
            <Text style={figmaStyles.guideBody}>
              1. In Figma Desktop open Plugins → Development → Import plugin from manifest.
            </Text>
            <Text style={figmaStyles.guideBody}>
              2. Choose the manifest file served by JAgentDesk on this machine.
            </Text>
          </View>
        ) : null}
      </View>

      <View style={figmaStyles.card} testID="figma-link-pair">
        <SectionHeading
          title="Pair a file"
          hint="Open the JAgentDesk plugin in Figma, copy the 6-digit code it shows, and enter it here."
        />
        {current.pendingPairing ? (
          <Text style={figmaStyles.rowSubtle}>
            {current.pendingPairing.fileName} is waiting for a pairing code.
          </Text>
        ) : null}
        <Field label="Pairing code">
          <Input
            value={code}
            onChangeText={changeCode}
            placeholder="6-digit code"
            keyboardType="number-pad"
            maxLength={6}
            testID="figma-link-code"
          />
        </Field>
        <View style={figmaStyles.row}>
          <Button
            variant="default"
            disabled={!CODE_PATTERN.test(code) || busy}
            loading={busy}
            onPress={onPair}
            testID="figma-link-pair-button"
          >
            Pair
          </Button>
          <Button variant="outline" disabled={busy} onPress={onRevoke} testID="figma-link-revoke">
            Revoke
          </Button>
        </View>
        {error ? <ErrorBanner message={error} /> : null}
      </View>

      <View style={figmaStyles.card} testID="figma-link-files">
        <SectionHeading title="Connected files" />
        {linked.length === 0 ? (
          <Text style={figmaStyles.rowSubtle}>No files are linked right now.</Text>
        ) : (
          linked.map((file) => (
            <View
              key={file.fileKey}
              style={figmaStyles.rowBetween}
              testID={`figma-link-file-${file.fileKey}`}
            >
              <View style={figmaStyles.flex1}>
                <Text style={figmaStyles.rowTitle} numberOfLines={1}>
                  {file.fileName}
                </Text>
                <Text style={figmaStyles.rowSubtle}>
                  {[file.pageName, `plugin v${file.pluginVersion}`].filter(Boolean).join(" · ")}
                </Text>
              </View>
            </View>
          ))
        )}
      </View>

      <View style={figmaStyles.card} testID="figma-link-run-script">
        <SectionHeading
          title="Run script"
          hint="With Run script enabled, the plugin applies edits from JAgentDesk immediately. Keep it off only if the plugin’s own scripting conflicts."
        />
        <View style={figmaStyles.rowBetween}>
          <Text style={figmaStyles.rowTitle}>
            {current.runScriptEnabled ? "Enabled" : "Disabled"}
          </Text>
          <Switch
            value={current.runScriptEnabled}
            onValueChange={onToggleRunScript}
            testID="figma-link-run-script-toggle"
          />
        </View>
        {!current.runScriptEnabled ? (
          <Text style={figmaStyles.rowSubtle} testID="figma-link-run-script-warning">
            Without Run script, edits queue until the plugin runs them — the pending bar stays
            filled while you wait.
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}
