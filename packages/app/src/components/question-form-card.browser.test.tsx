import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor, within } from "@testing-library/dom";
import type { AgentPermissionResponse } from "@jagentdesk/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type { PendingPermission } from "@/types/shared";
import { QuestionFormCard } from "./question-form-card";

// Load translations so controls expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

/**
 * A real browser with the real web text input, so the Other field's on-screen text and the
 * card's React state are checked together: a card that drops the Other text from state must
 * also stop showing it, and submit must send what the field shows.
 */

interface Mounted {
  root: Root;
  client: QueryClient;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
    entry.client.clear();
  }
});

function buildPermission(
  question: Record<string, unknown>,
  following: Record<string, unknown>[] = [],
): PendingPermission {
  return {
    key: "perm-1",
    agentId: "agent-1",
    request: {
      id: "perm-1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: [question, ...following] },
    },
  };
}

function mountCard(question: Record<string, unknown>, following: Record<string, unknown>[] = []) {
  const onRespond = vi.fn<(response: AgentPermissionResponse) => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient();
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <QuestionFormCard
          permission={buildPermission(question, following)}
          onRespond={onRespond}
          isResponding={false}
          responseError={null}
        />
      </QueryClientProvider>,
    ),
  );
  mounted.push({ root, container, client });

  const view = within(container);
  const otherInput = () =>
    view.getByRole<HTMLInputElement>("textbox", { name: String(question.question) });
  const check = (label: string) =>
    act(() =>
      (
        view.queryByRole("radio", { name: label }) ?? view.getByRole("checkbox", { name: label })
      ).click(),
    );
  const type = (text: string) => {
    const input = otherInput();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("HTML input value setter is unavailable");
    act(() => {
      valueSetter.call(input, text);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    });
  };
  const submit = () => act(() => view.getByRole("button", { name: "Submit" }).click());
  const submittedAnswers = (): Record<string, string> => {
    const response = onRespond.mock.calls[0]?.[0];
    if (!response || response.behavior !== "allow") throw new Error("card did not submit");
    return (response.updatedInput as { answers: Record<string, string> }).answers;
  };
  return { check, type, otherInput, submit, submittedAnswers, view, onRespond };
}

const multiSelectQuestion = {
  question: "Which fruits do you like?",
  header: "Fruits",
  options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
  multiSelect: true,
  allowOther: true,
};

const singleSelectQuestion = {
  question: "Which provider?",
  header: "Provider",
  options: [{ label: "Claude Code" }, { label: "Codex" }],
  multiSelect: false,
  allowOther: true,
};

describe("QuestionFormCard other answers", () => {
  it("keeps checked options when the other answer is typed afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.check("Apple");
    card.check("Cherry");
    card.type("durian");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Cherry, durian" });
  });

  it("keeps the typed other answer when options are checked afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.type("durian");
    card.check("Apple");
    card.check("Banana");

    expect(card.otherInput().value).toBe("durian");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Banana, durian" });
  });

  it("replaces the selected option with the typed other answer (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.check("Codex");
    card.type("OpenCode");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Provider: "OpenCode" });
  });

  it("clears the typed other answer on screen when an option is picked afterwards (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.type("OpenCode");
    card.check("Codex");

    expect(card.otherInput().value).toBe("");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Provider: "Codex" });
  });
});

describe("QuestionFormCard explicit navigation", () => {
  it("keeps a picked option visible until Next and submits only on Submit", () => {
    const card = mountCard(singleSelectQuestion, [multiSelectQuestion]);
    card.check("Codex");
    expect(card.view.getByRole("radio", { name: "Codex" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(card.onRespond).not.toHaveBeenCalled();
    act(() => card.view.getByRole("button", { name: "Next" }).click());
    card.check("Apple");
    expect(card.onRespond).not.toHaveBeenCalled();
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Provider: "Codex", Fruits: "Apple" });
  });

  it("keeps the description selectable without picking or submitting an option", async () => {
    const card = mountCard({
      ...singleSelectQuestion,
      options: [{ label: "Codex", description: "Use this provider" }],
    });
    const description = await waitFor(() => card.view.getByText("Use this provider"), {
      timeout: 10000,
    });
    act(() => description.click());
    expect(card.view.getByRole("radio", { name: "Codex" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(card.onRespond).not.toHaveBeenCalled();
  });
});
