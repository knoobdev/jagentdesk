/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SkillCatalogItem } from "@jagentdesk/protocol/native-skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSkillEntry } from "@/test/skill-entry";
import { useSkillsStore } from "@/stores/skills-store";
import { CatalogItemSheet } from "./catalog-item-sheet";
import { InstalledTab } from "./installed-tab";
import type { SkillRowHandlers } from "./skill-row";

void testI18n;

const toast = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn(), copied: vi.fn() }));

vi.mock("@/contexts/toast-context", () => ({ useToast: () => toast }));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const actual = await vi.importActual<typeof import("@/components/adaptive-modal-sheet")>(
    "@/components/adaptive-modal-sheet",
  );
  return {
    ...actual,
    AdaptiveModalSheet: ({
      header,
      children,
    }: {
      header: { title: string };
      children: React.ReactNode;
    }) =>
      ReactModule.createElement(
        "div",
        { role: "dialog" },
        ReactModule.createElement("h2", null, header.title),
        children,
      ),
  };
});

// The project picker pulls the full combobox stack (native-only modules); these
// tests cover the Global scope path, so a label stub is enough.
vi.mock("@/components/ui/select-field", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  return {
    SelectField: ({ label }: { label: string }) => ReactModule.createElement("div", null, label),
  };
});

vi.mock("@/components/markdown/renderer", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  return {
    MarkdownRenderer: ({ text }: { text: string }) =>
      ReactModule.createElement("div", { "data-testid": "markdown" }, text),
  };
});

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Keyframe: class {
    duration() {
      return this;
    }
  },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[1] : output[0],
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
  withTiming: (value: unknown) => value,
}));

vi.mock("@gorhom/bottom-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const { ScrollView, TextInput } =
    await vi.importActual<typeof import("react-native")>("react-native");
  return {
    BottomSheetBackdrop: () => null,
    BottomSheetModal: ReactModule.forwardRef(() => null),
    BottomSheetScrollView: ScrollView,
    BottomSheetTextInput: TextInput,
    useBottomSheetInternal: () => null,
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const TRUST_TEXT =
  "Skills are instructions and code that run with the agent's permissions. Install only skills you trust.";

function catalogItem(partial: Partial<SkillCatalogItem> = {}): SkillCatalogItem {
  return {
    itemId: "skills/pdf",
    kind: "skill",
    name: "pdf",
    description: "Read and fill PDF forms",
    source: { kind: "official", repo: "anthropics/skills" },
    origin: "anthropics/skills",
    revision: "0123456789abcdef",
    files: ["SKILL.md", "scripts/fill.py"],
    hasScripts: true,
    body: "# PDF\nUse the fill script.",
    provider: null,
    category: null,
    installCommand: null,
    installed: false,
    installedSkillId: null,
    invalidReason: null,
    ...partial,
  };
}

function noop(): void {}

const NO_BUSY_IDS: ReadonlySet<string> = new Set();

function asClient(installSkill: ReturnType<typeof vi.fn>): DaemonClient {
  return { installSkill } as unknown as DaemonClient;
}

const HANDLERS: SkillRowHandlers = {
  onOpen: vi.fn(),
  onToggleEnabled: vi.fn(),
  onCopyPath: vi.fn(),
  onTrain: vi.fn(),
  onFork: vi.fn(),
  onUninstall: vi.fn(),
};

function renderWithQuery(element: ReactElement): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  toast.show.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSkillsStore.setState({ serverId: null, catalogs: {} });
});

describe("CatalogItemSheet", () => {
  it("shows the spec trust warning and highlights scripts before install", () => {
    renderWithQuery(
      <CatalogItemSheet
        serverId="srv_1"
        client={null}
        item={catalogItem()}
        projects={[]}
        defaultProjectPath={null}
        onClose={noop}
      />,
    );
    expect(screen.getByText(TRUST_TEXT)).toBeDefined();
    expect(screen.getAllByTestId("skill-file-script")).toHaveLength(1);
    expect(screen.getByText("scripts/fill.py")).toBeDefined();
  });

  it("offers rename on a name conflict and installs under the new name", async () => {
    const installSkill = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('A skill named "pdf" already exists. code=skill_name_conflict'), {
          code: "skill_name_conflict",
        }),
      )
      .mockResolvedValueOnce({
        requestId: "r",
        skill: makeSkillEntry({ name: "pdf-jagentdesk", owned: true }),
        plugin: null,
      });
    const onClose = vi.fn();
    const onInstalled = vi.fn();
    renderWithQuery(
      <CatalogItemSheet
        serverId="srv_1"
        client={asClient(installSkill)}
        item={catalogItem()}
        projects={[]}
        defaultProjectPath={null}
        onClose={onClose}
        onInstalled={onInstalled}
      />,
    );
    fireEvent.click(screen.getByTestId("skills-install-submit"));
    expect(await screen.findByTestId("skills-install-conflict")).toBeDefined();
    expect(installSkill).toHaveBeenCalledWith({
      item: { source: { kind: "official", repo: "anthropics/skills" }, itemId: "skills/pdf" },
      scope: "global",
    });

    fireEvent.click(screen.getByTestId("skills-install-as"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(installSkill).toHaveBeenLastCalledWith({
      item: { source: { kind: "official", repo: "anthropics/skills" }, itemId: "skills/pdf" },
      scope: "global",
      rename: "pdf-jagentdesk",
    });
    expect(onInstalled).toHaveBeenCalledWith(expect.objectContaining({ name: "pdf-jagentdesk" }));
  });

  it("shows the provider CLI output after a plugin install", async () => {
    const installSkill = vi.fn().mockResolvedValue({
      requestId: "r",
      skill: null,
      plugin: {
        provider: "claude",
        command: ["claude", "plugin", "install", "review@market"],
        cwd: null,
        ok: true,
        exitCode: 0,
        stdout: "Installed review",
        stderr: "",
      },
    });
    renderWithQuery(
      <CatalogItemSheet
        serverId="srv_1"
        client={asClient(installSkill)}
        item={catalogItem({
          itemId: "review@market",
          kind: "plugin",
          name: "review",
          files: [],
          hasScripts: false,
          body: null,
          source: { kind: "provider-marketplace", provider: "claude" },
          installCommand: ["claude", "plugin", "install", "review@market"],
        })}
        projects={[]}
        defaultProjectPath={null}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByTestId("skills-install-submit"));
    expect(await screen.findByTestId("skills-plugin-output")).toBeDefined();
    expect(screen.getByText("Installed review")).toBeDefined();
  });
});

describe("InstalledTab", () => {
  it("lists every skill with an invalid reason and filters by provider visibility", async () => {
    useSkillsStore.setState({
      serverId: "srv_1",
      catalogs: {
        "": {
          skills: [
            makeSkillEntry({ name: "frontend-design", visibleTo: ["claude", "codex"] }),
            makeSkillEntry({ name: "kiro-steering", visibleTo: ["kiro"] }),
            makeSkillEntry({
              name: "broken",
              status: "invalid",
              invalidReason: "SKILL.md has no description",
            }),
          ],
          written: { lockPath: "/jad/skills/lock.json", paths: ["/home/u/.agents/skills/x"] },
          status: "ready",
          error: null,
        },
      },
    });
    renderWithQuery(
      <InstalledTab
        cwd={null}
        busyIds={NO_BUSY_IDS}
        handlers={HANDLERS}
        onCopyWrittenPath={noop}
      />,
    );
    expect(screen.getByText("frontend-design")).toBeDefined();
    expect(screen.getByText("SKILL.md has no description")).toBeDefined();
    expect(screen.getByText("/jad/skills/lock.json")).toBeDefined();

    fireEvent.click(screen.getByTestId("skills-filter-provider-kiro"));
    await waitFor(() => expect(screen.queryByText("frontend-design")).toBeNull());
    expect(screen.getByText("kiro-steering")).toBeDefined();
  });
});
