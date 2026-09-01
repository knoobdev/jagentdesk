import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Database as DatabaseIcon, CircleAlert, Plus, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { DatabaseStatusDot } from "@/components/database-dot";
import { buildDatabaseBrowseRoute } from "@/utils/host-routes";
import { useDatabaseNavStore } from "@/stores/database-nav-store";
import type { Theme } from "@/styles/theme";
import type {
  DatabaseEngine,
  DatabaseInfo,
  DbConnectionConfig,
} from "@jagentdesk/protocol/database/rpc-schemas";

// All engines have a live adapter (SQLite/PG/MySQL/SQL Server/Oracle/Mongo/
// ClickHouse). For Oracle the "Database" field is the service name (e.g. FREEPDB1).
const ENGINES: Array<{ key: DatabaseEngine; label: string; defaultPort?: number; file?: boolean }> =
  [
    { key: "postgres", label: "PostgreSQL", defaultPort: 5432 },
    { key: "mysql", label: "MySQL", defaultPort: 3306 },
    { key: "sqlite", label: "SQLite", file: true },
    { key: "mssql", label: "SQL Server", defaultPort: 1433 },
    { key: "oracle", label: "Oracle", defaultPort: 1521 },
    { key: "mongodb", label: "MongoDB", defaultPort: 27017 },
    { key: "clickhouse", label: "ClickHouse", defaultPort: 8123 },
  ];

interface DraftForm {
  engine: DatabaseEngine;
  displayName: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  dsn: string;
  file: string;
  useDsn: boolean;
}

function emptyDraft(engine: DatabaseEngine): DraftForm {
  const meta = ENGINES.find((e) => e.key === engine);
  return {
    engine,
    displayName: "",
    host: "127.0.0.1",
    port: meta?.defaultPort ? String(meta.defaultPort) : "",
    database: "",
    user: "",
    password: "",
    dsn: "",
    file: "",
    useDsn: false,
  };
}

function draftToConfig(d: DraftForm): DbConnectionConfig {
  if (d.engine === "sqlite") return { file: d.file.trim() };
  if (d.useDsn) return { dsn: d.dsn.trim() };
  const config: DbConnectionConfig = {};
  if (d.host.trim()) config.host = d.host.trim();
  if (d.port.trim()) config.port = Number(d.port.trim());
  if (d.database.trim()) config.database = d.database.trim();
  if (d.user.trim()) config.user = d.user.trim();
  if (d.password) config.password = d.password;
  return config;
}

function ConnectionRow({
  db,
  busy,
  onConnect,
  onOpen,
  onDisconnect,
  onRemove,
}: {
  db: DatabaseInfo;
  busy: boolean;
  onConnect: (id: string) => void;
  onOpen: (id: string) => void;
  onDisconnect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const connected = db.state === "connected";
  const errored = db.state === "error";
  const working = busy || db.state === "connecting";
  const handleConnect = useCallback(() => onConnect(db.id), [onConnect, db.id]);
  const handleOpen = useCallback(() => onOpen(db.id), [onOpen, db.id]);
  const handleDisconnect = useCallback(() => onDisconnect(db.id), [onDisconnect, db.id]);
  const handleRemove = useCallback(() => onRemove(db.id), [onRemove, db.id]);

  let connectLabel = "Connect";
  if (working) connectLabel = "Connecting…";
  else if (errored) connectLabel = "Retry";

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <DatabaseStatusDot state={db.state} />
        <View style={styles.rowInfo}>
          <Text style={styles.rowName} numberOfLines={1}>
            {db.displayName}
          </Text>
          <Text style={styles.rowTarget} numberOfLines={1}>
            {db.engine} · {db.target || "—"}
            {connected && db.serverVersion ? ` · ${db.serverVersion}` : ""}
          </Text>
        </View>
        {connected ? null : (
          <Pressable
            style={[styles.btn, styles.btnPrimary, working && styles.btnDisabled]}
            onPress={handleConnect}
            disabled={working}
          >
            <Text style={styles.btnPrimaryText}>{connectLabel}</Text>
          </Pressable>
        )}
        <Pressable style={styles.iconBtn} onPress={handleRemove} accessibilityLabel="Remove">
          <ThemedTrash size={15} uniProps={mutedColorMapping} />
        </Pressable>
      </View>

      {errored && db.lastError ? (
        <View style={styles.rowError}>
          <ThemedCircleAlert size={13} uniProps={redColorMapping} />
          <Text style={styles.rowErrorText} numberOfLines={4}>
            {db.lastError}
          </Text>
        </View>
      ) : null}

      {connected ? (
        <View style={styles.rowActions}>
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={handleOpen}>
            <Text style={styles.btnPrimaryText}>Open</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={handleDisconnect}>
            <Text style={styles.btnGhostText}>Disconnect</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

type DraftKey = "displayName" | "host" | "port" | "database" | "user" | "password" | "dsn" | "file";

function Field({
  label,
  fieldKey,
  value,
  onChange,
  placeholder,
  secureTextEntry,
  keyboardType,
}: {
  label: string;
  fieldKey: DraftKey;
  value: string;
  onChange: (key: DraftKey, value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: "default" | "numeric";
}) {
  const handleChange = useCallback((v: string) => onChange(fieldKey, v), [fieldKey, onChange]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <ThemedTextInput
        style={styles.input}
        value={value}
        onChangeText={handleChange}
        placeholder={placeholder}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        uniProps={placeholderColorMapping}
      />
    </View>
  );
}

function EngineChip({
  engine,
  label,
  active,
  onSelect,
}: {
  engine: DatabaseEngine;
  label: string;
  active: boolean;
  onSelect: (engine: DatabaseEngine) => void;
}) {
  const handlePress = useCallback(() => onSelect(engine), [engine, onSelect]);
  return (
    <Pressable style={[styles.engineChip, active && styles.engineChipActive]} onPress={handlePress}>
      <Text style={[styles.engineChipText, active && styles.engineChipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function DatabasesScreen() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const clearLastDatabase = useDatabaseNavStore((s) => s.clearLastDatabase);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();

  const contentContainerStyle = useMemo(
    () => [styles.contentContainer, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DraftForm>(() => emptyDraft("postgres"));
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      const res = await client.databaseList();
      if (res.error) setError(res.error);
      else setDatabases(res.databases);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load databases");
    }
  }, [client]);

  useEffect(() => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [client, refresh]);

  const setEngine = useCallback((engine: DatabaseEngine) => {
    setDraft((d) => ({ ...emptyDraft(engine), displayName: d.displayName }));
  }, []);

  const updateField = useCallback((key: DraftKey, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);
  const useFieldsMode = useCallback(() => setDraft((d) => ({ ...d, useDsn: false })), []);
  const useDsnMode = useCallback(() => setDraft((d) => ({ ...d, useDsn: true })), []);

  const handleSave = useCallback(
    async (connectAfter: boolean) => {
      if (!client) return;
      setSaving(true);
      setError(null);
      try {
        const res = await client.databaseAdd({
          engine: draft.engine,
          displayName: draft.displayName.trim() || undefined,
          config: draftToConfig(draft),
        });
        if (res.error || !res.database) {
          setError(res.error ?? "Add failed");
          return;
        }
        const id = res.database.id;
        setAdding(false);
        setDraft(emptyDraft("postgres"));
        await refresh();
        if (connectAfter) {
          setBusyId(id);
          const con = await client.databaseConnect({ id });
          if (con.error) setError(con.error);
          await refresh();
          setBusyId(null);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Add failed");
      } finally {
        setSaving(false);
      }
    },
    [client, draft, refresh],
  );

  const handleConnect = useCallback(
    async (id: string) => {
      if (!client) return;
      setBusyId(id);
      setError(null);
      try {
        const con = await client.databaseConnect({ id });
        if (con.error) setError(con.error);
        await refresh();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Connect failed");
      } finally {
        setBusyId(null);
      }
    },
    [client, refresh],
  );

  const handleOpen = useCallback(
    (id: string) => {
      router.push(buildDatabaseBrowseRoute(serverId, id));
    },
    [router, serverId],
  );

  const handleDisconnect = useCallback(
    (id: string) => {
      if (!client) return;
      setError(null);
      clearLastDatabase(id);
      void client
        .databaseDisconnect({ id })
        .then((res) => {
          if (res.error) setError(res.error);
          return refresh();
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Disconnect failed"));
    },
    [client, refresh, clearLastDatabase],
  );

  const handleRemove = useCallback(
    (id: string) => {
      if (!client) return;
      setError(null);
      clearLastDatabase(id);
      void client
        .databaseRemove({ id })
        .then((res) => {
          if (res.error) setError(res.error);
          return refresh();
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Remove failed"));
    },
    [client, refresh, clearLastDatabase],
  );

  const toggleAdding = useCallback(() => setAdding((v) => !v), []);
  const handleSaveConnect = useCallback(() => void handleSave(true), [handleSave]);
  const handleSaveOnly = useCallback(() => void handleSave(false), [handleSave]);

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ThemedLoadingSpinner size="large" uniProps={mutedColorMapping} />
      </View>
    );
  }

  const isSqlite = draft.engine === "sqlite";

  return (
    <ScrollView style={styles.container} contentContainerStyle={contentContainerStyle}>
      <View style={styles.headerRow}>
        <ThemedDatabase size={20} uniProps={foregroundColorMapping} />
        <Text style={styles.header}>Databases</Text>
        <View style={styles.headerSpacer} />
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={toggleAdding}>
          <ThemedPlus size={14} uniProps={accentForegroundColorMapping} />
          <Text style={styles.btnPrimaryText}>Add connection</Text>
        </Pressable>
      </View>
      <Text style={styles.headerHint}>
        Connect a database, then browse its schema, run SQL, and chat with a schema-grounded agent.
        Credentials are encrypted on the daemon and never leave it.
      </Text>

      {error ? (
        <View style={styles.errorBanner}>
          <ThemedCircleAlert size={16} uniProps={redColorMapping} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {adding ? (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>New connection</Text>
          <View style={styles.engineRow}>
            {ENGINES.map((e) => (
              <EngineChip
                key={e.key}
                engine={e.key}
                label={e.label}
                active={draft.engine === e.key}
                onSelect={setEngine}
              />
            ))}
          </View>

          <Field
            label="Display name (optional)"
            fieldKey="displayName"
            value={draft.displayName}
            onChange={updateField}
            placeholder="My database"
          />

          {isSqlite ? (
            <Field
              label="SQLite file path"
              fieldKey="file"
              value={draft.file}
              onChange={updateField}
              placeholder="/path/to/db.sqlite"
            />
          ) : (
            <>
              <View style={styles.toggleRow}>
                <Pressable
                  style={[styles.toggleChip, !draft.useDsn && styles.toggleChipActive]}
                  onPress={useFieldsMode}
                >
                  <Text style={[styles.toggleText, !draft.useDsn && styles.toggleTextActive]}>
                    Fields
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.toggleChip, draft.useDsn && styles.toggleChipActive]}
                  onPress={useDsnMode}
                >
                  <Text style={[styles.toggleText, draft.useDsn && styles.toggleTextActive]}>
                    Connection string
                  </Text>
                </Pressable>
              </View>
              {draft.useDsn ? (
                <Field
                  label="Connection string (DSN)"
                  fieldKey="dsn"
                  value={draft.dsn}
                  onChange={updateField}
                  placeholder={
                    draft.engine === "postgres"
                      ? "postgres://user:pass@host:5432/db"
                      : "mysql://user:pass@host:3306/db"
                  }
                />
              ) : (
                <>
                  <View style={styles.fieldRow}>
                    <View style={styles.fieldGrow}>
                      <Field
                        label="Host"
                        fieldKey="host"
                        value={draft.host}
                        onChange={updateField}
                        placeholder="127.0.0.1"
                      />
                    </View>
                    <View style={styles.fieldPort}>
                      <Field
                        label="Port"
                        fieldKey="port"
                        value={draft.port}
                        onChange={updateField}
                        keyboardType="numeric"
                      />
                    </View>
                  </View>
                  <Field
                    label="Database"
                    fieldKey="database"
                    value={draft.database}
                    onChange={updateField}
                    placeholder="postgres"
                  />
                  <Field
                    label="User"
                    fieldKey="user"
                    value={draft.user}
                    onChange={updateField}
                    placeholder="postgres"
                  />
                  <Field
                    label="Password"
                    fieldKey="password"
                    value={draft.password}
                    onChange={updateField}
                    secureTextEntry
                  />
                </>
              )}
            </>
          )}

          <View style={styles.formActions}>
            <Pressable
              style={[styles.btn, styles.btnPrimary, saving && styles.btnDisabled]}
              onPress={handleSaveConnect}
              disabled={saving}
            >
              <Text style={styles.btnPrimaryText}>{saving ? "Saving…" : "Save & connect"}</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, styles.btnGhost, saving && styles.btnDisabled]}
              onPress={handleSaveOnly}
              disabled={saving}
            >
              <Text style={styles.btnGhostText}>Save only</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={toggleAdding}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {databases.length === 0 && !adding ? (
        <Text style={styles.emptyText}>
          No connections yet. Add one to start browsing schema and running SQL.
        </Text>
      ) : (
        <View style={styles.sectionCard}>
          {databases.map((db) => (
            <ConnectionRow
              key={db.id}
              db={db}
              busy={busyId === db.id}
              onConnect={handleConnect}
              onOpen={handleOpen}
              onDisconnect={handleDisconnect}
              onRemove={handleRemove}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const ThemedDatabase = withUnistyles(DatabaseIcon);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedPlus = withUnistyles(Plus);
const ThemedTrash = withUnistyles(Trash2);
const ThemedTextInput = withUnistyles(TextInput);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentForegroundColorMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const redColorMapping = (theme: Theme) => ({ color: theme.colors.palette.red[500] });
const placeholderColorMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    padding: theme.spacing[4],
    flexGrow: 1,
    gap: theme.spacing[3],
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 120,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerSpacer: {
    flex: 1,
  },
  header: {
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  headerHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: -theme.spacing[2],
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.palette.red[100],
    borderRadius: theme.borderRadius.lg,
  },
  errorText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[800],
  },
  formCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  formTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  engineRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  engineChip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  engineChipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
  engineChipText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  engineChipTextActive: {
    color: theme.colors.accentForeground,
  },
  toggleRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  toggleChip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  toggleChipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  toggleText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  toggleTextActive: {
    color: theme.colors.foreground,
  },
  field: {
    gap: theme.spacing[1],
  },
  fieldLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  fieldRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  fieldGrow: {
    flex: 1,
  },
  fieldPort: {
    width: 96,
  },
  input: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  formActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  sectionCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  row: {
    flexDirection: "column",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    paddingLeft: theme.spacing[4],
  },
  rowInfo: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  rowTarget: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowError: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[4],
    paddingTop: theme.spacing[1],
  },
  rowErrorText: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[500],
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  btnPrimary: {
    backgroundColor: theme.colors.accent,
  },
  btnPrimaryText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accentForeground,
  },
  btnGhost: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  btnGhostText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  iconBtn: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  btnDisabled: {
    opacity: 0.5,
  },
}));
