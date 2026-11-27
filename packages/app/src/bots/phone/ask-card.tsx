// The item's waiting ask on a phone, docked where the comment box is (spec 37.6): one open question at
// a time ("n of total"), its quick replies as buttons with the hint under each, "Recommended" on the
// one the bot recommends, pick several where it asked so, "Other…" for your own words, and "Not now"
// to fold it to its line above the comment box. A single pick on the last question sends; every answer
// posts as one comment, so the bot wakes once.
// Ported from Orca dfdb4fda (MIT) mobile/src/bots/items/MobileBotItemAskCard.tsx:1-142 and the chat
// question card it uses (mobile/src/session/native-chat/input/prompts/MobileNativeChatAsk.tsx).
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, ChevronUp } from "lucide-react-native";
import type { BotItemDecision } from "@jagentdesk/protocol/bots/types";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { Theme } from "@/styles/theme";
import { botItemAnswersText, botItemQuestionLine } from "@/bots/items/item-rules";

const ThemedCheck = withUnistyles(Check);
const ThemedUp = withUnistyles(ChevronUp);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function PhoneItemAskCard({
  decisions,
  disabled,
  onSend,
}: {
  decisions: readonly BotItemDecision[];
  disabled: boolean;
  /** The one comment the answers post as; `answers` per line, for a reply that acts. */
  onSend: (text: string, answers: readonly (string | null)[]) => void;
}) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<(string | null)[]>(() => decisions.map(() => null));
  const [current, setCurrent] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [other, setOther] = useState<string | null>(null);
  const [folded, setFolded] = useState(false);
  const decision = decisions[current];

  const answer = useCallback(
    (words: string) => {
      const next = answers.map((value, at) => (at === current ? words : value));
      setAnswers(next);
      setPicked(new Set());
      setOther(null);
      const open = next.findIndex((value) => value === null);
      if (open === -1) {
        const text = botItemAnswersText(decisions, next);
        if (text) onSend(text, next);
        return;
      }
      setCurrent(open);
    },
    [answers, current, decisions, onSend],
  );
  const choose = useCallback(
    (index: number) => {
      if (!decision) return;
      if (decision.multi) {
        setPicked((was) => {
          const next = new Set(was);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
        return;
      }
      const option = decision.options[index];
      if (option) answer(option.label);
    },
    [decision, answer],
  );
  const submitPicked = useCallback(() => {
    if (!decision) return;
    const labels = decision.options
      .filter((_, index) => picked.has(index))
      .map((option) => option.label);
    const words = [...labels, other?.trim() ?? ""].filter(Boolean).join(", ");
    if (words) answer(words);
  }, [decision, picked, other, answer]);
  const startOther = useCallback(() => setOther(""), []);
  const fold = useCallback(() => setFolded(true), []);
  const expand = useCallback(() => setFolded(false), []);
  const position = useMemo(
    () =>
      decisions.length > 1
        ? t("bots.phone.chat.ask.previewPosition", {
            current: current + 1,
            total: decisions.length,
          })
        : null,
    [decisions.length, current, t],
  );

  if (!decision) return null;
  if (folded)
    return (
      <Pressable
        onPress={expand}
        style={styles.strip}
        accessibilityRole="button"
        testID="phone-item-ask-strip"
      >
        <Text style={styles.stripText} numberOfLines={1}>
          {botItemQuestionLine(decision.prompt)}
        </Text>
        <ThemedUp size={16} uniProps={muted} />
      </Pressable>
    );
  const canSubmit = picked.size > 0 || Boolean(other?.trim());
  return (
    <View style={styles.card} testID="phone-item-ask-card">
      <View style={styles.head}>
        <Text style={styles.question}>{decision.prompt}</Text>
        {position ? <Text style={styles.position}>{position}</Text> : null}
      </View>
      <View style={styles.options}>
        {decision.options.map((option, index) => (
          <AskOption
            key={option.label}
            index={index}
            label={option.label}
            detail={option.detail}
            recommended={decision.recommended === index}
            checked={decision.multi ? picked.has(index) : null}
            disabled={disabled}
            onChoose={choose}
          />
        ))}
        {other === null ? (
          <Pressable
            onPress={startOther}
            disabled={disabled}
            style={styles.option}
            accessibilityRole="button"
            testID="phone-item-ask-other"
          >
            <Text style={styles.otherLabel}>{t("bots.phone.chat.ask.other")}</Text>
          </Pressable>
        ) : (
          <FormTextInput
            value={other}
            initialValue=""
            webControlled
            autoFocus
            onChangeText={setOther}
            onSubmitEditing={submitPicked}
            placeholder={t("bots.phone.chat.ask.answerPlaceholder")}
            accessibilityLabel={t("bots.phone.chat.ask.answerPlaceholder")}
            size="sm"
            testID="phone-item-ask-other-input"
          />
        )}
      </View>
      <View style={styles.footer}>
        <Button
          size="sm"
          variant="ghost"
          onPress={fold}
          disabled={disabled}
          testID="phone-item-ask-not-now"
        >
          {t("bots.phone.bots.items.ask.notNow")}
        </Button>
        {decision.multi || other !== null ? (
          <Button
            size="sm"
            variant="default"
            onPress={submitPicked}
            disabled={disabled || !canSubmit}
            testID="phone-item-ask-submit"
          >
            {current === decisions.length - 1 ||
            answers.every((value, at) => at === current || value !== null)
              ? t("bots.phone.chat.ask.submit")
              : t("bots.phone.chat.ask.next")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function AskOption({
  index,
  label,
  detail,
  recommended,
  checked,
  disabled,
  onChoose,
}: {
  index: number;
  label: string;
  detail: string | undefined;
  recommended: boolean;
  /** A pick-several question: whether this one is picked; null for a single pick. */
  checked: boolean | null;
  disabled: boolean;
  onChoose: (index: number) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onChoose(index), [onChoose, index]);
  const style = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.option,
      checked && styles.optionChecked,
      pressed && styles.optionPressed,
    ],
    [checked],
  );
  const state = useMemo(
    () => (checked === null ? { disabled } : { checked, disabled }),
    [checked, disabled],
  );
  return (
    <Pressable
      onPress={press}
      disabled={disabled}
      style={style}
      accessibilityRole={checked === null ? "button" : "checkbox"}
      accessibilityState={state}
      testID={`phone-item-ask-option-${index}`}
    >
      <View style={styles.optionHead}>
        <Text style={styles.optionLabel}>{label}</Text>
        {recommended ? (
          <Text style={styles.recommended} testID="phone-item-ask-recommended">
            {t("bots.phone.bots.items.ask.recommended")}
          </Text>
        ) : null}
        {checked ? <ThemedCheck size={16} uniProps={foreground} /> : null}
      </View>
      {detail ? <Text style={styles.optionDetail}>{detail}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  card: {
    gap: 10,
    padding: 12,
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  question: { flex: 1, fontSize: 15, lineHeight: 21, color: theme.colors.foreground },
  position: { fontSize: 12, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  options: { gap: 6 },
  option: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  optionChecked: { borderColor: theme.colors.foreground },
  optionPressed: { backgroundColor: theme.colors.surface2 },
  optionHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  optionLabel: { flex: 1, fontSize: 15, color: theme.colors.foreground },
  optionDetail: { marginTop: 2, fontSize: 13, color: theme.colors.foregroundMuted },
  otherLabel: { fontSize: 15, color: theme.colors.foregroundMuted },
  recommended: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  strip: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  stripText: { flex: 1, fontSize: 13, color: theme.colors.foregroundMuted },
}));
