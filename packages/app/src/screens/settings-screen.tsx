import { useSettingsContentPresented } from "@/navigation/settings-presentation";
import { GumloopRow } from "@/components/gumloop-shell/sidebar";
import { PageHeader } from "@/components/headers/page-header";
import { SidebarViewPicker } from "@/plugins/sidebar-view/picker";
import { AppearanceText as Text } from "@/appearance/text";
import { Portal } from "@gorhom/portal";
import { GUMLOOP_PANEL_HOST } from "@/components/gumloop-shell/sidebar-state";
import { GUMLOOP_PAGE_GUTTER } from "@/components/gumloop-shell/list-styles";
import { settingsPageDescription } from "@/screens/settings/page-description";
import { useGumloopDesktopShell } from "@/components/gumloop-shell/use-gumloop-chrome";
import { usePluginDescription, usePluginDisplayName } from "@/plugins/plugin-list";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SPACING } from "@/styles/theme";
import {
  selectSettingsHost,
  useSettingsHostSelection,
  useSettingsSidebarScroll,
} from "@/navigation/settings-presentation";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { SendShortcut } from "@/hooks/use-settings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
} from "react-native";
import { useRouter } from "expo-router";
import { useNavigation, usePreventRemove } from "expo-router/react-navigation";
import { registerRouteLeaveGuard } from "@/navigation/route-leave-guard";
import { useIsFocused } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Buffer } from "buffer";
import {
  ArrowLeft,
  Settings,
  Palette,
  Server,
  Laptop,
  MessageSquare,
  Bell,
  Bot,
  Boxes,
  Gauge,
  Keyboard,
  Stethoscope,
  Puzzle,
  Plus,
  FolderGit2,
  SquareTerminal,
  Smartphone,
  GitBranch,
  Wrench,
  Mic,
  Layers,
} from "lucide-react-native";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { HostPicker as SharedHostPicker } from "@/components/hosts/host-picker";
import { HostStatusDot } from "@/components/host-status-dot";
import { ScreenTitle } from "@/components/headers/screen-title";
import { HeaderIconBadge } from "@/components/headers/header-icon-badge";
import { ClientHostDetailPage, ClientHostsSection } from "@/screens/settings/client-hosts-page";
import { SettingsSection } from "@/screens/settings/settings-section";
import { AppearanceSection } from "@/screens/settings/appearance/appearance-section";
import {
  useAppSettings,
  parseTerminalScrollbackLines,
  type AppSettings,
  type SendBehavior,
  type ServiceUrlBehavior,
} from "@/hooks/use-settings";
import { useHosts } from "@/runtime/host-runtime";
import {
  orderHostsLocalFirst,
  resolveActiveHostServerId,
  type HostProfile,
} from "@/types/host-connection";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { BackHeader } from "@/components/headers/back-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { AddHostMethodModal } from "@/components/add-host-method-modal";
import { AddHostModal } from "@/components/add-host-modal";
import { PairLinkModal } from "@/components/pair-link-modal";
import { KeyboardShortcutsSection } from "@/screens/settings/keyboard-shortcuts-section";
import { EditorSection } from "@/screens/settings/editor-section";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DesktopPermissionsSection } from "@/desktop/components/desktop-permissions-section";
import { BrowserDataSection } from "@/desktop/browser/settings/browser-data-section";
import { IntegrationsSection } from "@/desktop/components/integrations-section";
import { isElectronRuntime } from "@/desktop/host";
import { getSnapshot as getTailscaleSnapshot, setTailnetModeIfUnset } from "@/tailscale";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { useConnectionLogSheetStore } from "@/diagnostics/connection-log-store";
import { settingsStyles } from "@/styles/settings";
import { THINKING_TONE_NATIVE_PCM_BASE64 } from "@/utils/thinking-tone.native-pcm";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import {
  LANGUAGE_OPTIONS,
  formatLanguageOptionLabel,
  parseAppLanguage,
  type AppLanguage,
  type SupportedLocale,
} from "@/i18n/locales";
import {
  HostPairDevicePage,
  HostAgentsPage,
  HostAgentProfilesPage,
  HostDaemonPage,
  HostToolsAndPromptsPage,
  HostProvidersPage,
  HostUsagePage,
  HostWorkspacesPage,
  HostTerminalsPage,
} from "@/screens/settings/host-page";
import { HostOrchestrationPage } from "@/screens/settings/orchestration-page";
import { HostPluginsPage } from "@/screens/settings/plugins-page";
import { PluginSettingsContent } from "@/plugins/settings";
import { useInstalledPlugins } from "@/plugins/registry";
import { resolvePluginIcon } from "@/plugins/icons";
import { useHostFeature } from "@/runtime/host-features";
import { HostVoicePage } from "@/screens/settings/voice/voice-page";
import ProjectsScreen from "@/screens/projects-screen";
import ProjectSettingsScreen from "@/screens/project-settings-screen";
import {
  SETTINGS_DESKTOP_DETAIL_MIN_WIDTH,
  SETTINGS_DESKTOP_SIDEBAR_WIDTH,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { densityIconBox, densityIconSize } from "@/styles/density";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  type EnableBuiltInDaemonOption,
  useEnableBuiltInDaemonOption,
} from "@/desktop/hooks/use-enable-built-in-daemon-option";
import {
  buildClientHostSettingsRoute,
  buildOpenProjectRoute,
  buildSettingsHostSectionRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";
import { navigateToLastWorkspace } from "@/stores/navigation-active-workspace-store";
// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

function SettingsDesktopHeader({
  title,
  description,
  scrolled,
  children,
}: {
  title: string;
  description: string;
  scrolled: boolean;
  children: ReactNode;
}) {
  const gumloop = useGumloopDesktopShell(true);
  return gumloop ? (
    <PageHeader icon={Settings} title={title} description={description} scrolled={scrolled} />
  ) : (
    children
  );
}

export type SettingsView =
  | { kind: "root" }
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "clientHost"; serverId: string }
  | { kind: "host"; serverId: string; section: HostSectionSlug }
  | { kind: "project"; serverId: string; projectId: string }
  | { kind: "plugin"; serverId: string; pluginId: string; screenId: string };

const SettingsScrollView = Platform.OS === "android" ? KeyboardAwareScrollView : ScrollView;
const settingsScrollProps = Platform.OS === "android" ? { bottomOffset: SPACING[4] } : {};

interface SidebarSectionItem {
  id: SettingsSectionSlug;
  labelKey: string;
  icon: ComponentType<{ size: number; color: string }>;
  desktopOnly?: boolean;
}

// "This device": settings stored on this device only. Host sections below are the daemon's.
const SIDEBAR_SECTION_ITEMS: SidebarSectionItem[] = [
  { id: "general", labelKey: "settings.sections.general", icon: Settings },
  { id: "hosts", labelKey: "settings.sections.hosts", icon: Laptop },
  { id: "appearance", labelKey: "settings.sections.appearance", icon: Palette },
  { id: "sidebar", labelKey: "settings.sections.sidebar", icon: FolderGit2 },
  { id: "chat", labelKey: "settings.sections.chatAndPanes", icon: MessageSquare },
  { id: "shortcuts", labelKey: "settings.sections.shortcuts", icon: Keyboard, desktopOnly: true },
  {
    id: "notifications",
    labelKey: "settings.sections.notifications",
    icon: Bell,
    desktopOnly: true,
  },
  { id: "diagnostics", labelKey: "settings.sections.diagnostics", icon: Stethoscope },
];

interface HostSectionItem {
  id: HostSectionSlug;
  labelKey: string;
  icon: ComponentType<{ size: number; color: string }>;
}

const HOST_SECTION_ITEMS: HostSectionItem[] = [
  { id: "providers", labelKey: "settings.hostSections.providers", icon: Boxes },
  { id: "agent-profiles", labelKey: "settings.hostSections.agentProfiles", icon: Layers },
  { id: "tools", labelKey: "settings.hostSections.tools", icon: Wrench },
  { id: "agents", labelKey: "settings.hostSections.agents", icon: Bot },
  { id: "orchestration", labelKey: "settings.hostSections.orchestration", icon: GitBranch },
  { id: "projects", labelKey: "settings.hostSections.projects", icon: FolderGit2 },
  { id: "workspaces", labelKey: "settings.hostSections.workspaces", icon: FolderGit2 },
  { id: "voice", labelKey: "settings.hostSections.voice", icon: Mic },
  { id: "usage", labelKey: "settings.hostSections.usage", icon: Gauge },
  { id: "terminals", labelKey: "settings.hostSections.terminals", icon: SquareTerminal },
  { id: "plugins", labelKey: "settings.hostSections.plugins", icon: Puzzle },
  { id: "pair-device", labelKey: "openProject.tiles.pairDevice.title", icon: Smartphone },
  { id: "daemon", labelKey: "settings.hostSections.daemon", icon: Server },
];

function renderHostSettingsContent(view: Extract<SettingsView, { kind: "host" }>): ReactNode {
  switch (view.section) {
    case "projects":
      return <ProjectsScreen serverId={view.serverId} />;
    case "pair-device":
      return <HostPairDevicePage serverId={view.serverId} />;
    case "agents":
      return <HostAgentsPage serverId={view.serverId} />;
    case "agent-profiles":
      // Rendered directly by SettingsScreen: the page owns its header, roster and drawer split.
      return null;
    case "orchestration":
      return <HostOrchestrationPage serverId={view.serverId} />;
    case "voice":
      return <HostVoicePage serverId={view.serverId} />;
    case "workspaces":
      return <HostWorkspacesPage serverId={view.serverId} />;
    case "providers":
      return <HostProvidersPage serverId={view.serverId} />;
    case "usage":
      return <HostUsagePage serverId={view.serverId} />;
    case "terminals":
      return <HostTerminalsPage serverId={view.serverId} />;
    case "plugins":
      return <HostPluginsPage serverId={view.serverId} />;
    case "tools":
      return <HostToolsAndPromptsPage serverId={view.serverId} />;
    case "daemon":
      return <HostDaemonPage serverId={view.serverId} />;
  }
}

// ---------------------------------------------------------------------------
// Trigger + sidebar style helpers
// ---------------------------------------------------------------------------

function themeTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.themeTrigger, pressed && { opacity: 0.85 }];
}

function sidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    pressed && sidebarStyles.itemPressed,
  ];
}

function selectedSidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    sidebarStyles.itemSelected,
    pressed && sidebarStyles.itemPressed,
  ];
}

function getSendBehaviorOptions(t: TFunction) {
  return [
    { value: "steer" as const, label: t("settings.general.defaultSend.options.steer") },
    { value: "interrupt" as const, label: t("settings.general.defaultSend.options.interrupt") },
    { value: "queue" as const, label: t("settings.general.defaultSend.options.queue") },
  ];
}

function getServiceUrlBehaviorLabel(t: TFunction, value: ServiceUrlBehavior): string {
  const labels: Record<ServiceUrlBehavior, string> = {
    ask: t("settings.general.serviceUrls.options.ask"),
    "in-app": t("settings.general.serviceUrls.options.inApp"),
    external: t("settings.general.serviceUrls.options.external"),
  };
  return labels[value];
}

function getActiveLocale(language: string | undefined): SupportedLocale {
  const parsed = parseAppLanguage(language);
  return parsed && parsed !== "system" ? parsed : "en";
}

const SERVICE_URL_BEHAVIOR_VALUES: ServiceUrlBehavior[] = ["ask", "in-app", "external"];

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

interface GeneralSectionProps {
  settings: AppSettings;
  isDesktopApp: boolean;
  handleServiceUrlBehaviorChange: (behavior: ServiceUrlBehavior) => void;
  handleLanguageChange: (language: AppLanguage) => void;
}

interface ChatSectionProps {
  settings: AppSettings;
  handleSendShortcutChange: (shortcut: SendShortcut) => void;
  handleSendBehaviorChange: (behavior: SendBehavior) => void;
  handleTerminalScrollbackLinesChange: (lines: number) => void;
}

interface ServiceUrlBehaviorMenuItemProps {
  value: ServiceUrlBehavior;
  label: string;
  selected: boolean;
  onChange: (value: ServiceUrlBehavior) => void;
}

function ServiceUrlBehaviorMenuItem({
  value,
  label,
  selected,
  onChange,
}: ServiceUrlBehaviorMenuItemProps) {
  const handleSelect = useCallback(() => {
    onChange(value);
  }, [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

interface LanguageMenuItemProps {
  value: AppLanguage;
  activeLocale: SupportedLocale;
  selected: boolean;
  onChange: (value: AppLanguage) => void;
}

function LanguageMenuItem({ value, activeLocale, selected, onChange }: LanguageMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onChange(value);
  }, [onChange, value]);
  const option = LANGUAGE_OPTIONS.find((entry) => entry.value === value);
  const label = option
    ? formatLanguageOptionLabel(option, activeLocale, t(option.labelKey))
    : value;

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

function GeneralSection({
  settings,
  isDesktopApp,
  handleServiceUrlBehaviorChange,
  handleLanguageChange,
}: GeneralSectionProps) {
  const { t, i18n } = useTranslation();
  const activeLocale = getActiveLocale(i18n.language);
  const selectedLanguageOption = LANGUAGE_OPTIONS.find(
    (option) => option.value === settings.language,
  );
  const selectedLanguageLabel = selectedLanguageOption
    ? formatLanguageOptionLabel(
        selectedLanguageOption,
        activeLocale,
        t(selectedLanguageOption.labelKey),
      )
    : settings.language;

  return (
    <SettingsSection title={t("settings.general.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.general.language.label")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.general.language.description")}</Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger
              accessibilityRole="button"
              accessibilityLabel={selectedLanguageLabel}
              style={themeTriggerStyle}
            >
              <Text style={styles.themeTriggerText}>{selectedLanguageLabel}</Text>
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={300}>
              {LANGUAGE_OPTIONS.map((option) => (
                <LanguageMenuItem
                  key={option.value}
                  value={option.value}
                  activeLocale={activeLocale}
                  selected={settings.language === option.value}
                  onChange={handleLanguageChange}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
        {isDesktopApp ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.general.serviceUrls.label")}</Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.general.serviceUrls.description")}
              </Text>
            </View>
            <DropdownMenu>
              <DropdownTrigger style={themeTriggerStyle}>
                <Text style={styles.themeTriggerText}>
                  {getServiceUrlBehaviorLabel(t, settings.serviceUrlBehavior)}
                </Text>
              </DropdownTrigger>
              <DropdownMenuContent side="bottom" align="end" width={200}>
                {SERVICE_URL_BEHAVIOR_VALUES.map((value) => (
                  <ServiceUrlBehaviorMenuItem
                    key={value}
                    value={value}
                    label={getServiceUrlBehaviorLabel(t, value)}
                    selected={settings.serviceUrlBehavior === value}
                    onChange={handleServiceUrlBehaviorChange}
                  />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

/** Chat & panes: how messages send and how much terminal history a pane keeps. */
function ChatSection({
  settings,
  handleSendBehaviorChange,
  handleSendShortcutChange,
  handleTerminalScrollbackLinesChange,
}: ChatSectionProps) {
  const { t } = useTranslation();
  const sendBehaviorOptions = useMemo(() => getSendBehaviorOptions(t), [t]);
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const modifier = getShortcutOs() === "mac" ? "⌘" : "Ctrl";
  const shortcutOptions = useMemo(
    () =>
      (["enter", "mod-enter"] as const).map((value) => ({
        value,
        label: t(`settings.general.sendShortcut.options.${value}`, { modifier }),
      })),
    [t, modifier],
  );
  const sendBehaviorDescriptionKey =
    shortcutsAvailable && settings.sendShortcut === "mod-enter"
      ? `settings.general.defaultSend.commandEnterDescriptions.${settings.sendBehavior}`
      : `settings.general.defaultSend.descriptions.${settings.sendBehavior}`;
  const [terminalScrollbackValue, setTerminalScrollbackValue] = useState(
    String(settings.terminalScrollbackLines),
  );

  const handleTerminalScrollbackChangeText = useCallback((value: string) => {
    setTerminalScrollbackValue(value.replace(/[^\d]/g, ""));
  }, []);

  const commitTerminalScrollback = useCallback(() => {
    const parsed = parseTerminalScrollbackLines(terminalScrollbackValue);
    const nextValue = parsed ?? settings.terminalScrollbackLines;
    setTerminalScrollbackValue(String(nextValue));
    if (nextValue !== settings.terminalScrollbackLines) {
      handleTerminalScrollbackLinesChange(nextValue);
    }
  }, [
    handleTerminalScrollbackLinesChange,
    settings.terminalScrollbackLines,
    terminalScrollbackValue,
  ]);

  useEffect(() => {
    setTerminalScrollbackValue(String(settings.terminalScrollbackLines));
  }, [settings.terminalScrollbackLines]);

  return (
    <SettingsSection title={t("settings.chat.sendingTitle")}>
      <View style={settingsStyles.card}>
        {shortcutsAvailable ? (
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.general.sendShortcut.label")}
              </Text>
            </View>
            <SegmentedControl
              size="sm"
              value={settings.sendShortcut}
              onValueChange={handleSendShortcutChange}
              options={shortcutOptions}
            />
          </View>
        ) : null}
        <View style={[settingsStyles.row, shortcutsAvailable && settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.general.defaultSend.label")}</Text>
            <Text style={settingsStyles.rowHint}>
              {t(sendBehaviorDescriptionKey, { modifier })}
            </Text>
          </View>
          <SegmentedControl
            size="sm"
            value={settings.sendBehavior}
            onValueChange={handleSendBehaviorChange}
            options={sendBehaviorOptions}
          />
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.general.terminalScrollback.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.general.terminalScrollback.description")}
            </Text>
          </View>
          <TextInput
            value={terminalScrollbackValue}
            onChangeText={handleTerminalScrollbackChangeText}
            onBlur={commitTerminalScrollback}
            onSubmitEditing={commitTerminalScrollback}
            keyboardType="number-pad"
            inputMode="numeric"
            selectTextOnFocus
            style={styles.terminalScrollbackInput}
            accessibilityLabel={t("settings.general.terminalScrollback.accessibilityLabel")}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

interface DiagnosticsSectionProps {
  voiceAudioEngine: ReturnType<typeof useVoiceAudioEngineOptional>;
  isPlaybackTestRunning: boolean;
  playbackTestResult: string | null;
  handlePlaybackTest: () => Promise<void>;
}

function DiagnosticsSection({
  voiceAudioEngine,
  isPlaybackTestRunning,
  playbackTestResult,
  handlePlaybackTest,
}: DiagnosticsSectionProps) {
  const { t } = useTranslation();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const openConnectionLog = useConnectionLogSheetStore((state) => state.open);
  const handlePlayPress = useCallback(() => {
    void handlePlaybackTest();
  }, [handlePlaybackTest]);
  return (
    <SettingsSection title={t("settings.diagnostics.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row} testID="app-diagnostic-row">
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.app.rowTitle")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.diagnostics.app.rowHint")}</Text>
          </View>
          <Button variant="secondary" size="sm" onPress={openAppDiagnostic}>
            {t("settings.diagnostics.app.run")}
          </Button>
        </View>
        <View style={settingsStyles.row} testID="connection-log-row">
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.diagnostics.connectionLog.rowTitle")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.diagnostics.connectionLog.rowHint")}
            </Text>
          </View>
          <Button variant="secondary" size="sm" onPress={openConnectionLog}>
            {t("settings.diagnostics.connectionLog.open")}
          </Button>
        </View>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.testAudio")}</Text>
            {playbackTestResult ? (
              <Text style={settingsStyles.rowHint}>{playbackTestResult}</Text>
            ) : null}
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={handlePlayPress}
            disabled={!voiceAudioEngine || isPlaybackTestRunning}
          >
            {isPlaybackTestRunning
              ? t("settings.diagnostics.playing")
              : t("settings.diagnostics.playTest")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/**
 * Keep the local daemon first only when the active transport is Local; a
 * Tailscale session keeps the user's saved host order.
 */
function useSortedHosts(hosts: HostProfile[], localServerId: string | null): HostProfile[] {
  return useMemo(() => orderHostsLocalFirst(hosts, localServerId), [hosts, localServerId]);
}

interface SidebarSectionButtonProps {
  itemId: SettingsSectionSlug;
  label: string;
  icon: ComponentType<{ size: number; color: string }>;
  isSelected: boolean;
  onSelect: (section: SettingsSectionSlug) => void;
}

function SidebarSectionButton({
  itemId,
  label,
  icon: IconComponent,
  isSelected,
  onSelect,
}: SidebarSectionButtonProps) {
  const { theme, rt } = useUnistyles();
  const gumloop = useGumloopDesktopShell(true);
  const handlePress = useCallback(() => {
    onSelect(itemId);
  }, [onSelect, itemId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const labelStyle = useMemo(
    () => [sidebarStyles.label, isSelected && { color: theme.colors.foreground }],
    [isSelected, theme.colors.foreground],
  );
  if (gumloop)
    return (
      <GumloopRow icon={IconComponent} label={label} selected={isSelected} onPress={handlePress} />
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={isSelected ? selectedSidebarItemStyle : sidebarItemStyle}
    >
      <IconComponent
        size={densityIconSize(rt, "md")}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface SidebarHostSectionButtonProps {
  itemId: HostSectionSlug;
  label: string;
  icon: ComponentType<{ size: number; color: string }>;
  isSelected: boolean;
  onSelect: (section: HostSectionSlug) => void;
}

function SidebarHostSectionButton({
  itemId,
  label,
  icon: IconComponent,
  isSelected,
  onSelect,
}: SidebarHostSectionButtonProps) {
  const { theme, rt } = useUnistyles();
  const gumloop = useGumloopDesktopShell(true);
  const handlePress = useCallback(() => {
    onSelect(itemId);
  }, [onSelect, itemId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const labelStyle = useMemo(
    () => [sidebarStyles.label, isSelected && { color: theme.colors.foreground }],
    [isSelected, theme.colors.foreground],
  );
  if (gumloop)
    return (
      <GumloopRow icon={IconComponent} label={label} selected={isSelected} onPress={handlePress} />
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      testID={`settings-host-section-${itemId}`}
      style={isSelected ? selectedSidebarItemStyle : sidebarItemStyle}
    >
      <IconComponent
        size={densityIconSize(rt, "md")}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface HostPickerProps {
  activeServerId: string | null;
  sortedHosts: HostProfile[];
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  enableBuiltInDaemonOption: EnableBuiltInDaemonOption;
}

/**
 * Scopes the host sections to a host. Reuses the canonical sidebar host
 * switcher pattern (left-sidebar.tsx): a quiet row-styled trigger opening a
 * <Combobox>. The local host is listed first, each row shows the connection it
 * is using right now; an "Add host" row is always reachable from the list —
 * even with a single host.
 */
function HostPicker({
  activeServerId,
  sortedHosts,
  onSelectHost,
  onAddHost,
  enableBuiltInDaemonOption,
}: HostPickerProps) {
  const gumloop = useGumloopDesktopShell(true);
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const activeHost =
    sortedHosts.find((host) => host.serverId === activeServerId) ?? sortedHosts[0] ?? null;

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const hostOptionTestID = useCallback(
    (serverId: string) => `settings-host-picker-item-${serverId}`,
    [],
  );
  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sidebarStyles.pickerTrigger,
      hovered && sidebarStyles.pickerTriggerHovered,
      pressed && sidebarStyles.itemPressed,
    ],
    [],
  );

  return (
    <SharedHostPicker
      hosts={sortedHosts}
      value={activeServerId ?? ""}
      onSelect={onSelectHost}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      includeEnableBuiltInDaemon={enableBuiltInDaemonOption.visible}
      onEnableBuiltInDaemon={enableBuiltInDaemonOption.onPress}
      showActiveConnection
      searchable={false}
      title={t("settings.hostPicker.switchHost")}
      desktopMinWidth={328}
      addHostTestID="settings-add-host"
      hostOptionTestID={hostOptionTestID}
    >
      <ComboboxTrigger
        ref={triggerRef}
        block
        style={triggerStyle}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={t("settings.hostPicker.switchHost")}
        testID="settings-host-picker"
      >
        {activeHost ? (
          <View style={sidebarStyles.pickerTriggerDot}>
            <HostStatusDot serverId={activeHost.serverId} />
          </View>
        ) : null}
        <Text
          style={[
            sidebarStyles.pickerTriggerLabel,
            gumloop && sidebarStyles.gumloopPickerTriggerLabel,
          ]}
          numberOfLines={1}
        >
          {activeHost?.label ?? t("settings.groups.host")}
        </Text>
      </ComboboxTrigger>
    </SharedHostPicker>
  );
}

/** A labelled group of sidebar rows. On compact layouts the rows sit together in one island. */
function SidebarGroup({ label, children }: { label?: string; children: ReactNode }) {
  const gumloop = useGumloopDesktopShell(true);
  return (
    <View style={[sidebarStyles.group, gumloop && sidebarStyles.gumloopList]}>
      {label ? (
        <Text style={gumloop ? sidebarStyles.gumloopGroupLabel : sidebarStyles.groupLabel}>
          {label}
        </Text>
      ) : null}
      <View style={[sidebarStyles.island, gumloop && sidebarStyles.gumloopIsland]}>{children}</View>
    </View>
  );
}

interface SettingsSidebarProps {
  view: SettingsView;
  onSelectSection: (section: SettingsSectionSlug) => void;
  onSelectHostSection: (section: HostSectionSlug) => void;
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  onBackToWorkspace: () => void;
  activeHostServerId: string | null;
  layout: "desktop" | "mobile";
}

function SettingsSidebar({
  view,
  onSelectSection,
  onSelectHostSection,
  onSelectHost,
  onAddHost,
  onBackToWorkspace,
  activeHostServerId,
  layout,
}: SettingsSidebarProps) {
  const { theme, rt } = useUnistyles();
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  // The desktop always reaches its bundled daemon locally, so it sorts first.
  const localServerIdForOrdering = localServerId;
  const sortedHosts = useSortedHosts(hosts, localServerIdForOrdering);
  const hasHosts = sortedHosts.length > 0;
  const enableBuiltInDaemonOption = useEnableBuiltInDaemonOption();
  const isDesktopApp = isElectronRuntime();
  const items = SIDEBAR_SECTION_ITEMS.filter((item) => !item.desktopOnly || isDesktopApp);
  const pluginManagementSupported = useHostFeature(activeHostServerId, "pluginManagement");
  const hostSectionItems = HOST_SECTION_ITEMS.filter(
    (item) => item.id !== "plugins" || pluginManagementSupported,
  );
  const insets = useSafeAreaInsets();
  const isDesktop = layout === "desktop";
  const gumloop = useGumloopDesktopShell(true);
  const sidebarScroll = useSettingsSidebarScroll(isDesktop);
  const outerContainerStyle = useMemo(
    () => [
      isDesktop ? sidebarStyles.desktopContainer : sidebarStyles.mobileContainer,
      gumloop && sidebarStyles.gumloopContainer,
    ],
    [isDesktop, gumloop],
  );
  const innerContainerStyle = useMemo(
    () => [{ flex: 1 }, isDesktop ? { paddingTop: insets.top } : null],
    [insets.top, isDesktop],
  );
  let selectedSectionId: SettingsSectionSlug | null = null;
  if (view.kind === "section") selectedSectionId = view.section;
  if (view.kind === "clientHost") selectedSectionId = "hosts";
  let selectedHostSection: HostSectionSlug | null = null;
  if (view.kind === "host") selectedHostSection = view.section;
  if (view.kind === "project") selectedHostSection = "projects";
  if (view.kind === "plugin") selectedHostSection = "plugins";

  const sidebarBody = (
    <>
      <SidebarGroup label={t("settings.groups.app")}>
        {items.map((item) => (
          <SidebarSectionButton
            key={item.id}
            itemId={item.id}
            label={t(item.labelKey)}
            icon={item.icon}
            isSelected={selectedSectionId === item.id}
            onSelect={onSelectSection}
          />
        ))}
      </SidebarGroup>
      {hasHosts ? (
        <SidebarGroup label={t("settings.groups.host")}>
          <HostPicker
            activeServerId={activeHostServerId}
            sortedHosts={sortedHosts}
            onSelectHost={onSelectHost}
            onAddHost={onAddHost}
            enableBuiltInDaemonOption={enableBuiltInDaemonOption}
          />
          {hostSectionItems.map((item) => (
            <SidebarHostSectionButton
              key={item.id}
              itemId={item.id}
              label={t(item.labelKey)}
              icon={item.icon}
              isSelected={selectedHostSection === item.id}
              onSelect={onSelectHostSection}
            />
          ))}
        </SidebarGroup>
      ) : (
        <SidebarGroup>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.addHost")}
            onPress={onAddHost}
            testID="settings-add-host"
            style={sidebarItemStyle}
          >
            <Plus size={densityIconSize(rt, "md")} color={theme.colors.foregroundMuted} />
            <Text style={sidebarStyles.label} numberOfLines={1}>
              {t("settings.addHost")}
            </Text>
          </Pressable>
          {enableBuiltInDaemonOption.visible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.enableBuiltInDaemon")}
              onPress={enableBuiltInDaemonOption.onPress}
              testID="settings-enable-built-in-daemon"
              style={sidebarItemStyle}
            >
              <Server size={densityIconSize(rt, "md")} color={theme.colors.foregroundMuted} />
              <Text style={sidebarStyles.label} numberOfLines={1}>
                {t("settings.enableBuiltInDaemon")}
              </Text>
            </Pressable>
          ) : null}
        </SidebarGroup>
      )}
    </>
  );

  return (
    <View
      accessibilityLabel={t("settings.title")}
      role="navigation"
      style={outerContainerStyle}
      testID="settings-sidebar"
    >
      {isDesktop ? (
        <View style={innerContainerStyle}>
          <View style={sidebarStyles.sidebarDragArea}>
            <TitlebarDragRegion />
            <WindowChromeSafeArea placement="below" />
            <SidebarHeaderRow
              icon={ArrowLeft}
              label={t("settings.backToWorkspace")}
              onPress={onBackToWorkspace}
              testID="settings-back-to-workspace"
            />
          </View>
          <ScrollView
            style={sidebarStyles.scrollBody}
            showsVerticalScrollIndicator={false}
            testID="settings-sidebar-scroll-body"
            {...sidebarScroll}
          >
            {sidebarBody}
          </ScrollView>
        </View>
      ) : (
        sidebarBody
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

/** The desktop detail pane: the page header over the scrolling page body. */
function SettingsDesktopDetail({
  title,
  description,
  scrolled,
  headerLeft,
  onScroll,
  contentContainerStyle,
  gumloopDesktop,
  children,
}: {
  title: string | undefined;
  description: string;
  scrolled: boolean;
  headerLeft: ReactNode;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  contentContainerStyle: { paddingBottom: number };
  gumloopDesktop: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <SettingsDesktopHeader
        title={title ?? "Settings"}
        description={description}
        scrolled={scrolled}
      >
        <ScreenHeader
          borderless={title === undefined}
          left={headerLeft}
          leftStyle={desktopStyles.detailLeft}
        />
      </SettingsDesktopHeader>
      <SettingsScrollView
        {...settingsScrollProps}
        style={styles.scrollView}
        contentContainerStyle={contentContainerStyle}
        onScroll={onScroll}
        scrollEventThrottle={16}
        testID="settings-detail-scroll-body"
      >
        <View style={[styles.content, gumloopDesktop && styles.gumloopContent]}>{children}</View>
      </SettingsScrollView>
    </>
  );
}

interface SettingsBeforeLeaveGuard {
  isDirty: () => boolean;
  confirmDiscard: () => Promise<boolean>;
  subscribeDirty?: (listener: () => void) => () => void;
}

/**
 * Lets an active Settings editor (such as Agent profiles) veto both in-app
 * section switches and route-boundary exits (browser Back, native swipe-back,
 * hardware Back) with a single discard confirmation.
 *
 * Uses `usePreventRemove` so native stacks set `preventNativeDismiss` before
 * iOS can interactively dismiss the screen on a back swipe.
 */
function useSettingsBeforeLeaveGuard() {
  const navigation = useNavigation();
  const beforeLeaveRef = useRef<SettingsBeforeLeaveGuard | null>(null);
  const dirtyUnsubRef = useRef<(() => void) | null>(null);
  const [preventRemove, setPreventRemove] = useState(false);

  const registerBeforeLeave = useCallback((guard: SettingsBeforeLeaveGuard | null) => {
    dirtyUnsubRef.current?.();
    dirtyUnsubRef.current = null;
    beforeLeaveRef.current = guard;
    const syncDirty = () => {
      setPreventRemove(Boolean(beforeLeaveRef.current?.isDirty()));
    };
    syncDirty();
    if (guard?.subscribeDirty) {
      dirtyUnsubRef.current = guard.subscribeDirty(syncDirty);
    }
  }, []);

  useEffect(() => {
    return () => {
      dirtyUnsubRef.current?.();
      dirtyUnsubRef.current = null;
    };
  }, []);

  useEffect(() => {
    return registerRouteLeaveGuard({
      isDirty: () => Boolean(beforeLeaveRef.current?.isDirty()),
      confirmDiscard: async () => (await beforeLeaveRef.current?.confirmDiscard()) ?? true,
    });
  }, []);

  usePreventRemove(preventRemove, ({ data }) => {
    const guard = beforeLeaveRef.current;
    if (!guard?.isDirty()) {
      navigation.dispatch(data.action);
      return;
    }
    const confirmAndLeave = async () => {
      if (await guard.confirmDiscard()) {
        navigation.dispatch(data.action);
      }
    };
    void confirmAndLeave();
  });

  const guardNavigation = useCallback((navigate: () => void) => {
    const guard = beforeLeaveRef.current;
    if (!guard?.isDirty()) {
      navigate();
      return;
    }
    const run = async () => {
      if (await guard.confirmDiscard()) {
        navigate();
      }
    };
    void run();
  }, []);

  return { registerBeforeLeave, guardNavigation };
}

export interface SettingsScreenProps {
  view: SettingsView;
  openAddHostIntent?: string | null;
}

export default function SettingsScreen({ view, openAddHostIntent = null }: SettingsScreenProps) {
  const contentPresented = useSettingsContentPresented();
  useEffect(() => {
    contentPresented();
  }, [contentPresented]);
  const router = useRouter();
  const isRouteFocused = useIsFocused();
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const { settings, isLoading: settingsLoading, updateSettings } = useAppSettings();
  const [isAddHostMethodVisible, setIsAddHostMethodVisible] = useState(false);
  const [isDirectHostVisible, setIsDirectHostVisible] = useState(false);
  const [isPasteLinkVisible, setIsPasteLinkVisible] = useState(false);
  const [pairLinkTitle, setPairLinkTitle] = useState<string | undefined>(undefined);
  const [isPlaybackTestRunning, setIsPlaybackTestRunning] = useState(false);
  const [playbackTestResult, setPlaybackTestResult] = useState<string | null>(null);
  const lastOpenedAddHostIntentRef = useRef<string | null>(null);
  const isDesktopApp = isElectronRuntime();
  const isCompactLayout = useIsCompactFormFactor();
  const gumloopDesktop = useGumloopDesktopShell(true);
  const insets = useSafeAreaInsets();
  const insetBottomStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  // The desktop always reaches its bundled daemon locally, so it sorts first.
  const localServerIdForOrdering = localServerId;
  const sortedHosts = useSortedHosts(hosts, localServerIdForOrdering);
  const selectedSettingsHostServerId = useSettingsHostSelection();

  // The host the four sections scope to: the host on the active view, otherwise
  // the picker choice, otherwise the connected local daemon, otherwise the first host.
  const activeHostServerId = useMemo(() => {
    if (
      view.kind === "host" ||
      view.kind === "clientHost" ||
      view.kind === "project" ||
      view.kind === "plugin"
    )
      return view.serverId;
    return resolveActiveHostServerId({
      selectedServerId: selectedSettingsHostServerId,
      localServerId: localServerIdForOrdering,
      hosts,
      orderedHosts: sortedHosts,
    });
  }, [view, selectedSettingsHostServerId, localServerIdForOrdering, hosts, sortedHosts]);

  const handleSendShortcutChange = useCallback(
    (sendShortcut: SendShortcut) => {
      void updateSettings({ sendShortcut });
    },
    [updateSettings],
  );
  const handleSendBehaviorChange = useCallback(
    (behavior: SendBehavior) => {
      void updateSettings({ sendBehavior: behavior });
    },
    [updateSettings],
  );

  const handleServiceUrlBehaviorChange = useCallback(
    (behavior: ServiceUrlBehavior) => {
      void updateSettings({ serviceUrlBehavior: behavior });
    },
    [updateSettings],
  );

  const handleLanguageChange = useCallback(
    (language: AppLanguage) => {
      void updateSettings({ language });
    },
    [updateSettings],
  );

  const handleTerminalScrollbackLinesChange = useCallback(
    (terminalScrollbackLines: number) => {
      void updateSettings({ terminalScrollbackLines });
    },
    [updateSettings],
  );

  const handlePlaybackTest = useCallback(async () => {
    if (!voiceAudioEngine || isPlaybackTestRunning) {
      return;
    }

    setIsPlaybackTestRunning(true);
    setPlaybackTestResult(null);

    try {
      const bytes = Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64");
      await voiceAudioEngine.initialize();
      voiceAudioEngine.stop();
      await voiceAudioEngine.play({
        type: "audio/pcm;rate=16000;bits=16",
        size: bytes.byteLength,
        async arrayBuffer() {
          return Uint8Array.from(bytes).buffer;
        },
      });
      setPlaybackTestResult(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Settings] Playback test failed", error);
      setPlaybackTestResult(t("settings.diagnostics.playbackFailed", { message }));
    } finally {
      setIsPlaybackTestRunning(false);
    }
  }, [isPlaybackTestRunning, t, voiceAudioEngine]);

  const closeAddConnectionFlow = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setIsDirectHostVisible(false);
    setIsPasteLinkVisible(false);
    setPairLinkTitle(undefined);
  }, []);

  const handleAddHost = useCallback(() => {
    setIsAddHostMethodVisible(true);
  }, []);

  useEffect(() => {
    if (!openAddHostIntent || lastOpenedAddHostIntentRef.current === openAddHostIntent) {
      return;
    }
    lastOpenedAddHostIntentRef.current = openAddHostIntent;
    handleAddHost();
  }, [handleAddHost, openAddHostIntent]);

  const handleSelectDirectConnection = useCallback(() => {
    // An unpaired device dials relay only. Record a mode before probing so the
    // direct connection is dialed once saved; an existing sign-in is kept.
    void setTailnetModeIfUnset("off")
      .then(() => {
        setIsAddHostMethodVisible(false);
        setIsDirectHostVisible(true);
        return undefined;
      })
      .catch(() => {
        Alert.alert("Connection setup failed", "JAgentDesk could not save the connection setting.");
      });
  }, []);

  const handleSelectPasteLink = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setPairLinkTitle(undefined);
    setIsPasteLinkVisible(true);
  }, []);

  const handleSelectTailscale = useCallback(() => {
    setIsAddHostMethodVisible(false);
    // ADR-0056: "Sign in to Tailscale" joins this device to the tailnet so
    // tailnet-only pairing links work. Pairing itself stays on Scan/Paste.
    router.push({
      pathname: "/tailscale-login",
      params: getTailscaleSnapshot().kind === "connected" ? { manage: "true" } : {},
    });
  }, [router]);

  const handleHostAdded = useCallback(
    ({ serverId }: { serverId: string }) => {
      const target = buildClientHostSettingsRoute(serverId);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const { registerBeforeLeave, guardNavigation } = useSettingsBeforeLeaveGuard();

  const handleSelectSection = useCallback(
    (section: SettingsSectionSlug) => {
      const target = buildSettingsSectionRoute(section);
      guardNavigation(() => {
        if (isCompactLayout) {
          router.push(target);
        } else {
          router.replace(target);
        }
      });
    },
    [guardNavigation, isCompactLayout, router],
  );

  // Picker: choose the host for host-section rows. If the user is already on a
  // host detail route, keep that detail section and swap only the host segment.
  const handleSelectHostNow = useCallback(
    (serverId: string) => {
      selectSettingsHost(serverId);
      if (view.kind === "project") {
        const target = buildSettingsHostSectionRoute(serverId, "projects");
        if (isCompactLayout) {
          router.push(target);
        } else {
          router.replace(target);
        }
        return;
      }
      if (view.kind !== "host") {
        return;
      }
      const target = buildSettingsHostSectionRoute(serverId, view.section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router, view],
  );
  const handleSelectHost = useCallback(
    (serverId: string) => {
      if (view.kind === "host" && view.serverId === serverId) {
        selectSettingsHost(serverId);
        return;
      }
      guardNavigation(() => handleSelectHostNow(serverId));
    },
    [guardNavigation, handleSelectHostNow, view],
  );

  const handleSelectHostSection = useCallback(
    (section: HostSectionSlug) => {
      if (!activeHostServerId) {
        handleAddHost();
        return;
      }
      const target = buildSettingsHostSectionRoute(activeHostServerId, section);
      guardNavigation(() => {
        if (isCompactLayout) {
          router.push(target);
        } else {
          router.replace(target);
        }
      });
    },
    [activeHostServerId, guardNavigation, handleAddHost, isCompactLayout, router],
  );

  const handleScanQr = useCallback(() => {
    closeAddConnectionFlow();
    router.push({
      pathname: "/pair-scan",
      params: { source: "settings" },
    });
  }, [closeAddConnectionFlow, router]);

  const handleHostRemoved = useCallback(() => {
    // A phone with no host goes back to "Connect your workstation"; the desktop
    // and the browser go back through the startup route.
    router.replace(isNative ? "/pair-start?step=connect" : "/");
  }, [router]);

  const handleBackToRoot = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/settings");
    }
  }, [router]);

  const detailProjectServerId = view.kind === "project" ? view.serverId : null;
  const isClientHostView = view.kind === "clientHost";
  const handleBackFromDetail = useCallback(() => {
    guardNavigation(() => {
      if (detailProjectServerId) {
        router.navigate(buildSettingsHostSectionRoute(detailProjectServerId, "projects"));
        return;
      }
      if (isClientHostView) {
        router.navigate(buildSettingsSectionRoute("hosts"));
        return;
      }
      handleBackToRoot();
    });
  }, [detailProjectServerId, guardNavigation, handleBackToRoot, isClientHostView, router]);

  const handleOpenClientHost = useCallback(
    (serverId: string) => {
      const target = buildClientHostSettingsRoute(serverId);
      guardNavigation(() => router.push(target));
    },
    [guardNavigation, router],
  );
  const enableBuiltInDaemonOption = useEnableBuiltInDaemonOption();

  const handleBackToWorkspace = useCallback(() => {
    guardNavigation(() => {
      if (navigateToLastWorkspace()) {
        return;
      }
      router.replace(buildOpenProjectRoute());
    });
  }, [guardNavigation, router]);

  const installedPlugins = useInstalledPlugins();
  const pluginDisplayName = usePluginDisplayName(view.kind === "plugin" ? view : null);
  const pluginDescription = usePluginDescription(view.kind === "plugin" ? view : null);
  const pageDescription = settingsPageDescription(view, pluginDescription);
  // The header draws its divider once the page body leaves its top (spec 38 §4.4c).
  const [detailScrolled, setDetailScrolled] = useState(false);
  const viewKey = JSON.stringify(view);
  useEffect(() => setDetailScrolled(false), [viewKey]);
  const handleDetailScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setDetailScrolled(event.nativeEvent.contentOffset.y > 0);
  }, []);
  const detailHeader = ((): {
    title: string;
    Icon: ComponentType<{ size: number; color: string }>;
    titleAccessory?: ReactNode;
  } | null => {
    if (view.kind === "plugin") {
      const screen = installedPlugins
        .find((plugin) => plugin.serverId === view.serverId && plugin.id === view.pluginId)
        ?.settingsScreens.find((candidate) => candidate.id === view.screenId);
      return {
        title: pluginDisplayName ?? view.pluginId,
        Icon: screen ? resolvePluginIcon(screen.icon) : Puzzle,
      };
    }
    if (view.kind === "host") {
      const item = HOST_SECTION_ITEMS.find((s) => s.id === view.section);
      if (!item) return null;
      return { title: t(item.labelKey), Icon: item.icon };
    }
    if (view.kind === "section") {
      const item = SIDEBAR_SECTION_ITEMS.find((s) => s.id === view.section);
      if (!item) return null;
      return { title: t(item.labelKey), Icon: item.icon };
    }
    if (view.kind === "project") {
      return { title: t("settings.projects"), Icon: FolderGit2 };
    }
    if (view.kind === "clientHost") {
      const host = hosts.find((candidate) => candidate.serverId === view.serverId);
      return { title: host?.label ?? t("settings.sections.hosts"), Icon: Laptop };
    }
    return null;
  })();

  const content = (() => {
    if (view.kind === "plugin") {
      return (
        <PluginSettingsContent
          serverId={view.serverId}
          pluginId={view.pluginId}
          screenId={view.screenId}
          onBackToPlugins={handleBackFromDetail}
          showBackToPlugins={!isCompactLayout}
        />
      );
    }
    if (view.kind === "host") {
      return renderHostSettingsContent(view);
    }
    if (view.kind === "clientHost") {
      return (
        <ClientHostDetailPage
          serverId={view.serverId}
          onAddConnection={handleAddHost}
          onHostRemoved={handleHostRemoved}
        />
      );
    }
    if (view.kind === "project") {
      return <ProjectSettingsScreen serverId={view.serverId} projectId={view.projectId} />;
    }
    if (view.kind === "section") {
      switch (view.section) {
        case "general":
          return (
            <>
              <GeneralSection
                settings={settings}
                isDesktopApp={isDesktopApp}
                handleServiceUrlBehaviorChange={handleServiceUrlBehaviorChange}
                handleLanguageChange={handleLanguageChange}
              />
              {isDesktopApp ? <IntegrationsSection /> : null}
            </>
          );
        case "hosts":
          return (
            <ClientHostsSection
              onSelectHost={handleOpenClientHost}
              onAddHost={handleAddHost}
              enableBuiltInDaemonOption={enableBuiltInDaemonOption}
            />
          );
        case "sidebar":
          return <SidebarViewPicker />;
        case "appearance":
          return <AppearanceSection />;
        case "chat":
          return (
            <>
              <ChatSection
                settings={settings}
                handleSendBehaviorChange={handleSendBehaviorChange}
                handleSendShortcutChange={handleSendShortcutChange}
                handleTerminalScrollbackLinesChange={handleTerminalScrollbackLinesChange}
              />
              <EditorSection />
              {isDesktopApp ? <BrowserDataSection /> : null}
            </>
          );
        case "shortcuts":
          return isDesktopApp ? <KeyboardShortcutsSection /> : null;
        case "notifications":
          return isDesktopApp ? <DesktopPermissionsSection /> : null;
        case "diagnostics":
          return (
            <DiagnosticsSection
              voiceAudioEngine={voiceAudioEngine}
              isPlaybackTestRunning={isPlaybackTestRunning}
              playbackTestResult={playbackTestResult}
              handlePlaybackTest={handlePlaybackTest}
            />
          );
      }
    }
    return null;
  })();

  if (settingsLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>{t("settings.loading")}</Text>
      </View>
    );
  }

  const desktopDetailHeaderLeft = detailHeader ? (
    <>
      <HeaderIconBadge>
        <detailHeader.Icon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      </HeaderIconBadge>
      <ScreenTitle testID="settings-detail-header-title">{detailHeader.title}</ScreenTitle>
      {detailHeader.titleAccessory}
    </>
  ) : null;

  const addHostModals = (
    <>
      <AddHostMethodModal
        visible={isAddHostMethodVisible}
        onClose={closeAddConnectionFlow}
        onDirectConnection={handleSelectDirectConnection}
        onPasteLink={handleSelectPasteLink}
        onTailscale={handleSelectTailscale}
        onScanQr={handleScanQr}
      />
      <AddHostModal
        visible={isDirectHostVisible}
        onClose={closeAddConnectionFlow}
        onCancel={closeAddConnectionFlow}
        onSaved={handleHostAdded}
      />
      <PairLinkModal
        visible={isPasteLinkVisible}
        onClose={closeAddConnectionFlow}
        onCancel={closeAddConnectionFlow}
        onSaved={handleHostAdded}
        title={pairLinkTitle}
      />
    </>
  );

  // Mobile root: full-screen sidebar-as-list.
  if (isCompactLayout && view.kind === "root") {
    return (
      <View style={styles.container}>
        <BackHeader title={t("settings.title")} onBack={handleBackToWorkspace} />
        <SettingsScrollView
          {...settingsScrollProps}
          style={styles.scrollView}
          contentContainerStyle={insetBottomStyle}
          testID="settings-detail-scroll-body"
        >
          <SettingsSidebar
            view={view}
            onSelectSection={handleSelectSection}
            onSelectHostSection={handleSelectHostSection}
            onSelectHost={handleSelectHost}
            onAddHost={handleAddHost}
            onBackToWorkspace={handleBackToWorkspace}
            activeHostServerId={activeHostServerId}
            layout="mobile"
          />
        </SettingsScrollView>
        {addHostModals}
      </View>
    );
  }

  const agentProfilesServerId =
    view.kind === "host" && view.section === "agent-profiles" ? view.serverId : null;

  if (isCompactLayout && agentProfilesServerId) {
    return (
      <View style={styles.container}>
        <HostAgentProfilesPage
          serverId={agentProfilesServerId}
          description={pageDescription}
          onBack={handleBackFromDetail}
          onRegisterBeforeLeave={registerBeforeLeave}
        />
        {addHostModals}
      </View>
    );
  }

  if (isCompactLayout) {
    return (
      <View style={styles.container}>
        <BackHeader
          title={detailHeader?.title}
          titleAccessory={detailHeader?.titleAccessory}
          onBack={handleBackFromDetail}
        />
        <SettingsScrollView
          {...settingsScrollProps}
          style={styles.scrollView}
          contentContainerStyle={insetBottomStyle}
          testID="settings-detail-scroll-body"
        >
          <View style={styles.content}>
            <Text style={styles.compactDescription} testID="settings-page-description">
              {pageDescription}
            </Text>
            {content}
          </View>
        </SettingsScrollView>
        {addHostModals}
      </View>
    );
  }

  const settingsSidebar = (
    <SettingsSidebar
      view={view}
      onSelectSection={handleSelectSection}
      onSelectHostSection={handleSelectHostSection}
      onSelectHost={handleSelectHost}
      onAddHost={handleAddHost}
      onBackToWorkspace={handleBackToWorkspace}
      activeHostServerId={activeHostServerId}
      layout="desktop"
    />
  );
  return (
    <View style={styles.container}>
      <View style={desktopStyles.row}>
        {gumloopDesktop ? (
          <Portal hostName={GUMLOOP_PANEL_HOST}>
            {isRouteFocused ? (
              <ScrollView style={sidebarStyles.scrollBody} testID="gumloop-settings-panel">
                <SettingsSidebar
                  view={view}
                  onSelectSection={handleSelectSection}
                  onSelectHostSection={handleSelectHostSection}
                  onSelectHost={handleSelectHost}
                  onAddHost={handleAddHost}
                  onBackToWorkspace={handleBackToWorkspace}
                  activeHostServerId={activeHostServerId}
                  layout="mobile"
                />
              </ScrollView>
            ) : null}
          </Portal>
        ) : (
          <WindowChromeRegion corners="top-left">{settingsSidebar}</WindowChromeRegion>
        )}
        <WindowChromeRegion corners="top-right">
          <View style={desktopStyles.contentPane} testID="settings-detail-pane">
            {agentProfilesServerId ? (
              <HostAgentProfilesPage
                serverId={agentProfilesServerId}
                description={pageDescription}
                onRegisterBeforeLeave={registerBeforeLeave}
              />
            ) : (
              <SettingsDesktopDetail
                title={detailHeader?.title}
                description={pageDescription}
                scrolled={detailScrolled}
                headerLeft={desktopDetailHeaderLeft}
                onScroll={handleDetailScroll}
                contentContainerStyle={insetBottomStyle}
                gumloopDesktop={gumloopDesktop}
              >
                {content}
              </SettingsDesktopDetail>
            )}
          </View>
        </WindowChromeRegion>
      </View>
      {addHostModals}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
    backgroundColor: theme.chrome.pageCanvas,
  },
  // Full width on the shared page gutter, like every Gumloop page (spec 38 §4.1, A38.4i). The
  // 8 px top padding keeps the first row off the header's divider (spec 38 §4.4c).
  gumloopContent: {
    maxWidth: "100%",
    paddingHorizontal: GUMLOOP_PAGE_GUTTER,
    paddingTop: 8,
    alignSelf: "stretch",
  },
  compactDescription: {
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[4],
  },
  content: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  themeTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  themeTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  terminalScrollbackInput: {
    width: 112,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

const desktopStyles = StyleSheet.create((theme) => ({
  row: {
    flex: 1,
    flexDirection: "row",
  },
  contentPane: {
    flex: 1,
    minWidth: SETTINGS_DESKTOP_DETAIL_MIN_WIDTH,
  },
  detailLeft: {
    gap: theme.spacing[2],
  },
}));

const sidebarStyles = StyleSheet.create((theme) => ({
  gumloopContainer: { paddingHorizontal: 10, paddingBottom: 16 },
  gumloopIsland: { gap: 3 },
  gumloopList: { paddingHorizontal: 0, gap: 3 },
  // Group titles read like the sidebar's Tools and Projects headings: 14 px muted (spec 38 §4.2).
  gumloopGroupLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  desktopContainer: {
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
    flexShrink: 1,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  scrollBody: {
    flex: 1,
  },
  sidebarDragArea: {
    position: "relative",
  },
  mobileContainer: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  // Compact values draw each group as an island of tiles; desktop keeps a plain list.
  group: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    gap: { xs: theme.spacing[1], md: theme.spacing[0.5] },
  },
  groupLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    paddingVertical: theme.spacing[1],
  },
  island: {
    gap: { xs: 2, md: theme.spacing[0.5] },
    borderRadius: { xs: theme.borderRadius["2xl"], md: 0 },
    overflow: "hidden",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: { xs: theme.spacing[3], md: theme.spacing[2] },
    minHeight: { xs: 52, md: 36 },
    paddingVertical: theme.spacing[1],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    borderRadius: { xs: 0, md: theme.borderRadius.lg },
    backgroundColor: { xs: theme.colors.surface1, md: "transparent" },
  },
  itemHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  itemSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // The workspace rows' pressed fill.
  itemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    fontSize: { xs: theme.fontSize.lg, md: theme.fontSize.base },
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
  pickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: { xs: theme.spacing[3], md: theme.spacing[2] },
    minHeight: { xs: 52, md: 36 },
    paddingVertical: theme.spacing[1],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    borderRadius: { xs: 0, md: theme.borderRadius.lg },
    backgroundColor: { xs: theme.colors.surface1, md: "transparent" },
  },
  pickerTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  pickerTriggerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: { xs: theme.fontSize.lg, md: theme.fontSize.base },
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  gumloopPickerTriggerLabel: { fontSize: theme.fontSize.sm, fontWeight: "500" },
  // Match the setting items' icon footprint so the host label aligns with them.
  pickerTriggerDot: {
    width: densityIconBox("md"),
    height: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
  },
}));
