import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { MemoryCitationWire } from "@jagentdesk/protocol/memory";
import {
  AdaptiveModalSheet,
  useHostRuntimeClient,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";

const MAX_CITED_BYTES = 512 * 1024;
const CONTEXT_LINES = 8;

type CitedFile =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; lines: string[]; firstLine: number; found: boolean | null };

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The lines around the excerpt, or the top of the file when there is none. */
function excerptWindow(
  content: string,
  excerpt: string | undefined,
): Omit<Extract<CitedFile, { status: "ready" }>, "status"> {
  const lines = content.split("\n");
  if (!excerpt) return { lines: lines.slice(0, CONTEXT_LINES * 4), firstLine: 1, found: null };
  const needle = collapse(excerpt).split(" ")[0] ?? "";
  const found = collapse(content).includes(collapse(excerpt));
  const index = Math.max(
    0,
    lines.findIndex((line) => needle.length > 0 && line.includes(needle)),
  );
  const start = Math.max(0, index - CONTEXT_LINES);
  return { lines: lines.slice(start, index + CONTEXT_LINES * 2), firstLine: start + 1, found };
}

/** Opens a lesson's cited file read-only, at the excerpt (spec 42 §8). */
export function CitationSheet({
  serverId,
  root,
  citation,
  onClose,
}: {
  serverId: string;
  root: string | null;
  citation: MemoryCitationWire;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [file, setFile] = useState<CitedFile>({ status: "loading" });
  useEffect(() => {
    if (!client || !root) {
      setFile({ status: "error", error: t("memory.lesson.noRoot") });
      return undefined;
    }
    let active = true;
    client.readFile(root, citation.path, undefined, MAX_CITED_BYTES).then(
      (result) => {
        if (!active) return undefined;
        const content = new TextDecoder().decode(result.bytes);
        setFile({ status: "ready", ...excerptWindow(content, citation.excerpt) });
        return undefined;
      },
      (error: unknown) => {
        if (active)
          setFile({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [citation.excerpt, citation.path, client, root, t]);
  const header = useMemo(
    () => ({ title: citation.path, subtitle: citation.symbol }),
    [citation.path, citation.symbol],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      desktopMaxWidth={760}
      testID="memory-citation-sheet"
    >
      <View style={styles.body}>
        {citation.excerpt ? (
          <Text style={styles.meta}>
            {t("memory.lesson.excerpt", { excerpt: citation.excerpt })}
          </Text>
        ) : null}
        {file.status === "ready" && file.found !== null ? (
          <Text style={styles.meta} testID="memory-citation-found">
            {t(file.found ? "memory.lesson.excerptFound" : "memory.lesson.excerptMissing")}
          </Text>
        ) : null}
        {file.status === "error" ? <Text style={styles.meta}>{file.error}</Text> : null}
        {file.status === "loading" ? (
          <Text style={styles.meta}>{t("memory.lesson.loading")}</Text>
        ) : null}
        {file.status === "ready" ? (
          <ScrollView horizontal style={styles.code}>
            <Text style={styles.codeText} selectable>
              {file.lines
                .map((line, index) => `${String(file.firstLine + index).padStart(4)}  ${line}`)
                .join("\n")}
            </Text>
          </ScrollView>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  meta: { fontSize: 13, color: theme.colors.foregroundMuted },
  code: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  codeText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
}));
