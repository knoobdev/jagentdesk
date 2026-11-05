import { default as React, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { History, RotateCcw, Trash2 } from "lucide-react-native";
import type { FigmaPendingOp } from "@jagentdesk/protocol/figma/rpc-schemas";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { callFigma, errorMessage } from "@/figma/api";
import {
  figmaKeys,
  useFigmaLinkStatus,
  useFigmaPending,
  useFigmaPendingPushInvalidator,
} from "@/figma/queries";
import { Badge, ErrorBanner } from "@/figma/ui/primitives";
import { figmaStyles } from "@/figma/ui/styles";
import type { FigmaFileRef } from "@/figma/contracts";
import {
  buildResolutions,
  canApplyPending,
  describePendingOp,
  isPendingBarVisible,
  summarizePending,
  type ConflictChoice,
} from "./state";

// The pending bar (spec 32.6.1): "N pending changes" over the file screen, a review list with
// per-op removal, Discard all, and Apply — enabled only through a linked file, with every
// conflict carrying a Keep mine / Keep Figma choice first. The file screen (W10) mounts it; the
// queue itself lives in the daemon and refreshes on figma.pending.changed pushes.

export function PendingBar({ file }: { file: FigmaFileRef }) {
  const { serverId, fileKey } = file;
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const pending = useFigmaPending(serverId, fileKey);
  useFigmaPendingPushInvalidator(serverId, fileKey);
  const linkStatus = useFigmaLinkStatus(serverId);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ops = useMemo(() => pending.data ?? [], [pending.data]);
  const summary = useMemo(() => summarizePending(ops), [ops]);
  const linked = (linkStatus.data?.files ?? []).some((f) => f.fileKey === fileKey && f.paired);
  const applyEnabled = canApplyPending(ops, linked, choices) && !file.version && !busy;

  const refresh = useCallback(() => {
    setChoices({});
    setError(null);
    void queryClient.invalidateQueries({ queryKey: figmaKeys.pending(serverId, fileKey) });
  }, [queryClient, serverId, fileKey]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const removeOp = useCallback(
    (entry: FigmaPendingOp) =>
      run(() => callFigma(client, "figma.pending.remove.request", { fileKey, opId: entry.id })),
    [client, fileKey, run],
  );
  const discardAll = useCallback(
    () => run(() => callFigma(client, "figma.pending.discard.request", { fileKey })),
    [client, fileKey, run],
  );
  const apply = useCallback(() => {
    const resolutions = buildResolutions(ops, choices);
    return run(() =>
      callFigma(client, "figma.pending.apply.request", {
        fileKey,
        ...(resolutions ? { resolutions } : {}),
      }),
    );
  }, [choices, client, fileKey, ops, run]);
  const choose = useCallback(
    (entry: FigmaPendingOp, choice: ConflictChoice) =>
      setChoices((current) => ({ ...current, [entry.id]: choice })),
    [],
  );
  const toggleReview = useCallback(() => setReviewOpen((open) => !open), []);
  const pressDiscard = useCallback(() => {
    void discardAll();
  }, [discardAll]);
  const pressApply = useCallback(() => {
    void apply();
  }, [apply]);

  if (!isPendingBarVisible(ops)) return null;

  const noun = summary.count === 1 ? "pending change" : "pending changes";
  return (
    <View testID="figma-pending-bar">
      {error ? <ErrorBanner message={error} /> : null}
      <View style={figmaStyles.pendingBar}>
        <Text style={figmaStyles.pendingCount} testID="figma-pending-count">
          {`${summary.count} ${noun}`}
        </Text>
        {summary.hasAgentOrigin ? <Badge label="from agent" testID="figma-pending-agent" /> : null}
        {summary.conflicts.length > 0 ? (
          <Badge label={`${summary.conflicts.length} conflicts`} testID="figma-pending-conflicts" />
        ) : null}
        <View style={figmaStyles.spacer} />
        <Button
          size="sm"
          variant="ghost"
          leftIcon={History}
          onPress={toggleReview}
          testID="figma-pending-review"
        >
          {reviewOpen ? "Hide" : "Review"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Trash2}
          disabled={busy}
          onPress={pressDiscard}
          testID="figma-pending-discard"
        >
          Discard all
        </Button>
        <Button
          size="sm"
          variant="default"
          leftIcon={RotateCcw}
          disabled={!applyEnabled}
          loading={busy}
          onPress={pressApply}
          testID="figma-pending-apply"
        >
          Apply
        </Button>
      </View>
      {!linked && summary.count > 0 ? (
        <View style={figmaStyles.pendingBar}>
          <Text style={figmaStyles.rowSubtle} testID="figma-pending-unlinked-hint">
            Link this file through the Figma plugin to apply. Changes stay queued meanwhile.
          </Text>
        </View>
      ) : null}
      {reviewOpen ? (
        <View style={figmaStyles.card} testID="figma-pending-review-list">
          {ops.map((entry) => (
            <PendingRow
              key={entry.id}
              entry={entry}
              busy={busy}
              choice={choices[entry.id]}
              onRemove={removeOp}
              onChoose={choose}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function PendingRow({
  entry,
  busy,
  choice,
  onRemove,
  onChoose,
}: {
  entry: FigmaPendingOp;
  busy: boolean;
  choice: ConflictChoice | undefined;
  onRemove: (entry: FigmaPendingOp) => void;
  onChoose: (entry: FigmaPendingOp, choice: ConflictChoice) => void;
}) {
  const remove = useCallback(() => {
    onRemove(entry);
  }, [entry, onRemove]);
  const keepMine = useCallback(() => onChoose(entry, "keep_mine"), [entry, onChoose]);
  const keepFigma = useCallback(() => onChoose(entry, "keep_figma"), [entry, onChoose]);
  return (
    <View style={figmaStyles.rowBetween} testID={`figma-pending-row-${entry.id}`}>
      <View style={figmaStyles.flex1}>
        <Text style={figmaStyles.rowTitle} numberOfLines={2}>
          {describePendingOp(entry)}
        </Text>
        {entry.state === "conflict" ? (
          <Text style={figmaStyles.rowSubtle}>
            Figma changed this node since the change was queued.
          </Text>
        ) : null}
      </View>
      {entry.state === "conflict" ? (
        <View style={figmaStyles.row}>
          <Button
            size="sm"
            variant={choice === "keep_mine" ? "default" : "outline"}
            onPress={keepMine}
            testID={`figma-pending-keep-mine-${entry.id}`}
          >
            Keep mine
          </Button>
          <Button
            size="sm"
            variant={choice === "keep_figma" ? "default" : "outline"}
            onPress={keepFigma}
            testID={`figma-pending-keep-figma-${entry.id}`}
          >
            Keep Figma
          </Button>
        </View>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onPress={remove}
          testID={`figma-pending-remove-${entry.id}`}
        >
          Remove
        </Button>
      )}
    </View>
  );
}
