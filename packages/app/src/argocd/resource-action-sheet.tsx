import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  ArgoCdAppRef,
  ArgoCdResourceAction,
  ArgoCdResourceRef,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done" }
  | { status: "failed"; message: string };

function ParamField({
  name,
  type,
  onChange,
}: {
  name: string;
  type: string | null;
  onChange: (name: string, value: string) => void;
}) {
  const handleChange = useCallback((value: string) => onChange(name, value), [name, onChange]);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{type ? `${name} (${type})` : name}</Text>
      <AdaptiveTextInput
        style={styles.input}
        initialValue=""
        onChangeText={handleChange}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={name}
      />
    </View>
  );
}

/** Confirms and runs one resource action (restart, scale, …) with its parameters. */
export function ArgoCdResourceActionSheet({
  serverId,
  instanceId,
  app,
  resource,
  action,
  onClose,
}: {
  serverId: string;
  instanceId: string;
  app: ArgoCdAppRef;
  resource: ArgoCdResourceRef;
  action: ArgoCdResourceAction;
  onClose: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const label = action.displayName ?? action.name;
  const header = useMemo<SheetHeader>(
    () => ({ title: `Run ${label}`, subtitle: `${resource.kind} ${resource.name}` }),
    [label, resource.kind, resource.name],
  );

  const handleParam = useCallback(
    (name: string, value: string) => setValues((current) => ({ ...current, [name]: value })),
    [],
  );
  const handleRun = useCallback(async () => {
    if (!client) {
      setRun({ status: "failed", message: "The host is not connected." });
      return;
    }
    setRun({ status: "running" });
    try {
      const payload = await client.argocd("argocd.app.resource_action.request", {
        instanceId,
        app,
        resource,
        action: action.name,
        params: action.params.map((param) => ({
          name: param.name,
          value: values[param.name] ?? "",
        })),
      });
      setRun(payload.error ? { status: "failed", message: payload.error } : { status: "done" });
    } catch (error) {
      setRun({
        status: "failed",
        message: error instanceof Error ? error.message : "Unable to run the action",
      });
    }
  }, [action, app, client, instanceId, resource, values]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID="argocd-resource-action-sheet"
    >
      <Text style={styles.body}>
        {`Argo CD runs the "${label}" action on ${resource.kind} ${resource.namespace ? `${resource.namespace}/` : ""}${resource.name}.`}
      </Text>
      {action.params.map((param) => (
        <ParamField key={param.name} name={param.name} type={param.type} onChange={handleParam} />
      ))}
      {run.status === "failed" ? (
        <Alert variant="error" title="Unable to run the action" description={run.message} />
      ) : null}
      {run.status === "done" ? (
        <Alert
          variant="success"
          title={`${label} started`}
          description="Argo CD accepted the action."
        />
      ) : null}
      <View style={styles.actions}>
        <Button style={styles.flex} variant="secondary" onPress={onClose}>
          {run.status === "done" ? "Close" : "Cancel"}
        </Button>
        {run.status === "done" ? null : (
          <Button
            style={styles.flex}
            variant="default"
            onPress={handleRun}
            loading={run.status === "running"}
            disabled={run.status === "running"}
            testID="argocd-resource-action-run"
          >
            {run.status === "running" ? "Running..." : "Run"}
          </Button>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  field: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  flex: {
    flex: 1,
  },
}));
