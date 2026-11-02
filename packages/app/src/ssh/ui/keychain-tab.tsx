import { memo, useCallback } from "react";
import { Text, View } from "react-native";
import { Plus, Upload } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type { SshIdentity, SshKey, SshKnownHost } from "@jagentdesk/client/internal/daemon-client";
import {
  IconBtn,
  mutedTint,
  redTint,
  ThemedCopy,
  ThemedKeyRound,
  ThemedPencil,
  ThemedTrash,
} from "./primitives";
import { sshStyles as styles } from "./styles";

// Keychain (keys + identities) and Known hosts tabs (spec 25.13). Only public material
// and `has…` booleans reach the app; private keys and passwords stay in the daemon.

export interface KeychainActions {
  onGenerate: () => void;
  onImport: () => void;
  onCopyPublicKey: (key: SshKey) => void;
  onDeleteKey: (key: SshKey) => void;
  onAddIdentity: () => void;
  onEditIdentity: (identity: SshIdentity) => void;
  onDeleteIdentity: (identity: SshIdentity) => void;
}

const KeyRow = memo(function KeyRow({
  sshKey,
  actions,
}: {
  sshKey: SshKey;
  actions: KeychainActions;
}) {
  const handleCopy = useCallback(() => actions.onCopyPublicKey(sshKey), [actions, sshKey]);
  const handleDelete = useCallback(() => actions.onDeleteKey(sshKey), [actions, sshKey]);
  return (
    <View style={styles.trow} testID={`ssh-key-row-${sshKey.id}`}>
      <View style={styles.colName}>
        <Text style={styles.cellStrong} numberOfLines={1}>
          {sshKey.label}
        </Text>
        <Text style={styles.cellMono} numberOfLines={1} selectable>
          {sshKey.fingerprintSha256}
        </Text>
      </View>
      <Text style={styles.cell}>{sshKey.type}</Text>
      {sshKey.hasPassphrase ? <StatusBadge label="Passphrase" variant="muted" /> : null}
      <View style={styles.rowActions}>
        <IconBtn
          icon={ThemedCopy}
          tint={mutedTint}
          label="Copy public key"
          onPress={handleCopy}
          testID={`ssh-key-copy-${sshKey.id}`}
        />
        <IconBtn icon={ThemedTrash} tint={redTint} label="Delete key" onPress={handleDelete} />
      </View>
    </View>
  );
});

const IdentityRow = memo(function IdentityRow({
  identity,
  keys,
  actions,
}: {
  identity: SshIdentity;
  keys: SshKey[];
  actions: KeychainActions;
}) {
  const handleEdit = useCallback(() => actions.onEditIdentity(identity), [actions, identity]);
  const handleDelete = useCallback(() => actions.onDeleteIdentity(identity), [actions, identity]);
  let keyLabel = "no key";
  if (identity.keyId) {
    keyLabel = keys.find((key) => key.id === identity.keyId)?.label ?? "key removed";
  }
  return (
    <View style={styles.trow} testID={`ssh-identity-row-${identity.id}`}>
      <View style={styles.colName}>
        <Text style={styles.cellStrong} numberOfLines={1}>
          {identity.label}
        </Text>
        <Text style={styles.cellSub} numberOfLines={1}>
          {identity.username ?? "no username"} · {keyLabel}
        </Text>
      </View>
      {identity.hasPassword ? <StatusBadge label="Password saved" variant="muted" /> : null}
      <View style={styles.rowActions}>
        <IconBtn icon={ThemedPencil} tint={mutedTint} label="Edit identity" onPress={handleEdit} />
        <IconBtn icon={ThemedTrash} tint={redTint} label="Delete identity" onPress={handleDelete} />
      </View>
    </View>
  );
});

export function KeychainTab({
  keys,
  identities,
  actions,
}: {
  keys: SshKey[];
  identities: SshIdentity[];
  actions: KeychainActions;
}) {
  return (
    <>
      <View style={styles.sectionCard}>
        <View style={styles.cardHeader}>
          <ThemedKeyRound size={15} uniProps={mutedTint} />
          <Text style={styles.cardHeaderTitle}>Keys</Text>
          <View style={styles.headerSpacer} />
          <Button
            size="xs"
            variant="outline"
            leftIcon={Plus}
            onPress={actions.onGenerate}
            testID="ssh-key-generate"
          >
            Generate
          </Button>
          <Button
            size="xs"
            variant="outline"
            leftIcon={Upload}
            onPress={actions.onImport}
            testID="ssh-key-import"
          >
            Import
          </Button>
        </View>
        {keys.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.noticeBody}>
              No keys yet. Generate a key pair on the daemon, or import an existing private key.
            </Text>
          </View>
        ) : (
          keys.map((key) => <KeyRow key={key.id} sshKey={key} actions={actions} />)
        )}
      </View>
      <View style={styles.sectionCard}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardHeaderTitle}>Identities</Text>
          <View style={styles.headerSpacer} />
          <Button
            size="xs"
            variant="outline"
            leftIcon={Plus}
            onPress={actions.onAddIdentity}
            testID="ssh-identity-add"
          >
            Add identity
          </Button>
        </View>
        {identities.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.noticeBody}>
              An identity bundles a username with a password and/or a key. Servers and groups use
              it, so changing it here updates them all.
            </Text>
          </View>
        ) : (
          identities.map((identity) => (
            <IdentityRow key={identity.id} identity={identity} keys={keys} actions={actions} />
          ))
        )}
      </View>
    </>
  );
}

const KnownHostRow = memo(function KnownHostRow({
  host,
  onDelete,
}: {
  host: SshKnownHost;
  onDelete: (host: SshKnownHost) => void;
}) {
  const handleDelete = useCallback(() => onDelete(host), [host, onDelete]);
  return (
    <View style={styles.trow}>
      <View style={styles.colName}>
        <Text style={styles.cellStrong} numberOfLines={1}>
          {host.host}:{host.port}
        </Text>
        <Text style={styles.cellMono} numberOfLines={1} selectable>
          {host.fingerprintSha256}
        </Text>
      </View>
      <Text style={styles.cell}>{host.keyType}</Text>
      <Text style={styles.cell}>{new Date(host.addedAtMs).toLocaleDateString()}</Text>
      <View style={styles.rowActions}>
        <IconBtn
          icon={ThemedTrash}
          tint={redTint}
          label="Forget host key"
          onPress={handleDelete}
          testID={`known-hosts-delete-${host.host}-${host.port}`}
        />
      </View>
    </View>
  );
});

export function KnownHostsTab({
  knownHosts,
  onDelete,
}: {
  knownHosts: SshKnownHost[];
  onDelete: (host: SshKnownHost) => void;
}) {
  return (
    <View style={styles.sectionCard}>
      {knownHosts.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.noticeBody}>
            No host keys yet. Trusting a host key on first connect adds it here.
          </Text>
        </View>
      ) : (
        knownHosts.map((host) => (
          <KnownHostRow
            key={`${host.host}:${host.port}:${host.keyType}`}
            host={host}
            onDelete={onDelete}
          />
        ))
      )}
    </View>
  );
}
