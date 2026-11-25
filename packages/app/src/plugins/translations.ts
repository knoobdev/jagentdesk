import type {
  PluginText,
  PluginMessage,
  PluginScreenParams,
  PluginButton,
  PluginButtonRegistration,
} from "@jagentdesk/plugin/client";
import {
  isPluginMessage,
  requirePluginText,
  type PluginTranslationRuntime,
} from "@jagentdesk/plugin/client/host";

const labels = [
  "title",
  "label",
  "description",
  "argumentHint",
  "pickerTitle",
  "searchPlaceholder",
  "name",
];
type Label = PluginText | ((params: PluginScreenParams) => PluginText);
const originalLabels = new WeakMap<object, Record<string, Label>>();
type LocalizedValue<Value> = Value extends PluginMessage
  ? string
  : Value extends (params: PluginScreenParams) => PluginText
    ? (params: PluginScreenParams) => string
    : Value;
type Localized<T> = { [Key in keyof T]: LocalizedValue<T[Key]> };

/** Keep labels live while the installation's components, drafts and subscriptions stay mounted. */
export function localizePluginContribution<T extends object>(
  input: T,
  translations: PluginTranslationRuntime,
  origin: object = input,
): Localized<T> {
  const inherited = originalLabels.get(origin);
  const source: Record<string, Label> = { ...inherited };
  for (const key of labels) {
    const value: unknown = Reflect.get(input, key);
    if (
      !(key in source) &&
      (typeof value === "string" ||
        isPluginMessage(value) ||
        (key === "title" && typeof value === "function"))
    )
      source[key] = value as Label;
  }
  const result = { ...input };
  originalLabels.set(result, source);
  for (const [key, value] of Object.entries(source)) {
    // These two identifiers are never translated; theme names are display labels.
    if (key === "name" && "onSubmit" in input) continue;
    if (typeof value === "function") {
      const title = (params: PluginScreenParams) =>
        translations.resolve(requirePluginText(value(params)));
      Object.defineProperty(result, key, { get: () => title, enumerable: true });
    } else {
      Object.defineProperty(result, key, {
        get: () => translations.resolve(value),
        enumerable: true,
      });
    }
  }
  return result as Localized<T>;
}

function localizedButton(
  button: PluginButton<PluginText>,
  translations: PluginTranslationRuntime,
): PluginButton {
  const behavior = button.behavior;
  return {
    ...button,
    title: translations.resolve(requirePluginText(button.title)),
    label:
      button.label === undefined
        ? undefined
        : translations.resolve(requirePluginText(button.label)),
    behavior:
      behavior.kind === "menu"
        ? {
            kind: "menu",
            items: behavior.items.map((item) =>
              item.kind === "separator"
                ? item
                : {
                    ...item,
                    title: translations.resolve(requirePluginText(item.title)),
                    behavior: localizedButton(
                      { ...item, icon: item.icon ?? "Circle" },
                      translations,
                    ).behavior,
                  },
            ),
          }
        : behavior,
  };
}

export function registerTranslatedButton(
  button: PluginButton<PluginText>,
  translations: PluginTranslationRuntime,
  add: (button: PluginButton) => PluginButtonRegistration,
): PluginButtonRegistration<PluginText> {
  let current = button;
  const registration = add(localizedButton(current, translations));
  let active = true;
  const unsubscribe = translations.subscribe(() =>
    registration.update(localizedButton(current, translations)),
  );
  return {
    update(patch) {
      if (!active) return;
      current = { ...current, ...patch };
      registration.update(localizedButton(current, translations));
    },
    remove() {
      if (!active) return;
      active = false;
      unsubscribe();
      registration.remove();
    },
  };
}
