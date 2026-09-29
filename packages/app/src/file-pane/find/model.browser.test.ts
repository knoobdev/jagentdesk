import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { FileFindModel } from "./model.web";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

function mount(input: { doc: string; readOnly?: boolean }) {
  const find = new FileFindModel();
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: input.doc,
      extensions: [find.extension, EditorState.readOnly.of(input.readOnly === true)],
    }),
  });
  views.push(view);
  return { find, view };
}

describe("file Find model", () => {
  it("opens, counts literal matches, and tracks the active one", () => {
    const { find, view } = mount({ doc: "alpha beta\nalpha gamma\nalpha" });

    find.open(view);
    expect(find.getSnapshot().open).toBe(true);

    find.setSearch("alpha");
    expect(find.getSnapshot()).toMatchObject({ query: "alpha", total: 3, current: 1 });

    find.next();
    expect(find.getSnapshot().current).toBe(2);
    find.previous();
    expect(find.getSnapshot().current).toBe(1);
  });

  it("treats the query literally", () => {
    const { find, view } = mount({ doc: "a.b axb a.b" });
    find.open(view);
    find.setSearch("a.b");
    expect(find.getSnapshot().total).toBe(2);
  });

  it("replaces every match in an editable document", () => {
    const { find, view } = mount({ doc: "one two one" });
    find.open(view);
    find.setSearch("one");
    find.setReplacement("three");
    expect(find.getSnapshot()).toMatchObject({ readOnly: false, replacement: "three" });

    find.replaceAll();

    expect(view.state.doc.toString()).toBe("three two three");
    expect(find.getSnapshot().total).toBe(0);
  });

  it("reports a read-only document so the widget hides replace", () => {
    const { find, view } = mount({ doc: "one two one", readOnly: true });
    find.open(view);
    find.setSearch("one");
    expect(find.getSnapshot()).toMatchObject({ readOnly: true, total: 2 });
  });

  it("closes and reports Find as closed", () => {
    const { find, view } = mount({ doc: "one" });
    find.open(view);
    find.close();
    expect(find.getSnapshot().open).toBe(false);
  });
});
