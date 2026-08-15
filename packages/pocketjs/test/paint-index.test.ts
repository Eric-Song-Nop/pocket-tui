// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";

import type { ComputedStyle, HostNode, LayoutResult, Rect } from "../src/model.js";
import { buildPaintIndex } from "../src/paint-index.js";
import { ENUM, NODE } from "../src/spec.js";

describe("retained paint index", () => {
  test("queries bounded row segments in global paint order and owns its snapshots", () => {
    const root = node(1, NODE.view);
    const spanning = node(2, NODE.view);
    const label = node(3, NODE.text, "wide \u754c");
    const footer = node(4, NODE.view);
    append(root, spanning);
    append(root, label);
    append(root, footer);

    const rootRect = rect(0, 0, 12, 7);
    const spanningRect = rect(0, 0, 12, 7);
    const labelRect = rect(1, 2, 7, 1);
    const footerRect = rect(0, 5, 12, 2);
    const rootStyle = style();
    const spanningStyle = style({ background: 0xff11_2233 });
    const labelStyle = style({ textColor: 0xffff_ffff });
    const footerStyle = style({ background: 0xff44_5566 });
    const styles = new Map([
      [root.id, rootStyle],
      [spanning.id, spanningStyle],
      [label.id, labelStyle],
      [footer.id, footerStyle],
    ]);
    const layout = makeLayout(
      [root, spanning, label, footer],
      new Map([
        [root.id, rootRect],
        [spanning.id, spanningRect],
        [label.id, labelRect],
        [footer.id, footerRect],
      ]),
      styles,
    );
    const index = buildPaintIndex(root, layout, 12, 7, (target) => styles.get(target.id)!);

    expect(index.paintOrder).toEqual([spanning.id, label.id, footer.id]);
    expect(ids(index.rasterSnapshot(new Set([2])))).toEqual([spanning.id, label.id]);
    expect(ids(index.rasterSnapshot(new Set([4])))).toEqual([spanning.id]);
    expect(ids(index.rasterSnapshot(new Set([6])))).toEqual([spanning.id, footer.id]);
    expect(ids(index.rasterSnapshot(new Set([6, 2])))).toEqual([
      spanning.id,
      label.id,
      footer.id,
    ]);
    expect(ids(index.rasterSnapshot(new Set([-1, 7, 1.5])))).toEqual([]);
    expect(index.rasterSnapshot(new Set()).paintOrder).toEqual(index.paintOrder);

    // The retained records must not point at the layout's rect/style objects.
    spanningRect.y = 6;
    spanningStyle.background = 0;
    spanningStyle.padding.left = 9;
    const snapshot = index.rasterSnapshot(new Set([0]));
    expect(ids(snapshot)).toEqual([spanning.id]);
    expect(snapshot.candidates[0]?.rect).toEqual({ x: 0, y: 0, width: 12, height: 7 });
    expect(snapshot.candidates[0]?.style.background).toBe(0xff11_2233);
    expect(snapshot.candidates[0]?.style.padding.left).toBe(0);
  });

  test("uses effective clip for raster candidates but raw rects for hit testing", () => {
    const root = node(1, NODE.view);
    const clipper = node(2, NODE.view);
    const spill = node(3, NODE.text, "SPILL");
    append(root, clipper);
    append(clipper, spill);

    const styles = new Map([
      [root.id, style()],
      [clipper.id, style({ background: 0xff20_2020, overflow: ENUM.overflowHidden })],
      [spill.id, style({ textColor: 0xffff_ffff })],
    ]);
    const layout = makeLayout(
      [root, clipper, spill],
      new Map([
        [root.id, rect(0, 0, 10, 5)],
        [clipper.id, rect(1, 1, 4, 2)],
        [spill.id, rect(0, 0, 8, 4)],
      ]),
      styles,
    );
    const index = buildPaintIndex(root, layout, 10, 5, (target) => styles.get(target.id)!);

    expect(ids(index.rasterSnapshot(new Set([0])))).toEqual([]);
    expect(ids(index.rasterSnapshot(new Set([1])))).toEqual([clipper.id, spill.id]);
    expect(ids(index.rasterSnapshot(new Set([3])))).toEqual([]);
    expect(index.hitTest(0, 0)).toBe(spill.id);
    expect(index.hitTest(7, 1)).toBe(spill.id);
    expect(index.hitTest(2, 3)).toBe(spill.id);
    expect(index.hitTest(Number.NaN, 1)).toBe(0);
  });

  test("patches inherited opacity and overflow without changing the confirmed candidate", () => {
    const root = node(1, NODE.view);
    const panel = node(2, NODE.view);
    const label = node(3, NODE.text, "child");
    append(root, panel);
    append(panel, label);

    const styles = new Map([
      [root.id, style()],
      [panel.id, style({ opacity: 0.5, overflow: ENUM.overflowHidden })],
      [label.id, style({ opacity: 0.4 })],
    ]);
    const layout = makeLayout(
      [root, panel, label],
      new Map([
        [root.id, rect(0, 0, 10, 6)],
        [panel.id, rect(2, 1, 4, 2)],
        [label.id, rect(0, 0, 9, 5)],
      ]),
      styles,
    );
    const index = buildPaintIndex(root, layout, 10, 6, (target) => styles.get(target.id)!);
    const retainedLabel = record(index, label.id);
    expect(retainedLabel.opacity).toBeCloseTo(0.2);
    expect(retainedLabel.clip).toEqual({ x: 2, y: 1, width: 4, height: 2 });

    const visiblePanelStyle = style({ opacity: 0.25, overflow: ENUM.overflowVisible });
    const visibleLayout = replaceEntry(layout, panel, rect(2, 1, 4, 2), visiblePanelStyle);
    const visible = index.prepareSubtreePatch(
      [panel],
      visibleLayout,
      (target) => (target === panel ? visiblePanelStyle : styles.get(target.id)!),
    );
    const visibleLabel = record(visible, label.id);
    expect(visibleLabel.opacity).toBeCloseTo(0.1);
    expect(visibleLabel.clip).toEqual({ x: 0, y: 0, width: 9, height: 5 });
    expect(record(index, label.id).clip).toEqual({ x: 2, y: 1, width: 4, height: 2 });
    visible.discard();
    expect(() => visible.rasterSnapshot()).toThrow("transaction is finished");

    const hiddenPanelStyle = style({ opacity: 0, overflow: ENUM.overflowHidden });
    const hiddenLayout = replaceEntry(layout, panel, rect(2, 1, 4, 2), hiddenPanelStyle);
    const hidden = index.prepareSubtreePatch(
      [panel],
      hiddenLayout,
      (target) => (target === panel ? hiddenPanelStyle : styles.get(target.id)!),
    );
    expect(hidden.orderRebuilt).toBe(true);
    expect(hidden.paintOrder).toEqual([]);
    expect(ids(hidden.rasterSnapshot(new Set([1])))).toEqual([]);
    expect(hidden.hitTest(2, 1)).toBe(0);
    expect(index.paintOrder).toEqual([label.id]);
  });

  test("isolates candidates until commit, advances retained ownership, and rejects stale transactions", () => {
    const root = node(1, NODE.view);
    const label = node(2, NODE.text, "move");
    append(root, label);
    const styles = new Map([
      [root.id, style()],
      [label.id, style()],
    ]);
    const layout = makeLayout(
      [root, label],
      new Map([
        [root.id, rect(0, 0, 8, 6)],
        [label.id, rect(0, 1, 4, 1)],
      ]),
      styles,
    );
    const index = buildPaintIndex(root, layout, 8, 6, (target) => styles.get(target.id)!);
    const rowFour = replaceEntry(layout, label, rect(0, 4, 4, 1), styles.get(label.id)!);
    const rowThree = replaceEntry(layout, label, rect(0, 3, 4, 1), styles.get(label.id)!);
    const committedTransaction = index.prepareSubtreePatch(
      [label],
      rowFour,
      (target) => styles.get(target.id)!,
    );
    const staleTransaction = index.prepareSubtreePatch(
      [label],
      rowThree,
      (target) => styles.get(target.id)!,
    );

    expect(ids(index.rasterSnapshot(new Set([1])))).toEqual([label.id]);
    expect(ids(index.rasterSnapshot(new Set([4])))).toEqual([]);
    expect(ids(committedTransaction.rasterSnapshot(new Set([1])))).toEqual([]);
    expect(ids(committedTransaction.rasterSnapshot(new Set([4])))).toEqual([label.id]);

    const committed = committedTransaction.commit();
    expect(ids(committed.rasterSnapshot(new Set([1])))).toEqual([]);
    expect(ids(committed.rasterSnapshot(new Set([4])))).toEqual([label.id]);
    expect(() => committedTransaction.rasterSnapshot()).toThrow("transaction is finished");
    expect(() => staleTransaction.paintOrder).toThrow("stale paint-index transaction");
    expect(() => staleTransaction.rasterSnapshot()).toThrow("stale paint-index transaction");
    expect(() => staleTransaction.commit()).toThrow("stale paint-index transaction");

    // Commit transfers the delta into the retained owner synchronously. This
    // avoids an O(scene) map clone while the pre-commit assertions above prove
    // that present/reentrant observers still see only confirmed state.
    expect(committed).toBe(index);
    expect(ids(index.rasterSnapshot(new Set([1])))).toEqual([]);
    expect(ids(index.rasterSnapshot(new Set([4])))).toEqual([label.id]);
  });

  test("rebuilds paint membership and z/document order only when semantics change", () => {
    const root = node(1, NODE.view);
    const layer = node(2, NODE.view);
    const first = node(3, NODE.view);
    const second = node(4, NODE.view);
    append(root, layer);
    append(layer, first);
    append(layer, second);
    const styles = new Map([
      [root.id, style()],
      [layer.id, style()],
      [first.id, style({ background: 0xff00_00ff })],
      [second.id, style({ background: 0xffff_0000 })],
    ]);
    const layout = makeLayout(
      [root, layer, first, second],
      new Map([
        [root.id, rect(0, 0, 8, 5)],
        [layer.id, rect(0, 0, 8, 5)],
        [first.id, rect(1, 1, 5, 3)],
        [second.id, rect(1, 1, 5, 3)],
      ]),
      styles,
    );
    const index = buildPaintIndex(root, layout, 8, 5, (target) => styles.get(target.id)!);
    expect(index.paintOrder).toEqual([first.id, second.id]);
    expect(index.hitTest(2, 2)).toBe(second.id);
    expect(() =>
      index.prepareSubtreePatch([layer, first], layout, (target) => styles.get(target.id)!),
    ).toThrow("patch roots must be disjoint");
    const duplicate = index.prepareSubtreePatch(
      [first, first],
      layout,
      (target) => styles.get(target.id)!,
    );
    expect(duplicate.roots).toBe(1);
    duplicate.discard();

    const raisedStyle = style({ background: 0xff00_00ff, zIndex: 10 });
    const raisedLayout = replaceEntry(layout, first, rect(1, 1, 5, 3), raisedStyle);
    const raised = index.prepareSubtreePatch(
      [layer],
      raisedLayout,
      (target) => (target === first ? raisedStyle : styles.get(target.id)!),
    );
    expect(raised.orderRebuilt).toBe(true);
    expect(raised.paintOrder).toEqual([second.id, first.id]);
    expect(raised.hitTest(2, 2)).toBe(first.id);
    expect(ids(raised.rasterSnapshot(new Set([2])))).toEqual([second.id, first.id]);

    const raisedIndex = raised.commit();
    const transparentSecond = style({ background: 0, zIndex: 0 });
    const membershipLayout = replaceEntry(
      raisedLayout,
      second,
      rect(1, 1, 5, 3),
      transparentSecond,
    );
    const membership = raisedIndex.prepareSubtreePatch(
      [second],
      membershipLayout,
      (target) =>
        target === first
          ? raisedStyle
          : target === second
            ? transparentSecond
            : styles.get(target.id)!,
    );
    expect(membership.orderRebuilt).toBe(true);
    expect(membership.paintOrder).toEqual([first.id]);
    expect(membership.hitTest(2, 2)).toBe(first.id);

    const movedLayout = replaceEntry(raisedLayout, first, rect(1, 2, 5, 3), raisedStyle);
    const moved = raisedIndex.prepareSubtreePatch(
      [first],
      movedLayout,
      (target) => (target === first ? raisedStyle : styles.get(target.id)!),
    );
    expect(moved.orderRebuilt).toBe(false);
    expect(moved.paintOrder).toBe(raisedIndex.paintOrder);
  });
});

function ids(snapshot: { readonly candidates: readonly { readonly id: number }[] }): number[] {
  return snapshot.candidates.map((candidate) => candidate.id);
}

function record(
  source: { rasterSnapshot(rows?: ReadonlySet<number>): { candidates: readonly any[] } },
  id: number,
): any {
  const candidate = source.rasterSnapshot().candidates.find((item) => item.id === id);
  if (candidate === undefined) throw new Error(`missing paint record ${id}`);
  return candidate;
}

function node(id: number, type: number, text = ""): HostNode {
  return {
    id,
    type,
    layoutRevision: 0,
    parent: null,
    children: [],
    text,
    styleId: -1,
    inline: new Map(),
    active: false,
    image: 0,
  };
}

function append(parent: HostNode, child: HostNode): void {
  parent.children.push(child);
  child.parent = parent;
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function makeLayout(
  nodes: readonly HostNode[],
  rects: ReadonlyMap<number, Rect>,
  styles: ReadonlyMap<number, ComputedStyle>,
): LayoutResult {
  const entries = new Map();
  const flattenedText = new Map();
  for (const target of nodes) {
    const targetRect = rects.get(target.id);
    const targetStyle = styles.get(target.id);
    if (targetRect !== undefined && targetStyle !== undefined) {
      entries.set(target.id, { node: target, rect: targetRect, style: targetStyle });
    }
    if (target.type === NODE.text) flattenedText.set(target.id, target.text);
  }
  return { entries, flattenedText };
}

function replaceEntry(
  layout: LayoutResult,
  target: HostNode,
  targetRect: Rect,
  targetStyle: ComputedStyle,
): LayoutResult {
  const entries = new Map(layout.entries);
  entries.set(target.id, { node: target, rect: targetRect, style: targetStyle });
  return { entries, flattenedText: new Map(layout.flattenedText) };
}

function style(overrides: Partial<ComputedStyle> = {}): ComputedStyle {
  return {
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    gap: 0,
    flexDirection: ENUM.flexColumn,
    justify: ENUM.justifyStart,
    align: ENUM.alignStart,
    grow: 0,
    shrink: 1,
    position: ENUM.relative,
    inset: {},
    display: ENUM.displayFlex,
    overflow: ENUM.overflowVisible,
    zIndex: 0,
    background: 0,
    opacity: 1,
    borderColor: 0,
    borderWidth: 0,
    textColor: 0xffff_ffff,
    textAlign: ENUM.textLeft,
    tracking: 0,
    ...overrides,
  };
}
