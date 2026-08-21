import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useOrchestration } from "@/hooks/use-orchestration";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type {
  OrchestrationConfig,
  OrchestrationProfile,
  OrchestrationRole,
  OrchestrationRouteCategory,
  OrchestrationRouteTarget,
} from "@jagentdesk/protocol/orchestration";
import {
  defaultRoleInstructions,
  defaultRouteInstructions,
} from "@jagentdesk/protocol/orchestration";

const BUILTIN_ROLE_IDS = ["supervisor", "lead", "peer"];
function isBuiltinRoleId(role: string): boolean {
  return BUILTIN_ROLE_IDS.includes(role);
}

const ROUTE_ORDER: OrchestrationRouteCategory[] = [
  "planning",
  "impl",
  "impl_deep",
  "search",
  "research",
  "audit",
  "ui",
];

const CUSTOM_OPTION: SelectFieldOption<string> = {
  id: "__custom__",
  value: "__custom__",
  label: "Custom…",
};

interface OrchestrationPageProps {
  serverId: string;
}

interface ProfileModalProps {
  visible: boolean;
  role: OrchestrationRole;
  serverId: string;
  onClose: () => void;
  onSave: (profile: OrchestrationProfile) => Promise<void>;
}

interface AddRoleModalProps {
  visible: boolean;
  serverId: string;
  existingRoleIds: string[];
  onClose: () => void;
  onSave: (roleId: string, label: string, firstProfile: OrchestrationProfile) => Promise<void>;
}

function ProfileModal({ visible, role, serverId, onClose, onSave }: ProfileModalProps) {
  const providersSnapshot = useProvidersSnapshot(serverId);
  const [label, setLabel] = useState("");
  const [providerSelection, setProviderSelection] = useState("");
  const [customProvider, setCustomProvider] = useState("");
  const [modelSelection, setModelSelection] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [thinking, setThinking] = useState("max");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (visible) {
      setLabel("");
      setProviderSelection("");
      setCustomProvider("");
      setModelSelection("");
      setCustomModel("");
      setThinking("max");
      setError(null);
      setPending(false);
    }
  }, [visible]);

  const resolvedProvider = (
    providerSelection === CUSTOM_OPTION.value ? customProvider : providerSelection
  ).trim();

  const providerOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const installed = (providersSnapshot.entries ?? []).map((entry) => ({
      id: entry.provider,
      value: entry.provider,
      label: entry.label ?? entry.provider,
    }));
    return [...installed, CUSTOM_OPTION];
  }, [providersSnapshot.entries]);

  const selectedEntry = providersSnapshot.entries?.find(
    (entry) => entry.provider === resolvedProvider,
  );

  const selectedProviderStatus = selectedEntry?.status;
  const providerHasModels = Boolean(selectedEntry?.models?.length);
  const isCustomProvider = providerSelection === CUSTOM_OPTION.value;
  // Model detection on the daemon is lazy; while it runs the provider reports
  // `loading`. Show a detecting state during that window instead of forcing
  // manual entry.
  const isDetectingModels =
    !isCustomProvider &&
    providerSelection !== "" &&
    !providerHasModels &&
    (selectedProviderStatus === "loading" || providersSnapshot.isRefreshing);
  // Only fall back to a free-text model id once detection has finished and the
  // provider genuinely exposes no models (or it is a custom provider).
  const useFreeformModel =
    !isCustomProvider && providerSelection !== "" && !isDetectingModels && !providerHasModels;
  const modelStatusHint =
    selectedProviderStatus && selectedProviderStatus !== "ready"
      ? `Provider status: ${selectedProviderStatus}. It may not be installed on this host — enter a model id manually.`
      : "No models were detected for this provider — enter a model id manually.";

  // Trigger provider detection when a concrete provider is selected so the model
  // dropdown populates instead of defaulting to manual entry.
  const refreshProviders = providersSnapshot.refresh;
  useEffect(() => {
    if (visible && resolvedProvider && !isCustomProvider) {
      void refreshProviders();
    }
  }, [visible, resolvedProvider, isCustomProvider, refreshProviders]);

  const resolvedModel = (
    useFreeformModel || modelSelection === CUSTOM_OPTION.value ? customModel : modelSelection
  ).trim();

  const modelOptions = useMemo<SelectFieldOption<string>[]>(() => {
    if (providerSelection === CUSTOM_OPTION.value || !selectedEntry?.models?.length) {
      return [CUSTOM_OPTION];
    }
    const models = selectedEntry.models.map((model) => ({
      id: model.id,
      value: model.id,
      label: model.label ?? model.id,
    }));
    return [...models, CUSTOM_OPTION];
  }, [providerSelection, selectedEntry]);

  const providerDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (!providerSelection) return null;
    const option = providerOptions.find((candidate) => candidate.value === providerSelection);
    return option ? { label: option.label } : { label: providerSelection };
  }, [providerOptions, providerSelection]);

  const modelDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (!modelSelection) return null;
    const option = modelOptions.find((candidate) => candidate.value === modelSelection);
    return option ? { label: option.label } : { label: modelSelection };
  }, [modelOptions, modelSelection]);

  const handleProviderChange = useCallback((value: string) => {
    setProviderSelection(value);
    setModelSelection("");
    setCustomModel("");
  }, []);

  const handleSave = useCallback(async () => {
    const normalizedProvider = resolvedProvider;
    const normalizedModel = resolvedModel;
    if (!normalizedProvider || !normalizedModel) {
      setError("Provider and model are required.");
      return;
    }
    const slug = `${role}-${normalizedProvider}-${normalizedModel}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    setPending(true);
    setError(null);
    try {
      await onSave({
        id: `${slug}-${Date.now()}`,
        label: label.trim() || `${normalizedProvider}/${normalizedModel}`,
        provider: normalizedProvider,
        model: normalizedModel,
        thinkingOptionId: thinking.trim() || "max",
        enabled: true,
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save profile.");
    } finally {
      setPending(false);
    }
  }, [label, onClose, onSave, resolvedModel, resolvedProvider, role, thinking]);

  const header = useMemo<SheetHeader>(() => ({ title: `Add ${role} profile` }), [role]);

  return (
    <AdaptiveModalSheet visible={visible} header={header} onClose={onClose} desktopMaxWidth={520}>
      <View style={styles.modalBody} testID="orchestration-profile-modal">
        <Field label="Label">
          <FormTextInput
            value={label}
            onChangeText={setLabel}
            editable={!pending}
            testID="orchestration-profile-label"
          />
        </Field>
        <SelectField
          label="Provider"
          hint="Use an installed provider id from Host > Providers."
          value={providerSelection || null}
          selectedDisplay={providerDisplay}
          options={providerOptions}
          onChange={handleProviderChange}
          disabled={pending}
          placeholder="Choose a provider"
          emptyText="No providers installed"
          testID="orchestration-profile-provider-select"
        />
        {providerSelection === CUSTOM_OPTION.value ? (
          <FormTextInput
            value={customProvider}
            onChangeText={setCustomProvider}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            testID="orchestration-profile-provider"
          />
        ) : null}
        {isDetectingModels ? (
          <Field label="Model" hint="Detecting available models on this host…">
            <Text style={settingsStyles.rowHint} testID="orchestration-profile-model-detecting">
              Detecting available models…
            </Text>
          </Field>
        ) : useFreeformModel ? (
          <Field label="Model" hint={modelStatusHint}>
            <FormTextInput
              value={customModel}
              onChangeText={setCustomModel}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!pending}
              placeholder="Enter a model id"
              testID="orchestration-profile-model"
            />
          </Field>
        ) : (
          <>
            <SelectField
              label="Model"
              value={modelSelection || null}
              selectedDisplay={modelDisplay}
              options={modelOptions}
              onChange={(value) => setModelSelection(value)}
              disabled={pending}
              placeholder="Choose a model"
              emptyText="No models available"
              testID="orchestration-profile-model-select"
            />
            {modelSelection === CUSTOM_OPTION.value ? (
              <FormTextInput
                value={customModel}
                onChangeText={setCustomModel}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!pending}
                testID="orchestration-profile-model"
              />
            ) : null}
          </>
        )}
        <Field label="Thinking option" hint="Passed to the provider runtime exactly as configured.">
          <FormTextInput
            value={thinking}
            onChangeText={setThinking}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            testID="orchestration-profile-thinking"
          />
        </Field>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>
          <Button variant="secondary" onPress={onClose} disabled={pending} style={styles.action}>
            Cancel
          </Button>
          <Button
            variant="default"
            onPress={() => void handleSave()}
            loading={pending}
            style={styles.action}
            testID="orchestration-profile-save"
          >
            Save profile
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function AddRoleModal({ visible, serverId, existingRoleIds, onClose, onSave }: AddRoleModalProps) {
  const providersSnapshot = useProvidersSnapshot(serverId);
  const [roleName, setRoleName] = useState("");
  const [label, setLabel] = useState("");
  const [providerSelection, setProviderSelection] = useState("");
  const [customProvider, setCustomProvider] = useState("");
  const [modelSelection, setModelSelection] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [thinking, setThinking] = useState("max");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (visible) {
      setRoleName("");
      setLabel("");
      setProviderSelection("");
      setCustomProvider("");
      setModelSelection("");
      setCustomModel("");
      setThinking("max");
      setError(null);
      setPending(false);
    }
  }, [visible]);

  const resolvedProvider = (
    providerSelection === CUSTOM_OPTION.value ? customProvider : providerSelection
  ).trim();

  const providerOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const installed = (providersSnapshot.entries ?? []).map((entry) => ({
      id: entry.provider,
      value: entry.provider,
      label: entry.label ?? entry.provider,
    }));
    return [...installed, CUSTOM_OPTION];
  }, [providersSnapshot.entries]);

  const selectedEntry = providersSnapshot.entries?.find(
    (entry) => entry.provider === resolvedProvider,
  );

  const selectedProviderStatus = selectedEntry?.status;
  const providerHasModels = Boolean(selectedEntry?.models?.length);
  const isCustomProvider = providerSelection === CUSTOM_OPTION.value;
  // Model detection on the daemon is lazy; while it runs the provider reports
  // `loading`. Show a detecting state during that window instead of forcing
  // manual entry.
  const isDetectingModels =
    !isCustomProvider &&
    providerSelection !== "" &&
    !providerHasModels &&
    (selectedProviderStatus === "loading" || providersSnapshot.isRefreshing);
  // Only fall back to a free-text model id once detection has finished and the
  // provider genuinely exposes no models (or it is a custom provider).
  const useFreeformModel =
    !isCustomProvider && providerSelection !== "" && !isDetectingModels && !providerHasModels;
  const modelStatusHint =
    selectedProviderStatus && selectedProviderStatus !== "ready"
      ? `Provider status: ${selectedProviderStatus}. It may not be installed on this host — enter a model id manually.`
      : "No models were detected for this provider — enter a model id manually.";

  // Trigger provider detection when a concrete provider is selected so the model
  // dropdown populates instead of defaulting to manual entry.
  const refreshProviders = providersSnapshot.refresh;
  useEffect(() => {
    if (visible && resolvedProvider && !isCustomProvider) {
      void refreshProviders();
    }
  }, [visible, resolvedProvider, isCustomProvider, refreshProviders]);

  const resolvedModel = (
    useFreeformModel || modelSelection === CUSTOM_OPTION.value ? customModel : modelSelection
  ).trim();

  const modelOptions = useMemo<SelectFieldOption<string>[]>(() => {
    if (providerSelection === CUSTOM_OPTION.value || !selectedEntry?.models?.length) {
      return [CUSTOM_OPTION];
    }
    const models = selectedEntry.models.map((model) => ({
      id: model.id,
      value: model.id,
      label: model.label ?? model.id,
    }));
    return [...models, CUSTOM_OPTION];
  }, [providerSelection, selectedEntry]);

  const providerDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (!providerSelection) return null;
    const option = providerOptions.find((candidate) => candidate.value === providerSelection);
    return option ? { label: option.label } : { label: providerSelection };
  }, [providerOptions, providerSelection]);

  const modelDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (!modelSelection) return null;
    const option = modelOptions.find((candidate) => candidate.value === modelSelection);
    return option ? { label: option.label } : { label: modelSelection };
  }, [modelOptions, modelSelection]);

  const handleProviderChange = useCallback((value: string) => {
    setProviderSelection(value);
    setModelSelection("");
    setCustomModel("");
  }, []);

  const handleModelChange = useCallback((value: string) => {
    setModelSelection(value);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmedRoleName = roleName.trim();
    const roleId = trimmedRoleName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (!trimmedRoleName) {
      setError("Role name is required.");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(trimmedRoleName)) {
      setError("Role name may only contain letters, numbers, and dashes.");
      return;
    }
    if (isBuiltinRoleId(roleId)) {
      setError("That role name is a built-in role.");
      return;
    }
    if (existingRoleIds.includes(roleId)) {
      setError("A role with that name already exists.");
      return;
    }
    const normalizedProvider = resolvedProvider;
    const normalizedModel = resolvedModel;
    if (!normalizedProvider || !normalizedModel) {
      setError("Provider and model are required.");
      return;
    }
    const slug = `${roleId}-${normalizedProvider}-${normalizedModel}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    setPending(true);
    setError(null);
    try {
      await onSave(roleId, label, {
        id: `${slug}-${Date.now()}`,
        label: label.trim() || `${normalizedProvider}/${normalizedModel}`,
        provider: normalizedProvider,
        model: normalizedModel,
        thinkingOptionId: thinking.trim() || "max",
        enabled: true,
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to add role.");
    } finally {
      setPending(false);
    }
  }, [
    existingRoleIds,
    label,
    onClose,
    onSave,
    resolvedModel,
    resolvedProvider,
    roleName,
    thinking,
  ]);

  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  const header = useMemo<SheetHeader>(() => ({ title: "Add custom role" }), []);

  return (
    <AdaptiveModalSheet visible={visible} header={header} onClose={onClose} desktopMaxWidth={520}>
      <View style={styles.modalBody} testID="orchestration-add-role-modal">
        <Field label="Role name">
          <FormTextInput
            value={roleName}
            onChangeText={setRoleName}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            testID="orchestration-role-name"
          />
        </Field>
        <Field label="Label">
          <FormTextInput
            value={label}
            onChangeText={setLabel}
            editable={!pending}
            testID="orchestration-role-label"
          />
        </Field>
        <SelectField
          label="Provider"
          hint="Use an installed provider id from Host > Providers."
          value={providerSelection || null}
          selectedDisplay={providerDisplay}
          options={providerOptions}
          onChange={handleProviderChange}
          disabled={pending}
          placeholder="Choose a provider"
          emptyText="No providers installed"
          testID="orchestration-role-provider-select"
        />
        {providerSelection === CUSTOM_OPTION.value ? (
          <FormTextInput
            value={customProvider}
            onChangeText={setCustomProvider}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            testID="orchestration-role-provider"
          />
        ) : null}
        {isDetectingModels ? (
          <Field label="Model" hint="Detecting available models on this host…">
            <Text style={settingsStyles.rowHint} testID="orchestration-role-model-detecting">
              Detecting available models…
            </Text>
          </Field>
        ) : useFreeformModel ? (
          <Field label="Model" hint={modelStatusHint}>
            <FormTextInput
              value={customModel}
              onChangeText={setCustomModel}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!pending}
              placeholder="Enter a model id"
              testID="orchestration-role-model"
            />
          </Field>
        ) : (
          <>
            <SelectField
              label="Model"
              value={modelSelection || null}
              selectedDisplay={modelDisplay}
              options={modelOptions}
              onChange={handleModelChange}
              disabled={pending}
              placeholder="Choose a model"
              emptyText="No models available"
              testID="orchestration-role-model-select"
            />
            {modelSelection === CUSTOM_OPTION.value ? (
              <FormTextInput
                value={customModel}
                onChangeText={setCustomModel}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!pending}
                testID="orchestration-role-model"
              />
            ) : null}
          </>
        )}
        <Field label="Thinking option" hint="Passed to the provider runtime exactly as configured.">
          <FormTextInput
            value={thinking}
            onChangeText={setThinking}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            testID="orchestration-role-thinking"
          />
        </Field>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>
          <Button variant="secondary" onPress={onClose} disabled={pending} style={styles.action}>
            Cancel
          </Button>
          <Button
            variant="default"
            onPress={handleSavePress}
            loading={pending}
            style={styles.action}
            testID="orchestration-role-save"
          >
            Save role
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function findProfile(
  config: OrchestrationConfig,
  target: OrchestrationRouteTarget,
): OrchestrationProfile | null {
  return (
    config.roles[target.role].profiles.find((profile) => profile.id === target.profileId) ?? null
  );
}

function routeLabel(route: OrchestrationRouteCategory): string {
  return route.replace("_", " ").replace(/^[a-z]/, (value) => value.toUpperCase());
}

interface InstructionsFieldProps {
  label: string;
  hint?: string;
  value: string | undefined;
  placeholder?: string;
  testID: string;
  onSave: (value: string) => void;
}

function InstructionsField({
  label,
  hint,
  value,
  placeholder,
  testID,
  onSave,
}: InstructionsFieldProps) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);
  const handleBlur = useCallback(() => {
    const next = draft.trim();
    if (next !== (value ?? "").trim()) {
      onSave(next);
    }
  }, [draft, onSave, value]);
  return (
    <Field label={label} hint={hint}>
      <FormTextInput
        initialValue={value ?? ""}
        resetKey={value ?? ""}
        onChangeText={setDraft}
        onBlur={handleBlur}
        placeholder={placeholder}
        multiline
        numberOfLines={4}
        testID={testID}
      />
    </Field>
  );
}

interface RoleHeaderProps {
  role: string;
  label: string;
  isCustom: boolean;
  enabled: boolean;
  onToggle: (
    role: OrchestrationRole,
    patch: Partial<OrchestrationConfig["roles"][OrchestrationRole]>,
  ) => void;
  onRemove: (role: string) => void;
}

function RoleHeader({ role, label, isCustom, enabled, onToggle, onRemove }: RoleHeaderProps) {
  const handleToggle = useCallback(
    (value: boolean) => onToggle(role, { enabled: value }),
    [onToggle, role],
  );
  const handleRemove = useCallback(() => onRemove(role), [onRemove, role]);

  return (
    <View style={styles.roleHeader}>
      <View style={settingsStyles.rowContent}>
        <Text style={styles.roleTitle}>{label}</Text>
        <Text style={settingsStyles.rowHint}>
          Multiple provider/model profiles are allowed; routing chooses the runtime profile.
        </Text>
      </View>
      {isCustom ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={handleRemove}
          testID={`orchestration-remove-role-${role}`}
        >
          Remove role
        </Button>
      ) : null}
      <Switch
        value={enabled}
        onValueChange={handleToggle}
        testID={`orchestration-role-enable-${role}`}
      />
    </View>
  );
}

interface RoleCardProps {
  role: string;
  config: OrchestrationConfig;
  displayRoleLabel: (role: string) => string;
  updateRole: (
    role: OrchestrationRole,
    patch: Partial<OrchestrationConfig["roles"][OrchestrationRole]>,
  ) => void;
  removeProfile: (role: OrchestrationRole, profileId: string) => void;
  setProfileRole: (role: OrchestrationRole | null) => void;
  removeRole: (role: string) => void;
}

function RoleCard({
  role,
  config,
  displayRoleLabel,
  updateRole,
  removeProfile,
  setProfileRole,
  removeRole,
}: RoleCardProps) {
  const roleConfig = config.roles[role];
  const handleSaveInstructions = useCallback(
    (instructions: string) => {
      void updateRole(role, { instructions });
    },
    [updateRole, role],
  );
  return (
    <View key={role} style={styles.roleCard} testID={`orchestration-role-${role}`}>
      <RoleHeader
        role={role}
        label={displayRoleLabel(role)}
        isCustom={!isBuiltinRoleId(role)}
        enabled={roleConfig.enabled}
        onToggle={updateRole}
        onRemove={removeRole}
      />
      {roleConfig.profiles.map((profile, index) => (
        <View key={profile.id} style={[styles.profileRow, index > 0 && styles.profileBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{profile.label ?? profile.id}</Text>
            <Text style={settingsStyles.rowHint}>
              {profile.provider}/{profile.model} · thinking {profile.thinkingOptionId}
              {profile.id === roleConfig.defaultProfileId ? " · default" : ""}
            </Text>
          </View>
          {profile.id !== roleConfig.defaultProfileId ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => void updateRole(role, { defaultProfileId: profile.id })}
              testID={`orchestration-default-${profile.id}`}
            >
              Set default
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onPress={() => void removeProfile(role, profile.id)}
            testID={`orchestration-remove-${profile.id}`}
          >
            Remove
          </Button>
        </View>
      ))}
      <View style={[styles.profileActions, styles.profileBorder]}>
        <Button
          variant="outline"
          size="sm"
          onPress={() => setProfileRole(role)}
          testID="orchestration-profile-add"
        >
          Add provider/model profile
        </Button>
      </View>
      <View style={styles.profileActions}>
        <InstructionsField
          label="Instructions"
          hint="System instructions injected into this role's agents at creation."
          value={config.roles[role].instructions || defaultRoleInstructions(role)}
          placeholder="Role instructions"
          testID={`orchestration-role-instructions-${role}`}
          onSave={handleSaveInstructions}
        />
      </View>
    </View>
  );
}

interface RouteRowProps {
  category: OrchestrationRouteCategory;
  index: number;
  config: OrchestrationConfig;
  routeOptions: SelectFieldOption<OrchestrationRouteTarget>[];
  displayRoleLabel: (role: string) => string;
  updateRoute: (category: OrchestrationRouteCategory, target: OrchestrationRouteTarget) => void;
  onSaveRouteInstructions: (category: OrchestrationRouteCategory, instructions: string) => void;
}

function RouteRow({
  category,
  index,
  config,
  routeOptions,
  displayRoleLabel,
  updateRoute,
  onSaveRouteInstructions,
}: RouteRowProps) {
  const { theme } = useUnistyles();
  const route = config.routes[category];
  const selectedProfile = findProfile(config, route.primary);
  const handleSaveRouteInstructions = useCallback(
    (instructions: string) => {
      onSaveRouteInstructions(category, instructions);
    },
    [category, onSaveRouteInstructions],
  );
  return (
    <View
      key={category}
      style={[styles.routeRow, index > 0 && styles.profileBorder]}
      testID={`orchestration-route-${category}`}
    >
      <View style={styles.routeHeader}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{routeLabel(category)}</Text>
          <Text style={settingsStyles.rowHint}>
            Fallbacks:{" "}
            {route.fallbacks.length > 0
              ? route.fallbacks.map((target) => target.profileId).join(", ")
              : "none"}
          </Text>
        </View>
        <Text style={[styles.routeProvider, { color: theme.colors.foregroundMuted }]}>
          {selectedProfile
            ? `${selectedProfile.provider}/${selectedProfile.model}`
            : "Invalid profile"}
        </Text>
      </View>
      <SelectField
        label="Primary profile"
        value={route.primary}
        selectedDisplay={
          selectedProfile
            ? {
                label: `${displayRoleLabel(route.primary.role)} · ${selectedProfile.label ?? selectedProfile.id}`,
              }
            : null
        }
        options={routeOptions}
        onChange={(target) => void updateRoute(category, target)}
        placeholder="Choose a profile"
        emptyText="No profiles configured"
        searchable
        searchPlaceholder="Search provider or model"
        getValueKey={(target) => `${target.role}:${target.profileId}`}
        testID={`orchestration-route-select-${category}`}
      />
      <InstructionsField
        label="Route instructions"
        hint="Extra guidance for how the Lead interprets this route."
        value={route.instructions || defaultRouteInstructions(category)}
        placeholder="Optional route instructions"
        testID={`orchestration-route-instructions-${category}`}
        onSave={handleSaveRouteInstructions}
      />
    </View>
  );
}

export function HostOrchestrationPage({ serverId }: OrchestrationPageProps) {
  const { theme } = useUnistyles();
  const { config, isLoading, error: loadError, patchConfig } = useOrchestration(serverId);
  const [profileRole, setProfileRole] = useState<OrchestrationRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addRoleOpen, setAddRoleOpen] = useState(false);

  const roleIds = useMemo(() => {
    if (!config) return [];
    const keys = Object.keys(config.roles);
    const builtins = BUILTIN_ROLE_IDS.filter((id) => keys.includes(id));
    const custom = keys.filter((id) => !isBuiltinRoleId(id));
    return [...builtins, ...custom];
  }, [config]);

  const displayRoleLabel = useCallback(
    (role: string) => config?.roles[role]?.label ?? role.charAt(0).toUpperCase() + role.slice(1),
    [config],
  );

  const removeRole = useCallback(
    async (role: string) => {
      if (!config || isBuiltinRoleId(role)) return;
      const usedByRoute = ROUTE_ORDER.some((category) => {
        const route = config.routes[category];
        return [route.primary, ...route.fallbacks].some((target) => target.role === role);
      });
      if (usedByRoute) {
        setError("This role is used by a route. Change that route before removing it.");
        return;
      }
      setError(null);
      await patchConfig({ removeRoleIds: [role] });
    },
    [config, patchConfig],
  );

  const addCustomRole = useCallback(
    async (roleId: string, label: string, firstProfile: OrchestrationProfile) => {
      if (!config) return;
      await patchConfig({
        roles: {
          [roleId]: {
            enabled: true,
            label: label.trim() || undefined,
            instructions: "",
            profiles: [firstProfile],
            defaultProfileId: firstProfile.id,
          },
        },
      });
    },
    [config, patchConfig],
  );

  const openAddRole = useCallback(() => {
    setAddRoleOpen(true);
  }, []);

  const closeAddRole = useCallback(() => {
    setAddRoleOpen(false);
  }, []);

  const updateRole = useCallback(
    async (
      role: OrchestrationRole,
      patch: Partial<OrchestrationConfig["roles"][OrchestrationRole]>,
    ) => {
      if (!config) return;
      setError(null);
      await patchConfig({ roles: { [role]: patch } });
    },
    [config, patchConfig],
  );

  const addProfile = useCallback(
    async (role: OrchestrationRole, profile: OrchestrationProfile) => {
      if (!config) return;
      await updateRole(role, { profiles: [...config.roles[role].profiles, profile] });
    },
    [config, updateRole],
  );

  const removeProfile = useCallback(
    async (role: OrchestrationRole, profileId: string) => {
      if (!config) return;
      if (config.roles[role].profiles.length <= 1) {
        setError("Each role must keep at least one profile.");
        return;
      }
      const routeUsesProfile = ROUTE_ORDER.some((category) => {
        const route = config.routes[category];
        return [route.primary, ...route.fallbacks].some(
          (target) => target.role === role && target.profileId === profileId,
        );
      });
      if (routeUsesProfile) {
        setError("This profile is used by a route. Change that route before removing it.");
        return;
      }
      await updateRole(role, {
        profiles: config.roles[role].profiles.filter((profile) => profile.id !== profileId),
        defaultProfileId:
          config.roles[role].defaultProfileId === profileId
            ? config.roles[role].profiles.find((profile) => profile.id !== profileId)?.id
            : config.roles[role].defaultProfileId,
      });
    },
    [config, updateRole],
  );

  const routeOptions = useMemo<SelectFieldOption<OrchestrationRouteTarget>[]>(() => {
    if (!config) return [];
    return roleIds.flatMap((role) =>
      config.roles[role].profiles.map((profile) => ({
        id: `${role}:${profile.id}`,
        value: { role, profileId: profile.id } as OrchestrationRouteTarget,
        label: `${displayRoleLabel(role)} · ${profile.label ?? `${profile.provider}/${profile.model}`}`,
        description: `${profile.provider}/${profile.model} · thinking ${profile.thinkingOptionId}`,
      })),
    );
  }, [config, roleIds, displayRoleLabel]);

  const updateRoute = useCallback(
    async (category: OrchestrationRouteCategory, target: OrchestrationRouteTarget) => {
      if (!config) return;
      const previousTarget = config.routes[category].primary;
      await patchConfig({
        routes: {
          [category]: {
            ...config.routes[category],
            primary: {
              ...target,
              ...(previousTarget.thinkingOptionId
                ? { thinkingOptionId: previousTarget.thinkingOptionId }
                : {}),
            },
          },
        },
      });
    },
    [config, patchConfig],
  );

  const updateRouteInstructions = useCallback(
    async (category: OrchestrationRouteCategory, instructions: string) => {
      if (!config) return;
      await patchConfig({
        routes: { [category]: { ...config.routes[category], instructions } },
      });
    },
    [config, patchConfig],
  );

  if (isLoading && !config) {
    return <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />;
  }
  if (!config) {
    return (
      <Text style={styles.error}>{loadError ?? "Orchestration is unavailable on this host."}</Text>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} testID="orchestration-settings">
      <SettingsSection title="Orchestration">
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Enable orchestration</Text>
              <Text style={settingsStyles.rowHint}>
                Allow workspace requests to enter the Supervisor–Lead–Peer runtime.
              </Text>
            </View>
            <Switch
              value={config.enabled}
              onValueChange={(enabled) => void patchConfig({ enabled })}
              testID="orchestration-enabled"
            />
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Prepare a Task Brief automatically</Text>
              <Text style={settingsStyles.rowHint}>
                Turn a natural-language request into the structured Supervisor prompt.
              </Text>
            </View>
            <Switch
              value={config.autoPrepareBrief}
              onValueChange={(autoPrepareBrief) => void patchConfig({ autoPrepareBrief })}
              testID="orchestration-auto-brief"
            />
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Ask when a decision is missing</Text>
              <Text style={settingsStyles.rowHint}>
                Pause in the same workspace chat only for material ambiguity.
              </Text>
            </View>
            <Switch
              value={config.askWhenAmbiguous}
              onValueChange={(askWhenAmbiguous) => void patchConfig({ askWhenAmbiguous })}
              testID="orchestration-ask-ambiguous"
            />
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Maximum Peer fan-out</Text>
              <Text style={settingsStyles.rowHint}>
                Maximum bounded Peer assignments created by one Lead in a run.
              </Text>
            </View>
            <View style={styles.limitControls}>
              <Button
                variant="ghost"
                size="sm"
                onPress={() =>
                  void patchConfig({
                    limits: { maxPeersPerLead: Math.max(1, config.limits.maxPeersPerLead - 1) },
                  })
                }
                disabled={config.limits.maxPeersPerLead <= 1}
                testID="orchestration-peer-limit-decrement"
              >
                −
              </Button>
              <Text style={styles.limitValue} testID="orchestration-peer-limit">
                {config.limits.maxPeersPerLead}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                onPress={() =>
                  void patchConfig({
                    limits: { maxPeersPerLead: Math.min(12, config.limits.maxPeersPerLead + 1) },
                  })
                }
                disabled={config.limits.maxPeersPerLead >= 12}
                testID="orchestration-peer-limit-increment"
              >
                +
              </Button>
            </View>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title="Role profiles">
        {roleIds.map((role) => (
          <RoleCard
            key={role}
            role={role}
            config={config}
            displayRoleLabel={displayRoleLabel}
            updateRole={updateRole}
            removeProfile={removeProfile}
            setProfileRole={setProfileRole}
            removeRole={removeRole}
          />
        ))}
        <View style={styles.addRole}>
          <Button variant="outline" onPress={openAddRole} testID="orchestration-add-role">
            Add custom role
          </Button>
        </View>
      </SettingsSection>

      <SettingsSection title="Semantic routing">
        <View style={settingsStyles.card} testID="orchestration-routes">
          {ROUTE_ORDER.map((category, index) => (
            <RouteRow
              key={category}
              category={category}
              index={index}
              config={config}
              routeOptions={routeOptions}
              displayRoleLabel={displayRoleLabel}
              updateRoute={updateRoute}
              onSaveRouteInstructions={updateRouteInstructions}
            />
          ))}
        </View>
      </SettingsSection>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ProfileModal
        visible={profileRole !== null}
        role={profileRole ?? "peer"}
        serverId={serverId}
        onClose={() => setProfileRole(null)}
        onSave={(profile) => addProfile(profileRole ?? "peer", profile)}
      />
      <AddRoleModal
        visible={addRoleOpen}
        serverId={serverId}
        existingRoleIds={Object.keys(config.roles)}
        onClose={closeAddRole}
        onSave={addCustomRole}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { paddingBottom: theme.spacing[24] },
  roleCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  roleHeader: { flexDirection: "row", alignItems: "center", padding: theme.spacing[4] },
  roleTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  profileActions: { padding: theme.spacing[4] },
  addRole: { marginTop: theme.spacing[4] },
  profileBorder: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  routeRow: { padding: theme.spacing[4], gap: theme.spacing[3] },
  routeHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  routeProvider: { fontSize: theme.fontSize.xs, maxWidth: 220, textAlign: "right" },
  limitControls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  limitValue: {
    color: theme.colors.foreground,
    minWidth: 24,
    textAlign: "center",
    fontSize: theme.fontSize.sm,
  },
  modalBody: { gap: theme.spacing[4], paddingBottom: theme.spacing[2] },
  actions: { flexDirection: "row", gap: theme.spacing[2], marginTop: theme.spacing[2] },
  action: { flex: 1 },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    margin: theme.spacing[3],
  },
}));
