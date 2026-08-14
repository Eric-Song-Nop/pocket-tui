// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import type {
  CanvasFrame,
  CursorPacketOptions,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import { createPocketTuiHost, type PocketTuiSurface } from "../src/index.js";
import { ENUM, NODE, PROP, ROOT_ID } from "../src/spec.js";

class RecordingSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  failNextPresent: Error | undefined;
  onPresent: ((frame: CanvasFrame) => void) | undefined;

  constructor(public size: TuiViewportSize = { columns: 24, rows: 10 }) {}

  viewportSize(): TuiViewportSize {
    return this.size;
  }

  present(frame: CanvasFrame): void {
    const failure = this.failNextPresent;
    this.failNextPresent = undefined;
    if (failure !== undefined) throw failure;
    this.frames.push(frame);
    const callback = this.onPresent;
    this.onPresent = undefined;
    callback?.(frame);
  }

  setCursor(_options: CursorPacketOptions): void {}

  pollInput(): TuiInputEvent[] {
    return [];
  }

  start(): void {}

  flush(): void {}

  close(): void {}
}

describe("PocketJS localized absolute layout", () => {
  test("reflows an absolute text slot for text and geometry changes and matches the full oracle", () => {
    const surface = new RecordingSurface({ columns: 20, rows: 9 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const slot = host.ops.createNode(NODE.text);
    const content = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, slot, 0);
    host.ops.insertBefore(slot, content, 0);
    absoluteRect(host, slot, 2, 1, 8, 1);
    host.ops.setText(content, "A界");
    host.ops.setProp(slot, PROP.textColor, 0xff44_ddff);

    host.render();
    expect(host.diagnostics).toMatchObject({
      fullLayoutFrames: 1,
      localizedLayoutFrames: 0,
      reusedLayoutFrames: 0,
      layoutPasses: 1,
      lastLayoutNodes: 2,
      layoutNodes: 2,
      lastRelayoutRoots: 1,
    });

    assertLocalizedOracle(host, () => host.ops.setText(content, "A界🙂BC"), {
      nodes: 1,
      inspect: () => {
        expect(host.nodeRect(slot)).toEqual({ x: 2, y: 1, width: 8, height: 1 });
        expect(host.ops.hitTest(2, 1)).toBe(slot);
      },
    });
    assertLocalizedOracle(host, () => host.ops.setProp(slot, PROP.insetL, 5), {
      nodes: 1,
      inspect: () => expect(host.nodeRect(slot)?.x).toBe(5),
    });
    assertLocalizedOracle(host, () => host.ops.setProp(slot, PROP.width, 11), {
      nodes: 1,
      inspect: () => expect(host.nodeRect(slot)?.width).toBe(11),
    });
    assertLocalizedOracle(host, () => host.ops.setProp(slot, PROP.height, 2), {
      nodes: 1,
      inspect: () => expect(host.nodeRect(slot)?.height).toBe(2),
    });
    assertLocalizedOracle(host, () => host.ops.setProp(slot, PROP.lineHeight, 2), { nodes: 1 });
    assertLocalizedOracle(host, () => host.ops.setProp(slot, PROP.display, ENUM.displayNone), {
      nodes: 1,
      inspect: () => expect(host.nodeRect(slot)).toMatchObject({ width: 0, height: 0 }),
    });
    assertLocalizedOracle(host, () => host.ops.setProp(slot, PROP.display, ENUM.displayFlex), {
      nodes: 1,
      inspect: () => expect(host.nodeRect(slot)).toEqual({ x: 5, y: 1, width: 11, height: 2 }),
    });
  });

  test("keeps the complete geometry-property set local below a stable absolute boundary", () => {
    const surface = new RecordingSurface({ columns: 24, rows: 10 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const island = host.ops.createNode(NODE.view);
    const label = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, island, 0);
    host.ops.insertBefore(island, label, 0);
    absoluteRect(host, island, 2, 1, 10, 5);
    host.ops.setText(label, "geometry");
    host.render();

    const mutations = [
      ["width", () => host.ops.setProp(island, PROP.width, 11)],
      ["height", () => host.ops.setProp(island, PROP.height, 6)],
      ["minW", () => host.ops.setProp(island, PROP.minW, 4)],
      ["minH", () => host.ops.setProp(island, PROP.minH, 2)],
      ["maxW", () => host.ops.setProp(island, PROP.maxW, 15)],
      ["maxH", () => host.ops.setProp(island, PROP.maxH, 8)],
      ["paddingT", () => host.ops.setProp(island, PROP.paddingT, 1)],
      ["paddingR", () => host.ops.setProp(island, PROP.paddingR, 1)],
      ["paddingB", () => host.ops.setProp(island, PROP.paddingB, 1)],
      ["paddingL", () => host.ops.setProp(island, PROP.paddingL, 1)],
      ["marginT", () => host.ops.setProp(island, PROP.marginT, 1)],
      ["marginR", () => host.ops.setProp(island, PROP.marginR, 1)],
      ["marginB", () => host.ops.setProp(island, PROP.marginB, 1)],
      ["marginL", () => host.ops.setProp(island, PROP.marginL, 1)],
      ["gap", () => host.ops.setProp(island, PROP.gap, 1)],
      ["flexDir", () => host.ops.setProp(island, PROP.flexDir, ENUM.flexRow)],
      ["justify", () => host.ops.setProp(island, PROP.justify, ENUM.justifyCenter)],
      ["align", () => host.ops.setProp(island, PROP.align, ENUM.alignCenter)],
      ["grow", () => host.ops.setProp(island, PROP.grow, 2)],
      ["shrink", () => host.ops.setProp(island, PROP.shrink, 0.5)],
      ["basis", () => host.ops.setProp(island, PROP.basis, 3)],
      ["posType", () => host.ops.setProp(island, PROP.posType, ENUM.absolute)],
      ["insetT", () => host.ops.setProp(island, PROP.insetT, 2)],
      ["insetR", () => host.ops.setProp(island, PROP.insetR, 1)],
      ["insetB", () => host.ops.setProp(island, PROP.insetB, 1)],
      ["insetL", () => host.ops.setProp(island, PROP.insetL, 3)],
      ["lineHeight", () => host.ops.setProp(label, PROP.lineHeight, 2)],
      ["display:none", () => host.ops.setProp(island, PROP.display, ENUM.displayNone)],
      ["display:flex", () => host.ops.setProp(island, PROP.display, ENUM.displayFlex)],
    ] as const;

    for (const [property, mutate] of mutations) {
      const before = host.diagnostics;
      mutate();
      const localized = host.render();
      expect({ property, full: host.diagnostics.fullLayoutFrames }).toEqual({
        property,
        full: before.fullLayoutFrames,
      });
      expect(host.diagnostics.localizedLayoutFrames).toBe(before.localizedLayoutFrames + 1);
      expect(host.diagnostics.lastRelayoutRoots).toBe(1);
      expect({ property, localized }).toEqual({ property, localized: host.render(true) });
    }
  });

  test("coalesces multiple dirty sources under one nearest absolute ancestor", () => {
    const surface = new RecordingSurface({ columns: 22, rows: 10 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const outer = host.ops.createNode(NODE.view);
    const inner = host.ops.createNode(NODE.view);
    const label = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, outer, 0);
    host.ops.insertBefore(outer, inner, 0);
    host.ops.insertBefore(inner, label, 0);
    absoluteRect(host, outer, 2, 1, 14, 7);
    absoluteRect(host, inner, 1, 1, 8, 4);
    host.ops.setText(label, "nested");
    host.render();

    assertLocalizedOracle(
      host,
      () => {
        host.ops.setProp(outer, PROP.width, 16);
        host.ops.setProp(inner, PROP.insetL, 3);
        host.ops.setText(label, "nested change");
      },
      {
        roots: 1,
        nodes: 3,
        inspect: () => {
          expect(host.nodeRect(outer)).toEqual({ x: 2, y: 1, width: 16, height: 7 });
          expect(host.nodeRect(inner)?.x).toBe(5);
        },
      },
    );

    // Losing an inner boundary remains local when a retained outer absolute
    // island can absorb the resulting Flex reflow; the inverse transition is
    // isolated by the same outer root.
    assertLocalizedOracle(host, () => host.ops.setProp(inner, PROP.posType, ENUM.relative), {
      roots: 1,
      nodes: 3,
    });
    assertLocalizedOracle(host, () => host.ops.setProp(inner, PROP.posType, ENUM.absolute), {
      roots: 1,
      nodes: 3,
    });
  });

  test("lays out disjoint absolute roots together and repaints both old and new rows", () => {
    const surface = new RecordingSurface({ columns: 16, rows: 10 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const top = absoluteText(host, "top", 1, 1, 6, 1);
    const bottom = absoluteText(host, "bottom", 1, 6, 8, 1);
    host.render();

    assertLocalizedOracle(
      host,
      () => {
        host.ops.setProp(top, PROP.insetT, 2);
        host.ops.setProp(bottom, PROP.insetT, 7);
      },
      {
        roots: 2,
        nodes: 2,
        repaintedRows: 4,
        inspect: () => {
          expect(host.nodeRect(top)?.y).toBe(2);
          expect(host.nodeRect(bottom)?.y).toBe(7);
          expect(host.ops.hitTest(1, 2)).toBe(top);
          expect(host.ops.hitTest(1, 7)).toBe(bottom);
        },
      },
    );
  });

  test("drops and restores an absolute view subtree without stale entries or uncleared spill rows", () => {
    const surface = new RecordingSurface({ columns: 16, rows: 10 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const panel = host.ops.createNode(NODE.view);
    const spill = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, panel, 0);
    host.ops.insertBefore(panel, spill, 0);
    absoluteRect(host, panel, 2, 2, 6, 3);
    absoluteRect(host, spill, 1, 4, 4, 2);
    host.ops.setProp(panel, PROP.overflow, ENUM.overflowVisible);
    host.ops.setProp(panel, PROP.bgColor, 0xff20_2020);
    host.ops.setText(spill, "spill");
    host.render();

    expect(host.nodeRect(spill)).toEqual({ x: 3, y: 6, width: 4, height: 2 });
    assertLocalizedOracle(host, () => host.ops.setProp(panel, PROP.display, ENUM.displayNone), {
      nodes: 1,
      repaintedRows: 5,
      inspect: () => {
        expect(host.nodeRect(panel)).toMatchObject({ width: 0, height: 0 });
        expect(host.nodeRect(spill)).toBeUndefined();
        expect(host.ops.hitTest(3, 6)).not.toBe(spill);
      },
    });
    assertLocalizedOracle(host, () => host.ops.setProp(panel, PROP.display, ENUM.displayFlex), {
      nodes: 2,
      repaintedRows: 5,
      inspect: () => {
        expect(host.nodeRect(panel)).toEqual({ x: 2, y: 2, width: 6, height: 3 });
        expect(host.nodeRect(spill)).toEqual({ x: 3, y: 6, width: 4, height: 2 });
        expect(host.ops.hitTest(3, 6)).toBe(spill);
      },
    });
  });

  test("falls back to the full oracle when an absolute boundary or flex flow can change", () => {
    const surface = new RecordingSurface({ columns: 18, rows: 8 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const flow = host.ops.createNode(NODE.view);
    const first = host.ops.createNode(NODE.text);
    const second = host.ops.createNode(NODE.text);
    const absolute = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, flow, 0);
    host.ops.insertBefore(flow, first, 0);
    host.ops.insertBefore(flow, second, 0);
    host.ops.insertBefore(ROOT_ID, absolute, 0);
    host.ops.setProp(flow, PROP.width, 18);
    host.ops.setProp(flow, PROP.height, 5);
    host.ops.setText(first, "one");
    host.ops.setText(second, "two");
    absoluteRect(host, absolute, 10, 6, 6, 1);
    host.ops.setText(absolute, "abs");
    host.render();

    assertFullOracle(host, () => host.ops.setProp(absolute, PROP.posType, ENUM.relative));
    assertFullOracle(host, () => host.ops.setProp(first, PROP.width, 7));
    assertFullOracle(host, () => host.ops.setText(second, "text changes flex measurement"));
  });

  test("combines paint and localized layout mutations without ordering sensitivity", () => {
    const surface = new RecordingSurface({ columns: 14, rows: 8 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const slot = absoluteText(host, "mixed", 2, 1, 7, 1);
    host.render();

    assertLocalizedOracle(
      host,
      () => {
        host.ops.setProp(slot, PROP.bgColor, 0xff20_60c0);
        host.ops.setProp(slot, PROP.insetT, 2);
      },
      { nodes: 1, repaintedRows: 2 },
    );
    assertLocalizedOracle(
      host,
      () => {
        host.ops.setProp(slot, PROP.insetT, 4);
        host.ops.setProp(slot, PROP.textColor, 0xffff_8844);
      },
      { nodes: 1, repaintedRows: 2 },
    );

    const beforePaint = host.diagnostics;
    host.ops.setProp(slot, PROP.bgColor, 0xffc0_4020);
    const paint = host.render();
    expect(host.diagnostics).toMatchObject({
      renderedFrames: beforePaint.renderedFrames + 1,
      layoutPasses: beforePaint.layoutPasses,
      fullLayoutFrames: beforePaint.fullLayoutFrames,
      localizedLayoutFrames: beforePaint.localizedLayoutFrames,
      reusedLayoutFrames: beforePaint.reusedLayoutFrames + 1,
      lastLayoutNodes: 0,
      layoutNodes: beforePaint.layoutNodes,
      lastRelayoutRoots: 0,
    });
    expectDiagnosticSums(host);
    expect(paint).toEqual(host.render(true));
  });

  test("commits a detached layout mutation as a zero-work geometry reuse frame", () => {
    const surface = new RecordingSurface({ columns: 10, rows: 4 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const detached = host.ops.createNode(NODE.text);
    host.render();
    const committed = host.frame;
    const before = host.diagnostics;

    host.ops.setText(detached, "invisible");
    const frame = host.render();

    expect(frame).toBe(committed);
    expect(host.renderPending).toBe(false);
    expect(host.diagnostics).toMatchObject({
      renderedFrames: before.renderedFrames + 1,
      layoutPasses: before.layoutPasses,
      fullLayoutFrames: before.fullLayoutFrames,
      localizedLayoutFrames: before.localizedLayoutFrames,
      reusedLayoutFrames: before.reusedLayoutFrames + 1,
      fullRasterFrames: before.fullRasterFrames,
      incrementalRasterFrames: before.incrementalRasterFrames + 1,
      lastLayoutNodes: 0,
      layoutNodes: before.layoutNodes,
      lastRelayoutRoots: 0,
      lastRepaintedRows: 0,
      repaintedRows: before.repaintedRows,
    });
    expectDiagnosticSums(host);
    expect(frame).toEqual(host.render(true));
  });

  test("does not commit failed localized work and retries it exactly", () => {
    const surface = new RecordingSurface({ columns: 12, rows: 5 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const slot = absoluteText(host, "retry", 1, 1, 6, 1);
    host.render();
    const committedFrame = host.frame;
    const committedRect = host.nodeRect(slot);

    host.ops.setProp(slot, PROP.width, 9);
    const beforeFailure = host.diagnostics;
    surface.failNextPresent = new Error("localized present failed");
    expect(() => host.render()).toThrow("localized present failed");

    expect(host.frame).toBe(committedFrame);
    expect(host.nodeRect(slot)).toEqual(committedRect);
    expect(host.diagnostics).toEqual(beforeFailure);
    expect(host.renderPending).toBe(true);

    const retry = host.render();
    expect(host.renderPending).toBe(false);
    expect(host.nodeRect(slot)?.width).toBe(9);
    expect(host.diagnostics).toMatchObject({
      renderedFrames: beforeFailure.renderedFrames + 1,
      layoutPasses: beforeFailure.layoutPasses + 1,
      fullLayoutFrames: beforeFailure.fullLayoutFrames,
      localizedLayoutFrames: beforeFailure.localizedLayoutFrames + 1,
      incrementalRasterFrames: beforeFailure.incrementalRasterFrames + 1,
      lastLayoutNodes: 1,
      lastRelayoutRoots: 1,
    });
    expect(retry).toEqual(host.render(true));
    expectDiagnosticSums(host);
  });

  test("retains localized and promoted full work created reentrantly during present", () => {
    const surface = new RecordingSurface({ columns: 16, rows: 7 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const slot = absoluteText(host, "reentrant", 1, 1, 8, 1);
    host.render();

    host.ops.setProp(slot, PROP.insetT, 2);
    surface.onPresent = () => host.ops.setProp(slot, PROP.width, 10);
    const beforeFirst = host.diagnostics;
    host.render();
    expect(host.renderPending).toBe(true);
    expect(host.nodeRect(slot)).toEqual({ x: 1, y: 2, width: 8, height: 1 });
    expect(host.diagnostics.localizedLayoutFrames).toBe(beforeFirst.localizedLayoutFrames + 1);

    const beforeLocalRetry = host.diagnostics;
    const localRetry = host.render();
    expect(host.renderPending).toBe(false);
    expect(host.nodeRect(slot)).toEqual({ x: 1, y: 2, width: 10, height: 1 });
    expect(host.diagnostics.localizedLayoutFrames).toBe(beforeLocalRetry.localizedLayoutFrames + 1);
    expect(localRetry).toEqual(host.render(true));

    host.ops.setProp(slot, PROP.insetT, 3);
    surface.onPresent = () => host.ops.setProp(slot, PROP.posType, ENUM.relative);
    host.render();
    expect(host.renderPending).toBe(true);
    const beforeFullRetry = host.diagnostics;
    const fullRetry = host.render();
    expect(host.renderPending).toBe(false);
    expect(host.diagnostics).toMatchObject({
      fullLayoutFrames: beforeFullRetry.fullLayoutFrames + 1,
      localizedLayoutFrames: beforeFullRetry.localizedLayoutFrames,
      fullRasterFrames: beforeFullRetry.fullRasterFrames + 1,
    });
    expect(fullRetry).toEqual(host.render(true));
    expectDiagnosticSums(host);
  });

  test("matches frame, geometry, and hit testing across randomized absolute-slot mutations", () => {
    const surface = new RecordingSurface({ columns: 32, rows: 12 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const slots = Array.from({ length: 16 }, (_, index) =>
      absoluteText(host, `slot-${index}`, (index % 4) * 7, Math.floor(index / 4) * 2, 6, 1),
    );
    host.render();
    let random = 0x5eed_1234;
    const next = (): number => {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      return random;
    };

    for (let step = 0; step < 128; step += 1) {
      const selected = new Set<number>();
      const mutationCount = 1 + (next() % 4);
      while (selected.size < mutationCount) selected.add(next() % slots.length);
      const before = host.diagnostics;
      for (const index of selected) {
        const slot = slots[index];
        if (slot === undefined) throw new Error("missing randomized slot");
        const mutation = next() % 5;
        if (mutation === 0) {
          host.ops.setText(slot, `s${step}-${index}-界-${next() % 100}`);
        } else if (mutation === 1) {
          host.ops.setProp(slot, PROP.insetL, next() % 25);
        } else if (mutation === 2) {
          host.ops.setProp(slot, PROP.insetT, next() % 11);
        } else if (mutation === 3) {
          host.ops.setProp(slot, PROP.width, 1 + (next() % 8));
        } else {
          host.ops.setProp(slot, PROP.height, 1 + (next() % 2));
        }
      }

      const localized = host.render();
      const localizedGeometry = geometrySnapshot(host);
      const localizedHits = hitTestGrid(host, surface.size);
      expect(host.diagnostics).toMatchObject({
        fullLayoutFrames: before.fullLayoutFrames,
        localizedLayoutFrames: before.localizedLayoutFrames + 1,
        lastRelayoutRoots: selected.size,
        lastLayoutNodes: selected.size,
      });
      const oracle = host.render(true);
      expect({ step, localized }).toEqual({ step, localized: oracle });
      expect(geometrySnapshot(host)).toEqual(localizedGeometry);
      expect(hitTestGrid(host, surface.size)).toEqual(localizedHits);
      expectDiagnosticSums(host);
    }
  });
});

interface LocalizedExpectation {
  readonly roots?: number;
  readonly nodes: number;
  readonly repaintedRows?: number;
  readonly inspect?: () => void;
}

function assertLocalizedOracle(
  host: ReturnType<typeof createPocketTuiHost>,
  mutate: () => void,
  expectation: LocalizedExpectation,
): void {
  const before = host.diagnostics;
  mutate();
  expect(host.renderPending).toBe(true);
  const localized = host.render();
  const after = host.diagnostics;
  const geometry = geometrySnapshot(host);

  expect(after).toMatchObject({
    renderedFrames: before.renderedFrames + 1,
    layoutPasses: before.layoutPasses + 1,
    fullLayoutFrames: before.fullLayoutFrames,
    localizedLayoutFrames: before.localizedLayoutFrames + 1,
    reusedLayoutFrames: before.reusedLayoutFrames,
    fullRasterFrames: before.fullRasterFrames,
    incrementalRasterFrames: before.incrementalRasterFrames + 1,
    lastLayoutNodes: expectation.nodes,
    layoutNodes: before.layoutNodes + expectation.nodes,
    lastRelayoutRoots: expectation.roots ?? 1,
  });
  if (expectation.repaintedRows !== undefined) {
    expect(after.lastRepaintedRows).toBe(expectation.repaintedRows);
    expect(after.repaintedRows).toBe(before.repaintedRows + expectation.repaintedRows);
  }
  expectation.inspect?.();
  expectDiagnosticSums(host);

  const oracle = host.render(true);
  expect(localized).toEqual(oracle);
  expect(geometrySnapshot(host)).toEqual(geometry);
  expectDiagnosticSums(host);
}

function assertFullOracle(
  host: ReturnType<typeof createPocketTuiHost>,
  mutate: () => void,
): void {
  const before = host.diagnostics;
  mutate();
  const full = host.render();
  const after = host.diagnostics;
  const geometry = geometrySnapshot(host);

  expect(after).toMatchObject({
    renderedFrames: before.renderedFrames + 1,
    layoutPasses: before.layoutPasses + 1,
    fullLayoutFrames: before.fullLayoutFrames + 1,
    localizedLayoutFrames: before.localizedLayoutFrames,
    reusedLayoutFrames: before.reusedLayoutFrames,
    fullRasterFrames: before.fullRasterFrames + 1,
    incrementalRasterFrames: before.incrementalRasterFrames,
    lastRepaintedRows: full.height,
  });
  expect(after.lastLayoutNodes).toBeGreaterThan(0);
  expect(after.layoutNodes).toBe(before.layoutNodes + after.lastLayoutNodes);
  expect(after.lastRelayoutRoots).toBe(1);
  expectDiagnosticSums(host);

  const oracle = host.render(true);
  expect(full).toEqual(oracle);
  expect(geometrySnapshot(host)).toEqual(geometry);
  expectDiagnosticSums(host);
}

function expectDiagnosticSums(host: ReturnType<typeof createPocketTuiHost>): void {
  const diagnostics = host.diagnostics;
  expect(diagnostics.renderedFrames).toBe(
    diagnostics.fullLayoutFrames +
      diagnostics.localizedLayoutFrames +
      diagnostics.reusedLayoutFrames,
  );
  expect(diagnostics.layoutPasses).toBe(
    diagnostics.fullLayoutFrames + diagnostics.localizedLayoutFrames,
  );
  expect(diagnostics.renderedFrames).toBe(
    diagnostics.fullRasterFrames + diagnostics.incrementalRasterFrames,
  );
}

function absoluteText(
  host: ReturnType<typeof createPocketTuiHost>,
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
): number {
  const node = host.ops.createNode(NODE.text);
  host.ops.insertBefore(ROOT_ID, node, 0);
  absoluteRect(host, node, left, top, width, height);
  host.ops.setText(node, text);
  return node;
}

function absoluteRect(
  host: ReturnType<typeof createPocketTuiHost>,
  node: number,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  host.ops.setProp(node, PROP.posType, ENUM.absolute);
  host.ops.setProp(node, PROP.insetL, left);
  host.ops.setProp(node, PROP.insetT, top);
  host.ops.setProp(node, PROP.width, width);
  host.ops.setProp(node, PROP.height, height);
}

function geometrySnapshot(host: ReturnType<typeof createPocketTuiHost>) {
  return host
    .snapshot()
    .map(({ id, rect }) => ({ id, rect }))
    .sort((left, right) => left.id - right.id);
}

function hitTestGrid(
  host: ReturnType<typeof createPocketTuiHost>,
  size: TuiViewportSize,
): number[] {
  const hits: number[] = [];
  for (let y = 0; y < size.rows; y += 1) {
    for (let x = 0; x < size.columns; x += 1) hits.push(host.ops.hitTest(x, y));
  }
  return hits;
}
