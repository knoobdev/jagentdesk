import { useCallback, type ComponentProps, type ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

// Stable-handler buttons for the Sideload tab: a mutation (optionally with variables) or a
// value handed to a setter, without creating a new function at every call site.

type ButtonProps = Omit<ComponentProps<typeof Button>, "onPress" | "loading" | "children">;

interface Runnable<TVariables> {
  mutate: (variables: TVariables) => void;
  isPending: boolean;
  variables?: TVariables;
}

export function MutationButton<TVariables>({
  mutation,
  variables,
  children,
  ...props
}: ButtonProps & {
  mutation: Runnable<TVariables>;
  variables: TVariables;
  children: ReactNode;
}) {
  const { mutate } = mutation;
  const press = useCallback(() => mutate(variables), [mutate, variables]);
  const loading = mutation.isPending && mutation.variables === variables;
  return (
    <Button {...props} onPress={press} loading={loading}>
      {children}
    </Button>
  );
}

export function ValueButton<T>({
  value,
  onValue,
  children,
  ...props
}: ButtonProps & {
  value: T;
  onValue: (value: T) => void;
  children: ReactNode;
  loading?: boolean;
}) {
  const press = useCallback(() => onValue(value), [onValue, value]);
  return (
    <Button {...props} onPress={press}>
      {children}
    </Button>
  );
}

export function KeyedSwitch<K>({
  name,
  value,
  onToggle,
  label,
}: {
  name: K;
  value: boolean;
  onToggle: (name: K, value: boolean) => void;
  label: string;
}) {
  const change = useCallback((next: boolean) => onToggle(name, next), [name, onToggle]);
  return <Switch value={value} onValueChange={change} accessibilityLabel={label} />;
}
