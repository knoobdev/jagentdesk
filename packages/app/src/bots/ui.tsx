import { useCallback } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { styles } from "./styles";
export function Input({
  label,
  value,
  onChange,
  multiline = false,
  testID,
  editable = true,
  resetKey,
  hint,
  error,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  testID?: string;
  editable?: boolean;
  resetKey?: string | number;
  /** 13 px help under the field; wraps, unlike the shared Field hint. */
  hint?: string;
  /** Shown under the field in place of the hint. */
  error?: string | null;
  placeholder?: string;
}) {
  const compact = useIsCompactFormFactor();
  return (
    <Field label={label} error={error} testID={testID ? `${testID}-field` : undefined}>
      <FormTextInput
        accessibilityLabel={label}
        value={value}
        initialValue={value}
        resetKey={resetKey}
        webControlled
        onChangeText={onChange}
        multiline={multiline}
        editable={editable}
        size={compact ? "md" : "sm"}
        autoCapitalize="none"
        placeholder={placeholder}
        testID={testID}
      />
      {hint && !error ? (
        <Text style={styles.hint} testID={testID ? `${testID}-field-hint` : undefined}>
          {hint}
        </Text>
      ) : null}
    </Field>
  );
}
export function ErrorNotice({ error }: { error: Error | null }) {
  return error ? <Alert variant="error" title={error.message} testID="bots-error" /> : null;
}
export function QueryNotice({
  query,
}: {
  query: {
    isPending: boolean;
    isError: boolean;
    error: Error | null;
    refetch: () => unknown;
  };
}) {
  const { t } = useTranslation();
  const retry = useCallback(
    function retry() {
      query.refetch();
    },
    [query],
  );
  if (query.isError)
    return (
      <Alert variant="error" title={query.error?.message ?? ""}>
        <Button onPress={retry}>{t("bots.retry")}</Button>
      </Alert>
    );
  if (query.isPending) return <Text style={styles.muted}>{t("bots.loading")}</Text>;
  return null;
}
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {children}
    </View>
  );
}
