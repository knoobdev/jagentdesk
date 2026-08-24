import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

interface ClusterPodShellProps {
  serverId: string;
  clusterId: string;
  namespace: string;
  pod: string;
  container?: string;
  onClose: () => void;
}

export function ClusterPodShell({
  serverId,
  clusterId,
  namespace,
  pod,
  container,
  onClose,
}: ClusterPodShellProps) {
  const client = useHostRuntimeClient(serverId);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const execRef = useRef<{ write: (d: string) => void; close: () => Promise<void> } | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!client) {
      setError("No client connection");
      return;
    }

    cancelledRef.current = false;

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    client
      .clusterExecStart(
        {
          id: clusterId,
          namespace,
          pod,
          ...(container ? { container } : {}),
          command: ["/bin/sh"],
        },
        (data: string) => {
          if (cancelledRef.current) return;
          setOutput((prev) => {
            const combined = prev + data;
            const lines = combined.split("\n");
            if (lines.length > 2000) {
              return lines.slice(lines.length - 2000).join("\n");
            }
            return combined;
          });
        },
      )
      .then((exec) => {
        if (cancelledRef.current) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          exec.close();
          return undefined;
        }
        execRef.current = exec;
        return undefined;
      })
      .catch((e: unknown) => {
        if (cancelledRef.current) return;
        setError(e instanceof Error ? e.message : "Exec failed");
      });

    return () => {
      cancelledRef.current = true;
      if (execRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        execRef.current.close();
        execRef.current = null;
      }
    };
  }, [client, clusterId, namespace, pod, container]);

  // Auto-scroll on new output
  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 50);
    return () => clearTimeout(timer);
  }, [output]);

  const handleSend = useCallback(() => {
    const text = input;
    if (!text || !execRef.current) return;
    execRef.current.write(text + "\n");
    setInput("");
  }, [input]);

  const handleClose = useCallback(() => {
    cancelledRef.current = true;
    if (execRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      execRef.current.close();
      execRef.current = null;
    }
    onClose();
  }, [onClose]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerText}>Shell</Text>
        <Pressable style={styles.closeButton} onPress={handleClose}>
          <Text style={styles.closeButtonText}>Close</Text>
        </Pressable>
      </View>
      {error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <ScrollView ref={scrollRef} style={styles.outputScroll} nestedScrollEnabled>
          <Text style={styles.outputText} selectable>
            {output || " "}
          </Text>
        </ScrollView>
      )}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholder="Type a command..."
          placeholderTextColor="#71717a"
          returnKeyType="send"
        />
        <Pressable
          style={[styles.sendButton, !input ? styles.sendButtonDisabled : null]}
          onPress={handleSend}
          disabled={!input}
        >
          <Text style={styles.sendButtonText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 300,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#27272a",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  headerText: {
    fontSize: 12,
    fontWeight: "500",
    color: "#71717a",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  closeButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#27272a",
    backgroundColor: "#1f1f22",
  },
  closeButtonText: {
    fontSize: 12,
    fontWeight: "500",
    color: "#fafafa",
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 120,
  },
  errorText: {
    fontSize: 14,
    color: "#ef4444",
  },
  outputScroll: {
    flex: 1,
    minHeight: 160,
    backgroundColor: "#18181b",
    borderRadius: 6,
    padding: 12,
  },
  outputText: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#d4d4d8",
    lineHeight: 20,
    flexWrap: "wrap",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#27272a",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 12,
    color: "#fafafa",
    backgroundColor: "#1f1f22",
    fontFamily: "monospace",
  },
  sendButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: "#20744A",
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    fontSize: 12,
    fontWeight: "500",
    color: "#ffffff",
  },
});
