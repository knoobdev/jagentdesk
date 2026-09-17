import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { useSessionStore } from "@/stores/session-store";
import { ArtifactHtmlPreview } from "./artifact-html-preview";
import { extractArtifacts, type Artifact } from "./extract";

const EMPTY_TEXT_STYLE: TextStyle = {};

// Canvas/Artifacts panel (ADR-0019 companion): renders the substantial fenced blocks the agent
// produced (HTML/SVG live preview, Mermaid diagrams, Markdown docs, or code) in a dedicated surface,
// with a picker across all artifacts in the current stream. Read-only; derived from the timeline the
// viewer already has, so guests need no extra daemon scope beyond chat.
export function ArtifactCanvas({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement {
  // Select the STABLE tail array reference straight from the store (Object.is-stable between renders
  // until the stream actually changes). Mapping/extracting here would return a fresh array of fresh
  // objects every call, which breaks useSyncExternalStore's snapshot caching and spins an infinite
  // render loop (React #185). Do the derivation in useMemo instead, keyed on the stable reference.
  const tail = useSessionStore((state) => state.sessions[serverId]?.agentStreamTail?.get(agentId));
  const artifacts = useMemo(
    () =>
      extractArtifacts(
        (tail ?? []).map((item) => ({
          type: item.kind,
          text: "text" in item && typeof item.text === "string" ? item.text : undefined,
        })),
      ),
    [tail],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const toggleSource = useCallback(() => setShowSource((v) => !v), []);

  const selected =
    artifacts.find((a) => a.id === selectedId) ?? artifacts[artifacts.length - 1] ?? null;

  if (artifacts.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No artifacts yet.</Text>
        <Text style={styles.emptyHint}>
          Code, HTML, SVG and diagrams the agent produces show up here.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
        <View style={styles.tabs}>
          {artifacts.map((a) => (
            <ArtifactTab
              key={a.id}
              artifact={a}
              active={selected?.id === a.id}
              onSelect={setSelectedId}
            />
          ))}
        </View>
      </ScrollView>
      {selected ? (
        <>
          {selected.kind === "html" || selected.kind === "svg" ? (
            <View style={styles.toolbar}>
              <Pressable
                style={styles.toggle}
                onPress={toggleSource}
                accessibilityLabel="Toggle artifact source"
              >
                <Text style={styles.toggleText}>{showSource ? "Preview" : "Code"}</Text>
              </Pressable>
            </View>
          ) : null}
          <View style={styles.body}>
            <ArtifactBody artifact={selected} showSource={showSource} />
          </View>
        </>
      ) : null}
    </View>
  );
}

function ArtifactBody({
  artifact,
  showSource,
}: {
  artifact: Artifact;
  showSource: boolean;
}): ReactElement {
  if (artifact.kind === "html") {
    return showSource ? (
      <ScrollView style={styles.codeScroll}>
        <HighlightedCodeBlock
          code={artifact.content}
          language="html"
          inheritedStyles={EMPTY_TEXT_STYLE}
          textStyle={EMPTY_TEXT_STYLE}
        />
      </ScrollView>
    ) : (
      <ArtifactHtmlPreview html={artifact.content} />
    );
  }
  if (artifact.kind === "svg") {
    return showSource ? (
      <ScrollView style={styles.codeScroll}>
        <HighlightedCodeBlock
          code={artifact.content}
          language="svg"
          inheritedStyles={EMPTY_TEXT_STYLE}
          textStyle={EMPTY_TEXT_STYLE}
        />
      </ScrollView>
    ) : (
      <ArtifactHtmlPreview
        html={`<!doctype html><html><body style="margin:0;display:flex;justify-content:center;align-items:center;height:100vh">${artifact.content}</body></html>`}
      />
    );
  }
  if (artifact.kind === "mermaid") {
    return (
      <ScrollView style={styles.codeScroll}>
        <MarkdownRenderer text={"```mermaid\n" + artifact.content + "\n```"} />
      </ScrollView>
    );
  }
  if (artifact.kind === "markdown") {
    return (
      <ScrollView style={styles.codeScroll}>
        <MarkdownRenderer text={artifact.content} />
      </ScrollView>
    );
  }
  return (
    <ScrollView style={styles.codeScroll}>
      <HighlightedCodeBlock
        code={artifact.content}
        language={artifact.language || null}
        inheritedStyles={EMPTY_TEXT_STYLE}
        textStyle={EMPTY_TEXT_STYLE}
      />
    </ScrollView>
  );
}

function ArtifactTab({
  artifact,
  active,
  onSelect,
}: {
  artifact: Artifact;
  active: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const onPress = useCallback(() => onSelect(artifact.id), [onSelect, artifact.id]);
  return (
    <Pressable style={[styles.tab, active ? styles.tabActive : null]} onPress={onPress}>
      <Text style={[styles.tabText, active ? styles.tabTextActive : null]} numberOfLines={1}>
        {artifact.title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  tabsScroll: {
    flexGrow: 0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  tabs: { flexDirection: "row", gap: theme.spacing[1], padding: theme.spacing[2] },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    maxWidth: 200,
  },
  tabActive: { backgroundColor: theme.colors.surface2 },
  tabText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  tabTextActive: { color: theme.colors.foreground, fontWeight: theme.fontWeight.semibold },
  toolbar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  toggle: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  toggleText: { color: theme.colors.foreground, fontSize: theme.fontSize.xs },
  body: { flex: 1 },
  codeScroll: { flex: 1, padding: theme.spacing[3] },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[2],
  },
  emptyText: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
