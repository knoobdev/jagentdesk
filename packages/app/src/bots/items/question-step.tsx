// The waiting ask, one question at a time: the lines answered so far fold above as
// "Question → answer" (a held one reopens on press), then the open line with ‹ n of total › and its
// quick replies, the recommended one marked "Recommended". A pick answers the line and the step moves
// on; the picks post as one comment once the last line is answered, or sooner with "send anyway".
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/items/BotItemQuestionStep.tsx:1-257
// and use-bot-item-question-steps.ts (held answers, one comment for the set).
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Trans, useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, ChevronLeft, ChevronRight } from "lucide-react-native";
import type { BotItemDecision } from "@jagentdesk/protocol/bots/types";
import { FormTextInput } from "@/components/ui/form-field";
import type { Theme } from "@/styles/theme";
import { mutedColor } from "./item-parts";
import { botItemAnswersText, botItemQuestionLine } from "./item-rules";

const ThemedLeft = withUnistyles(ChevronLeft);
const ThemedRight = withUnistyles(ChevronRight);
const ThemedCheck = withUnistyles(Check);
const pickedColor = (theme: Theme) => ({ color: theme.colors.foreground });

/** The reply that skips the review loop (spec 37.3.7 step 3): it marks the item done, forced. */
export const MARK_DONE_ANYWAY = "Mark done anyway";

export function BotItemQuestionStep({
  decisions,
  disabled = false,
  onSend,
}: {
  decisions: readonly BotItemDecision[];
  disabled?: boolean;
  /** The comment the answers post as; `answers` per line, for a reply that acts ("Mark done anyway"). */
  onSend: (text: string, answers: readonly (string | null)[]) => void;
}) {
  const { t } = useTranslation();
  const [held, setHeld] = useState<(string | null)[]>(() => decisions.map(() => null));
  const [current, setCurrent] = useState(0);
  const [typed, setTyped] = useState("");
  const decision = decisions[current];
  const heldCount = held.filter((answer) => answer !== null).length;

  const send = useCallback(
    (answers: readonly (string | null)[]) => {
      const text = botItemAnswersText(decisions, answers);
      if (text) onSend(text, answers);
    },
    [decisions, onSend],
  );
  const answer = useCallback(
    (index: number, words: string) => {
      const next = held.map((value, at) => (at === index ? words : value));
      setTyped("");
      const open = next.findIndex((value, at) => value === null && at !== index);
      if (open === -1) {
        setHeld(next);
        send(next);
        return;
      }
      setHeld(next);
      setCurrent(open);
    },
    [held, send],
  );
  const sendHeld = useCallback(() => send(held), [held, send]);
  const previous = useCallback(() => setCurrent((at) => Math.max(0, at - 1)), []);
  const next = useCallback(
    () => setCurrent((at) => Math.min(decisions.length - 1, at + 1)),
    [decisions.length],
  );
  const sendComponents = useMemo(
    () => ({ send: <Text style={styles.sendAnyway} onPress={sendHeld} /> }),
    [sendHeld],
  );
  const heldValues = useMemo(() => ({ count: heldCount }), [heldCount]);
  const submitTyped = useCallback(() => {
    if (typed.trim()) answer(current, typed.trim());
  }, [typed, current, answer]);

  const folded = useMemo(
    () =>
      decisions.flatMap((line, index) =>
        index !== current && held[index] ? [{ line, index, words: held[index] ?? "" }] : [],
      ),
    [decisions, current, held],
  );
  if (!decision) return null;
  return (
    <View style={styles.step} testID="bot-item-question">
      {folded.length > 0 ? (
        <View style={styles.folded}>
          {folded.map(({ line, index, words }) => (
            <FoldedAnswer
              key={index}
              index={index}
              prompt={line.prompt}
              words={words}
              onOpen={setCurrent}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.questionRow}>
        <Text style={styles.question}>{decision.prompt}</Text>
        {decisions.length > 1 ? (
          <View style={styles.nav}>
            <Pressable
              disabled={current <= 0}
              onPress={previous}
              accessibilityRole="button"
              accessibilityLabel={t("bots.items.ask.previous")}
              style={[styles.navButton, current <= 0 && styles.navDisabled]}
              testID="bot-item-question-previous"
            >
              <ThemedLeft size={14} uniProps={mutedColor} />
            </Pressable>
            <Text style={styles.navText} testID="bot-item-question-step">
              {t("bots.items.ask.step", { n: current + 1, total: decisions.length })}
            </Text>
            <Pressable
              disabled={current >= decisions.length - 1}
              onPress={next}
              accessibilityRole="button"
              accessibilityLabel={t("bots.items.ask.next")}
              style={[styles.navButton, current >= decisions.length - 1 && styles.navDisabled]}
              testID="bot-item-question-next"
            >
              <ThemedRight size={14} uniProps={mutedColor} />
            </Pressable>
          </View>
        ) : null}
      </View>
      <View style={styles.options}>
        {decision.options.map((option, index) => (
          <OptionChip
            key={option.label}
            label={option.label}
            index={index}
            line={current}
            picked={held[current] === option.label}
            recommended={decision.recommended === index}
            // Filled until the owner picks one on this line; then the pick stands out instead.
            filled={decision.recommended === index && held[current] === null}
            disabled={disabled}
            onAnswer={answer}
          />
        ))}
      </View>
      {decision.options.some((option) => option.detail) ? (
        <View style={styles.details}>
          {decision.options.map((option) =>
            option.detail ? (
              <Text key={option.label} style={styles.detail}>
                {option.label}: {option.detail}
              </Text>
            ) : null,
          )}
        </View>
      ) : null}
      <FormTextInput
        value={typed}
        initialValue=""
        resetKey={current}
        webControlled
        onChangeText={setTyped}
        onSubmitEditing={submitTyped}
        placeholder={t("bots.items.ask.typeAnswer")}
        accessibilityLabel={t("bots.items.ask.typeAnswer")}
        editable={!disabled}
        size="sm"
        testID="bot-item-question-type"
      />
      {heldCount > 0 && heldCount < decisions.length ? (
        <Text style={styles.held}>
          <Trans
            i18nKey="bots.items.ask.heldCount"
            count={heldCount}
            values={heldValues}
            components={sendComponents}
          />
        </Text>
      ) : null}
    </View>
  );
}

function FoldedAnswer({
  index,
  prompt,
  words,
  onOpen,
}: {
  index: number;
  prompt: string;
  words: string;
  onOpen: (index: number) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(index), [onOpen, index]);
  return (
    <Pressable onPress={open} accessibilityRole="button">
      <Text style={styles.answerLine}>
        {botItemQuestionLine(prompt)} → <Text style={styles.answerWords}>{words}</Text>
        {` · ${t("bots.items.ask.notSentYet")}`}
      </Text>
    </Pressable>
  );
}

function OptionChip({
  label,
  index,
  line,
  picked,
  recommended,
  filled,
  disabled,
  onAnswer,
}: {
  label: string;
  index: number;
  line: number;
  picked: boolean;
  recommended: boolean;
  filled: boolean;
  disabled: boolean;
  onAnswer: (line: number, words: string) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onAnswer(line, label), [onAnswer, line, label]);
  const state = useMemo(() => ({ selected: picked }), [picked]);
  const recommendedLabel = t("bots.items.ask.recommended");
  return (
    <Pressable
      disabled={disabled}
      onPress={press}
      accessibilityRole="button"
      accessibilityState={state}
      accessibilityLabel={recommended ? `${label}, ${recommendedLabel}` : label}
      style={[styles.chip, filled && styles.chipRecommended, picked && styles.chipPicked]}
      testID={`bot-item-option-${index}`}
    >
      {picked ? <ThemedCheck size={12} uniProps={pickedColor} /> : null}
      <Text style={[styles.chipText, filled && styles.chipTextRecommended]}>
        {recommended ? "★ " : ""}
        {label}
      </Text>
      {recommended ? (
        <Text
          style={[styles.recommended, filled && styles.chipTextRecommended]}
          testID="bot-item-option-recommended"
        >
          {recommendedLabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  step: {
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  folded: { gap: 4 },
  answerLine: { fontSize: 13, lineHeight: 19, color: theme.colors.foregroundMuted },
  answerWords: { color: theme.colors.foreground },
  questionRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  question: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  nav: { flexDirection: "row", alignItems: "center" },
  navButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  navDisabled: { opacity: 0.35 },
  navText: { fontSize: 11, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    minHeight: 32,
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipRecommended: {
    backgroundColor: theme.colors.foreground,
    borderColor: theme.colors.foreground,
  },
  chipPicked: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.foregroundMuted },
  chipText: { fontSize: 13, lineHeight: 18, color: theme.colors.foreground },
  chipTextRecommended: { color: theme.colors.surface0 },
  recommended: { fontSize: 11, color: theme.colors.foregroundMuted },
  details: { gap: 2 },
  detail: { fontSize: 12, lineHeight: 16, color: theme.colors.foregroundMuted },
  held: { fontSize: 13, lineHeight: 19, color: theme.colors.foregroundMuted },
  sendAnyway: { color: theme.colors.foreground, textDecorationLine: "underline" },
}));
