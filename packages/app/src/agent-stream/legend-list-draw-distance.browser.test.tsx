import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { afterEach, beforeEach, expect, it } from "vitest";

// The native chat timeline runs on the patched LegendList (patches/@legendapp+list+3.7.1.patch).
// It starts with a small draw distance and expands it after the initial reveal (change 13 of the
// patch). The native build applies its scroll adjustments through native scroll props that
// react-native-web ignores, so this test reads the state LegendList holds, not the DOM's.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const VIEWPORT_HEIGHT = 100;

interface Row {
  id: string;
  height: number;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = `display:flex;flex-direction:column;width:300px;height:${VIEWPORT_HEIGHT}px`;
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function wait(ms: number): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

const LIST_STYLE = { flex: 1 };
const ESTIMATED_LIST_SIZE = { width: 300, height: VIEWPORT_HEIGHT };
const rowStyles = new Map<number, { height: number }>();

function rowStyle(height: number) {
  let style = rowStyles.get(height);
  if (!style) {
    style = { height };
    rowStyles.set(height, style);
  }
  return style;
}

function renderRow({ item }: { item: Row }) {
  return <View style={rowStyle(item.height)} />;
}

function keyExtractor(item: Row) {
  return item.id;
}

function estimateRowSize(item: Row) {
  return item.height;
}

it("expands the draw distance of a placed end-anchored list without moving its bottom row", async () => {
  const rows: Row[] = Array.from({ length: 99 }, (_, index) => ({
    id: `row-${index}`,
    height: index % 2 === 0 ? 20 : 60,
  }));
  const lastRow = { id: "last-row", height: 180 };
  rows.push(lastRow);
  const listRef = React.createRef<LegendListRef>();

  function render(drawDistance: number) {
    act(() => {
      root.render(
        <LegendList
          ref={listRef}
          data={rows}
          renderItem={renderRow}
          keyExtractor={keyExtractor}
          estimatedListSize={ESTIMATED_LIST_SIZE}
          recycleItems={false}
          getEstimatedItemSize={estimateRowSize}
          drawDistance={drawDistance}
          alignItemsAtEnd
          initialScrollAtEnd
          style={LIST_STYLE}
        />,
      );
    });
  }

  render(50);
  await wait(300);
  const initial = listRef.current?.getState();
  const lastRowTop = initial?.positionByKey(lastRow.id);
  expect(initial?.sizes.get(lastRow.id)).toBe(lastRow.height);
  expect(initial?.sizes.size).toBeLessThan(8);
  expect(initial?.scroll).toBe(Number(lastRowTop) + lastRow.height - VIEWPORT_HEIGHT);

  render(1000);
  await wait(150);

  const expanded = listRef.current?.getState();
  expect(expanded?.sizes.size).toBeGreaterThan(20);
  expect(expanded?.scroll).toBe(initial?.scroll);
  expect(expanded?.positionByKey(lastRow.id)).toBe(lastRowTop);
});
