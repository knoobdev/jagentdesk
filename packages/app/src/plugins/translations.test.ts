import { expect, it } from "vitest";
import { defineTranslations } from "@jagentdesk/plugin/client";
import { PluginTranslationRuntime } from "@jagentdesk/plugin/client/host";
import { localizePluginContribution } from "./translations";

it("updates translated labels through host normalization without replacing the component", () => {
  let locale = "en";
  const listeners = new Set<() => void>();
  const runtime = new PluginTranslationRuntime({
    getLocale: () => locale,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const messages = defineTranslations({
    resources: { en: { title: "Notes" }, vi: { title: "Ghi chú" } },
  });
  const Component = () => null;
  const contribution = localizePluginContribution(
    { id: "notes", title: messages.message("title"), Component },
    runtime,
  );
  const registered = localizePluginContribution(
    { ...contribution, title: contribution.title.trim() },
    runtime,
    contribution,
  );
  expect(registered.title).toBe("Notes");
  locale = "vi";
  for (const listener of listeners) listener();
  expect(registered.title).toBe("Ghi chú");
  expect(registered.Component).toBe(Component);
  runtime.dispose();
  expect(listeners.size).toBe(0);
});
