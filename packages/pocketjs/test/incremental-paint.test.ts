// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import type {
  CanvasFrame,
  CursorPacketOptions,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import { createPocketTuiHost, type PocketTuiSurface } from "../src/index.js";
import {
  ENUM,
  NODE,
  PROP,
  ROOT_ID,
  STYLE_ACTIVE,
  STYLE_BASE,
  STYLE_FOCUS,
  STYLE_HEADER_BYTES,
  STYLE_MAGIC,
  STYLE_VERSION,
} from "../src/spec.js";

class RecordingSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  readonly dirtyRowHints: Array<readonly number[] | undefined> = [];
  failNextPresent: Error | undefined;
  onPresent: ((frame: CanvasFrame) => void) | undefined;

  constructor(public size: TuiViewportSize = { columns: 18, rows: 8 }) {}

  viewportSize(): TuiViewportSize {
    return this.size;
  }

  present(frame: CanvasFrame, dirtyRows?: ReadonlySet<number>): void {
    const failure = this.failNextPresent;
    this.failNextPresent = undefined;
    if (failure !== undefined) throw failure;
    this.frames.push(frame);
    this.dirtyRowHints.push(
      dirtyRows === undefined ? undefined : [...dirtyRows].sort((left, right) => left - right),
    );
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

describe("PocketJS incremental paint", () => {
  test("reports full initial work and leaves clean frames untouched", () => {
    const surface = new RecordingSurface({ columns: 12, rows: 5 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const text = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, text, 0);
    host.ops.setText(text, "initial");

    expect(host.diagnostics).toMatchObject({
      layoutPasses: 0,
      fullLayoutFrames: 0,
      localizedLayoutFrames: 0,
      reusedLayoutFrames: 0,
      lastLayoutNodes: 0,
      layoutNodes: 0,
      lastRelayoutRoots: 0,
      fullRasterFrames: 0,
      incrementalRasterFrames: 0,
      lastRepaintedRows: 0,
      repaintedRows: 0,
    });

    const frame = host.render();
    expect(frame).toBe(host.frame);
    expect(host.diagnostics).toMatchObject({
      renderedFrames: 1,
      skippedFrames: 0,
      layoutPasses: 1,
      fullLayoutFrames: 1,
      localizedLayoutFrames: 0,
      reusedLayoutFrames: 0,
      lastLayoutNodes: 2,
      layoutNodes: 2,
      lastRelayoutRoots: 1,
      fullRasterFrames: 1,
      incrementalRasterFrames: 0,
      lastRepaintedRows: 5,
      repaintedRows: 5,
    });

    expect(host.render()).toBe(frame);
    expect(host.diagnostics).toMatchObject({
      renderedFrames: 1,
      skippedFrames: 1,
      layoutPasses: 1,
      reusedLayoutFrames: 0,
      fullRasterFrames: 1,
      incrementalRasterFrames: 0,
      lastRepaintedRows: 5,
      repaintedRows: 5,
    });
    expect(surface.dirtyRowHints).toEqual([undefined]);
  });

  test("passes exact whole-row patch hints while full and resize frames stay authoritative", () => {
    const surface = new RecordingSurface({ columns: 12, rows: 6 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const top = host.ops.createNode(NODE.view);
    const bottom = host.ops.createNode(NODE.view);
    host.ops.insertBefore(ROOT_ID, top, 0);
    host.ops.insertBefore(ROOT_ID, bottom, 0);
    absoluteRect(host, top, 1, 1, 4, 1);
    absoluteRect(host, bottom, 1, 4, 4, 1);
    host.ops.setProp(top, PROP.bgColor, 0xff22_2222);
    host.ops.setProp(bottom, PROP.bgColor, 0xff44_4444);

    host.render();
    host.ops.setProp(top, PROP.bgColor, 0xff00_00ff);
    host.ops.setProp(bottom, PROP.bgColor, 0xffff_0000);
    host.render();
    host.render(true);
    host.resize(10, 5);
    host.render();

    expect(surface.dirtyRowHints).toEqual([undefined, [1, 4], undefined, undefined]);
  });

  test("reuses geometry for every paint-only property and matches a full-render oracle", () => {
    const surface = new RecordingSurface();
    const { host, panel, label, overlay } = complexScene(surface);
    host.render();

    const mutations = [
      ["overflow", () => host.ops.setProp(panel, PROP.overflow, ENUM.overflowHidden)],
      ["zIndex", () => host.ops.setProp(overlay, PROP.zIndex, 7)],
      ["bgColor", () => host.ops.setProp(panel, PROP.bgColor, 0xff42_2412)],
      ["opacity", () => host.ops.setProp(overlay, PROP.opacity, 0.55)],
      ["borderColor", () => host.ops.setProp(panel, PROP.borderColor, 0xff33_bbff)],
      ["borderWidth", () => host.ops.setProp(panel, PROP.borderWidth, 1)],
      ["textColor", () => host.ops.setProp(label, PROP.textColor, 0xff44_ee88)],
      ["textAlign", () => host.ops.setProp(label, PROP.textAlign, ENUM.textRight)],
      ["tracking", () => host.ops.setProp(label, PROP.tracking, 1)],
    ] as const;

    for (const [name, mutate] of mutations) {
      const geometry = rectSnapshot(host);
      mutate();
      const before = host.diagnostics;
      const partial = host.render();
      const afterPartial = host.diagnostics;

      expect(rectSnapshot(host)).toEqual(geometry);
      expect(afterPartial.layoutPasses).toBe(before.layoutPasses);
      expect(afterPartial.reusedLayoutFrames).toBe(before.reusedLayoutFrames + 1);
      expect(afterPartial.fullRasterFrames).toBe(before.fullRasterFrames);
      expect(afterPartial.incrementalRasterFrames).toBe(before.incrementalRasterFrames + 1);
      expect(afterPartial.lastRepaintedRows).toBeGreaterThan(0);
      expect(afterPartial.lastRepaintedRows).toBeLessThan(surface.size.rows);

      const oracle = host.render(true);
      expect({ property: name, frame: partial }).toEqual({ property: name, frame: oracle });
      expect(host.diagnostics.layoutPasses).toBe(afterPartial.layoutPasses + 1);
      expect(host.diagnostics.fullRasterFrames).toBe(afterPartial.fullRasterFrames + 1);
      expect(host.diagnostics.incrementalRasterFrames).toBe(afterPartial.incrementalRasterFrames);
    }
  });

  test("uses dirty-node subtree row bounds, including descendants outside their parent", () => {
    const surface = new RecordingSurface({ columns: 12, rows: 8 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const panel = host.ops.createNode(NODE.view);
    const child = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, panel, 0);
    host.ops.insertBefore(panel, child, 0);
    absoluteRect(host, panel, 1, 2, 8, 3);
    absoluteRect(host, child, 0, 2, 4, 2);
    host.ops.setProp(panel, PROP.bgColor, 0xff20_2020);
    host.ops.setText(child, "界X");
    host.ops.setProp(child, PROP.textColor, 0xffff_ffff);
    host.render();

    expect(host.nodeRect(panel)).toEqual({ x: 1, y: 2, width: 8, height: 3 });
    expect(host.nodeRect(child)).toEqual({ x: 1, y: 4, width: 4, height: 2 });

    host.ops.setProp(panel, PROP.opacity, 0.5);
    const parentPartial = host.render();
    expect(host.diagnostics).toMatchObject({
      reusedLayoutFrames: 1,
      incrementalRasterFrames: 1,
      lastRepaintedRows: 4,
      repaintedRows: 12,
    });
    const parentOracle = host.render(true);
    expect(parentPartial).toEqual(parentOracle);

    host.ops.setProp(child, PROP.textColor, 0xff55_ddff);
    const childPartial = host.render();
    expect(host.diagnostics).toMatchObject({
      reusedLayoutFrames: 2,
      incrementalRasterFrames: 2,
      lastRepaintedRows: 2,
      repaintedRows: 22,
    });
    const childOracle = host.render(true);
    expect(childPartial).toEqual(childOracle);
  });

  test("coalesces disjoint rows and lets localized layout dominate paint ordering", () => {
    const surface = new RecordingSurface({ columns: 10, rows: 7 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const top = host.ops.createNode(NODE.view);
    const bottom = host.ops.createNode(NODE.view);
    host.ops.insertBefore(ROOT_ID, top, 0);
    host.ops.insertBefore(ROOT_ID, bottom, 0);
    absoluteRect(host, top, 1, 1, 4, 1);
    absoluteRect(host, bottom, 1, 5, 4, 1);
    host.ops.setProp(top, PROP.bgColor, 0xff22_2222);
    host.ops.setProp(bottom, PROP.bgColor, 0xff44_4444);
    host.render();

    host.ops.setProp(top, PROP.bgColor, 0xff00_00ff);
    host.ops.setProp(bottom, PROP.bgColor, 0xffff_0000);
    const partial = host.render();
    expect(host.diagnostics).toMatchObject({
      reusedLayoutFrames: 1,
      incrementalRasterFrames: 1,
      lastRepaintedRows: 2,
      repaintedRows: 9,
    });
    expect(partial).toEqual(host.render(true));

    assertLocalizedInvalidation(
      host,
      () => {
        host.ops.setProp(top, PROP.bgColor, 0xff00_ff00);
        host.ops.setProp(top, PROP.width, 5);
      },
      1,
    );
    assertLocalizedInvalidation(
      host,
      () => {
        host.ops.setProp(bottom, PROP.height, 2);
        host.ops.setProp(bottom, PROP.opacity, 0.5);
      },
      2,
    );
  });

  test("caches flow geometry while tree, style, focus, active, and resize retain the full oracle", () => {
    const surface = new RecordingSurface({ columns: 14, rows: 6 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const panel = host.ops.createNode(NODE.view);
    const text = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, panel, 0);
    host.ops.insertBefore(panel, text, 0);
    host.ops.setProp(panel, PROP.width, 10);
    host.ops.setProp(panel, PROP.height, 4);
    host.ops.setText(text, "full");
    host.render();

    assertCachedInvalidation(host, () => host.ops.setProp(panel, PROP.width, 11));
    assertCachedInvalidation(host, () => host.ops.setText(text, "cached oracle"));
    let added = 0;
    assertFullInvalidation(
      host,
      () => {
        added = host.ops.createNode(NODE.text);
        host.ops.insertBefore(panel, added, 0);
        host.ops.setText(added, "tree");
      },
      6,
    );
    assertFullInvalidation(host, () => host.loadStyles(styleTable()), 6);
    assertFullInvalidation(host, () => host.ops.setStyle(text, 0), 6);
    assertFullInvalidation(host, () => host.ops.setFocus(text), 6);
    assertFullInvalidation(host, () => host.ops.setActive(text, 1), 6);

    surface.size = { columns: 16, rows: 7 };
    assertFullInvalidation(host, () => host.resize(16, 7), 7);
    expect(host.frame).toMatchObject({ width: 16, height: 7 });
    expect(host.snapshot().some((node) => node.id === added)).toBe(true);
  });

  test("does not commit an incremental render when present fails and retries the same work", () => {
    const surface = new RecordingSurface({ columns: 10, rows: 4 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const text = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, text, 0);
    host.ops.setText(text, "界A");
    host.ops.setProp(text, PROP.width, 6);
    host.render();
    const committed = host.frame;

    host.ops.setProp(text, PROP.textColor, 0xff22_ccff);
    const beforeFailure = host.diagnostics;
    surface.failNextPresent = new Error("present failed");
    expect(() => host.render()).toThrow("present failed");
    expect(host.renderPending).toBe(true);
    expect(host.frame).toBe(committed);
    expect(host.diagnostics).toEqual(beforeFailure);

    const retry = host.render();
    const afterRetry = host.diagnostics;
    expect(host.renderPending).toBe(false);
    expect(afterRetry.layoutPasses).toBe(beforeFailure.layoutPasses);
    expect(afterRetry.reusedLayoutFrames).toBe(beforeFailure.reusedLayoutFrames + 1);
    expect(afterRetry.incrementalRasterFrames).toBe(beforeFailure.incrementalRasterFrames + 1);
    expect(afterRetry.renderedFrames).toBe(beforeFailure.renderedFrames + 1);

    const oracle = host.render(true);
    expect(retry).toEqual(oracle);
  });

  test("retains and notifies paint or full work created reentrantly during present", async () => {
    const surface = new RecordingSurface({ columns: 10, rows: 4 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const text = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, text, 0);
    host.ops.setText(text, "reentrant");
    host.ops.setProp(text, PROP.width, 6);
    host.render();
    await host.flush();

    let notifications = 0;
    const dispose = host.onWorkNeeded(() => {
      notifications += 1;
    });

    host.ops.setProp(text, PROP.textColor, 0xff22_ccff);
    host.setCursor({ row: 0, column: 0, visible: false });
    const beforePaintPresent = notifications;
    let paintCallbacks = 0;
    surface.onPresent = () => {
      paintCallbacks += 1;
      host.ops.setProp(text, PROP.bgColor, 0xff20_1008);
    };
    host.render();

    expect(paintCallbacks).toBe(1);
    expect(host.renderPending).toBe(true);
    expect(notifications).toBe(beforePaintPresent + 1);
    const paintRetry = host.render();
    expect(host.renderPending).toBe(false);
    expect(paintRetry).toEqual(host.render(true));

    await host.flush();
    host.ops.setProp(text, PROP.textColor, 0xffff_ee44);
    host.setCursor({ row: 0, column: 0, visible: false });
    const beforeLayoutPresent = notifications;
    let layoutCallbacks = 0;
    surface.onPresent = () => {
      layoutCallbacks += 1;
      host.ops.setProp(text, PROP.width, 8);
    };
    host.render();

    expect(layoutCallbacks).toBe(1);
    expect(host.renderPending).toBe(true);
    expect(notifications).toBe(beforeLayoutPresent + 1);
    const beforeLayoutRetry = host.diagnostics;
    const layoutRetry = host.render();
    expect(host.diagnostics).toMatchObject({
      layoutPasses: beforeLayoutRetry.layoutPasses + 1,
      fullLayoutFrames: beforeLayoutRetry.fullLayoutFrames,
      cachedLayoutFrames: beforeLayoutRetry.cachedLayoutFrames + 1,
      fullRasterFrames: beforeLayoutRetry.fullRasterFrames,
      incrementalRasterFrames: beforeLayoutRetry.incrementalRasterFrames + 1,
    });
    expect(host.renderPending).toBe(false);
    expect(layoutRetry).toEqual(host.render(true));
    dispose();
  });

  test("rejects recursive render without committing the outer cache or losing reentrant paint", () => {
    const surface = new RecordingSurface({ columns: 10, rows: 4 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const text = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, text, 0);
    host.ops.setText(text, "nested");
    host.ops.setProp(text, PROP.width, 7);
    host.render();

    const committedFrame = host.frame;
    const committedRect = host.nodeRect(text);
    host.ops.setProp(text, PROP.textColor, 0xff44_ddff);
    const beforeFailure = host.diagnostics;
    surface.onPresent = () => {
      host.ops.setProp(text, PROP.bgColor, 0xff18_1008);
      host.render();
    };

    expect(() => host.render()).toThrow(/render is already in progress/);
    expect(host.frame).toBe(committedFrame);
    expect(host.nodeRect(text)).toEqual(committedRect);
    expect(host.diagnostics).toMatchObject({
      mutations: beforeFailure.mutations + 1,
      renderedFrames: beforeFailure.renderedFrames,
      layoutPasses: beforeFailure.layoutPasses,
      reusedLayoutFrames: beforeFailure.reusedLayoutFrames,
      fullRasterFrames: beforeFailure.fullRasterFrames,
      incrementalRasterFrames: beforeFailure.incrementalRasterFrames,
      lastRepaintedRows: beforeFailure.lastRepaintedRows,
      repaintedRows: beforeFailure.repaintedRows,
      lastRunCount: beforeFailure.lastRunCount,
    });
    expect(host.renderPending).toBe(true);
    expectDiagnosticSums(host);

    const retry = host.render();
    expect(host.renderPending).toBe(false);
    expect(retry).toEqual(host.render(true));
    expectDiagnosticSums(host);

    host.ops.setProp(text, PROP.textColor, 0xffff_ee44);
    let caughtNested: unknown;
    surface.onPresent = () => {
      host.ops.setProp(text, PROP.opacity, 0.6);
      try {
        host.render();
      } catch (error) {
        caughtNested = error;
      }
    };
    host.render();

    expect(caughtNested).toBeInstanceOf(Error);
    expect((caughtNested as Error).message).toMatch(/render is already in progress/);
    expect(host.renderPending).toBe(true);
    const caughtRetry = host.render();
    expect(caughtRetry).toEqual(host.render(true));
    expectDiagnosticSums(host);
  });

  test("dispatches work listeners after the render transaction so they may render synchronously", async () => {
    const surface = new RecordingSurface({ columns: 9, rows: 3 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const text = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, text, 0);
    host.ops.setText(text, "edge");
    host.render();
    await host.flush();

    let notifications = 0;
    const dispose = host.onWorkNeeded(() => {
      notifications += 1;
      host.render();
    });
    const before = host.diagnostics;
    host.ops.setProp(text, PROP.textColor, 0xff55_ddff);

    expect(notifications).toBe(2);
    expect(host.renderPending).toBe(false);
    expect(host.diagnostics).toMatchObject({
      renderedFrames: before.renderedFrames + 1,
      skippedFrames: before.skippedFrames + 1,
      reusedLayoutFrames: before.reusedLayoutFrames + 1,
      incrementalRasterFrames: before.incrementalRasterFrames + 1,
    });
    expectDiagnosticSums(host);

    dispose();
    expect(host.frame).toEqual(host.render(true));
  });

  test("accounts a reentrant resize against the submitted cached frame before a full retry", () => {
    const surface = new RecordingSurface({ columns: 10, rows: 4 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const panel = host.ops.createNode(NODE.view);
    const text = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, panel, 0);
    host.ops.insertBefore(panel, text, 0);
    host.ops.setText(text, "resize");
    host.render();

    host.ops.setProp(text, PROP.width, 7);
    const beforePresent = host.diagnostics;
    let submittedFrame: CanvasFrame | undefined;
    surface.onPresent = (frame) => {
      submittedFrame = frame;
      surface.size = { columns: 12, rows: 7 };
      host.resize(12, 7);
    };
    const oldViewportFrame = host.render();

    expect(submittedFrame).toBe(oldViewportFrame);
    expect(oldViewportFrame).toMatchObject({ width: 10, height: 4 });
    expect(host.frame).toBe(oldViewportFrame);
    expect(host.viewportSize()).toEqual({ columns: 12, rows: 7 });
    expect(host.renderPending).toBe(true);
    expect(host.diagnostics).toMatchObject({
      renderedFrames: beforePresent.renderedFrames + 1,
      cachedLayoutFrames: beforePresent.cachedLayoutFrames + 1,
      fullRasterFrames: beforePresent.fullRasterFrames,
      incrementalRasterFrames: beforePresent.incrementalRasterFrames + 1,
      lastRepaintedRows: 1,
      repaintedRows: beforePresent.repaintedRows + 1,
    });
    expectDiagnosticSums(host);

    const beforeRetry = host.diagnostics;
    const resized = host.render();
    expect(resized).toMatchObject({ width: 12, height: 7 });
    expect(host.renderPending).toBe(false);
    expect(host.diagnostics).toMatchObject({
      renderedFrames: beforeRetry.renderedFrames + 1,
      layoutPasses: beforeRetry.layoutPasses + 1,
      fullRasterFrames: beforeRetry.fullRasterFrames + 1,
      lastRepaintedRows: 7,
      repaintedRows: beforeRetry.repaintedRows + 7,
    });
    expect(resized).toEqual(host.render(true));
    expectDiagnosticSums(host);
  });

  test("commits a detached paint mutation as an incremental zero-row frame", () => {
    const surface = new RecordingSurface({ columns: 8, rows: 3 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const detached = host.ops.createNode(NODE.view);
    host.render();
    const committed = host.frame;
    const before = host.diagnostics;

    host.ops.setProp(detached, PROP.bgColor, 0xff00_88ff);
    const zeroRow = host.render();
    expect(zeroRow).toBe(committed);
    expect(host.renderPending).toBe(false);
    expect(host.diagnostics).toMatchObject({
      renderedFrames: before.renderedFrames + 1,
      layoutPasses: before.layoutPasses,
      reusedLayoutFrames: before.reusedLayoutFrames + 1,
      fullRasterFrames: before.fullRasterFrames,
      incrementalRasterFrames: before.incrementalRasterFrames + 1,
      lastRepaintedRows: 0,
      repaintedRows: before.repaintedRows,
    });
    expectDiagnosticSums(host);
    expect(zeroRow).toEqual(host.render(true));
  });

  test("promotes a failed forced render from a clean scene into retryable full work", async () => {
    const surface = new RecordingSurface({ columns: 8, rows: 3 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const text = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, text, 0);
    host.ops.setText(text, "clean");
    host.render();
    await host.flush();

    let notifications = 0;
    const dispose = host.onWorkNeeded(() => {
      notifications += 1;
    });
    const beforeFailure = host.diagnostics;
    surface.failNextPresent = new Error("forced present failed");
    expect(() => host.render(true)).toThrow("forced present failed");

    expect(host.renderPending).toBe(true);
    expect(notifications).toBe(1);
    expect(host.diagnostics).toEqual(beforeFailure);
    const retry = host.render();
    expect(host.renderPending).toBe(false);
    expect(retry).toEqual(host.render(true));
    dispose();
  });

  test("refreshes paint order for z-index-only changes used by hit testing", () => {
    const surface = new RecordingSurface({ columns: 10, rows: 5 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const first = host.ops.createNode(NODE.view);
    const second = host.ops.createNode(NODE.view);
    host.ops.insertBefore(ROOT_ID, first, 0);
    host.ops.insertBefore(ROOT_ID, second, 0);
    absoluteRect(host, first, 1, 1, 5, 3);
    absoluteRect(host, second, 1, 1, 5, 3);
    host.ops.setProp(first, PROP.bgColor, 0xff00_00ff);
    host.ops.setProp(second, PROP.bgColor, 0xffff_0000);
    host.render();

    expect(host.ops.hitTest(2, 2)).toBe(second);
    const before = host.diagnostics;
    host.ops.setProp(first, PROP.zIndex, 10);
    const partial = host.render();
    expect(host.diagnostics.layoutPasses).toBe(before.layoutPasses);
    expect(host.diagnostics.incrementalRasterFrames).toBe(before.incrementalRasterFrames + 1);
    expect(host.ops.hitTest(2, 2)).toBe(first);

    const oracle = host.render(true);
    expect(partial).toEqual(oracle);
    expect(host.ops.hitTest(2, 2)).toBe(first);
  });
});

function complexScene(surface: RecordingSurface) {
  const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
  const panel = host.ops.createNode(NODE.view);
  const label = host.ops.createNode(NODE.text);
  const spill = host.ops.createNode(NODE.text);
  const overlay = host.ops.createNode(NODE.view);
  host.ops.insertBefore(ROOT_ID, panel, 0);
  host.ops.insertBefore(panel, label, 0);
  host.ops.insertBefore(panel, spill, 0);
  host.ops.insertBefore(ROOT_ID, overlay, 0);

  absoluteRect(host, panel, 1, 1, 12, 5);
  host.ops.setProp(panel, PROP.bgColor, 0xff18_1008);
  host.ops.setProp(panel, PROP.borderColor, 0xffff_8844);

  absoluteRect(host, label, 1, 1, 9, 2);
  host.ops.setText(label, "界A🙂B");
  host.ops.setProp(label, PROP.textColor, 0xffff_ff44);

  absoluteRect(host, spill, 10, 4, 6, 1);
  host.ops.setText(spill, "TAIL界");
  host.ops.setProp(spill, PROP.textColor, 0xff88_ffff);

  absoluteRect(host, overlay, 5, 2, 7, 3);
  host.ops.setProp(overlay, PROP.bgColor, 0xc0ff_2020);
  host.ops.setProp(overlay, PROP.borderColor, 0xff22_ff66);
  host.ops.setProp(overlay, PROP.borderWidth, 1);
  return { host, panel, label, spill, overlay };
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

function rectSnapshot(host: ReturnType<typeof createPocketTuiHost>) {
  return host.snapshot().map(({ id, rect }) => ({ id, rect }));
}

function assertFullInvalidation(
  host: ReturnType<typeof createPocketTuiHost>,
  mutate: () => void,
  repaintedRows: number,
): void {
  const before = host.diagnostics;
  mutate();
  expect(host.renderPending).toBe(true);
  host.render();
  const after = host.diagnostics;
  expect(after.layoutPasses).toBe(before.layoutPasses + 1);
  expect(after.fullLayoutFrames).toBe(before.fullLayoutFrames + 1);
  expect(after.localizedLayoutFrames).toBe(before.localizedLayoutFrames);
  expect(after.reusedLayoutFrames).toBe(before.reusedLayoutFrames);
  expect(after.fullRasterFrames).toBe(before.fullRasterFrames + 1);
  expect(after.incrementalRasterFrames).toBe(before.incrementalRasterFrames);
  expect(after.lastRepaintedRows).toBe(repaintedRows);
  expect(after.repaintedRows).toBe(before.repaintedRows + repaintedRows);
}

function assertCachedInvalidation(
  host: ReturnType<typeof createPocketTuiHost>,
  mutate: () => void,
): void {
  const before = host.diagnostics;
  mutate();
  expect(host.renderPending).toBe(true);
  const incremental = host.render();
  const after = host.diagnostics;
  expect(after).toMatchObject({
    layoutPasses: before.layoutPasses + 1,
    fullLayoutFrames: before.fullLayoutFrames,
    localizedLayoutFrames: before.localizedLayoutFrames,
    cachedLayoutFrames: before.cachedLayoutFrames + 1,
    fullRasterFrames: before.fullRasterFrames,
    incrementalRasterFrames: before.incrementalRasterFrames + 1,
  });
  expect(after.lastLayoutNodes).toBeGreaterThan(0);
  expect(after.lastMeasuredNodes).toBeGreaterThan(0);
  expect(incremental).toEqual(host.render(true));
  expectDiagnosticSums(host);
}

function assertLocalizedInvalidation(
  host: ReturnType<typeof createPocketTuiHost>,
  mutate: () => void,
  repaintedRows: number,
): void {
  const before = host.diagnostics;
  mutate();
  expect(host.renderPending).toBe(true);
  const incremental = host.render();
  const after = host.diagnostics;
  expect(after.layoutPasses).toBe(before.layoutPasses + 1);
  expect(after.fullLayoutFrames).toBe(before.fullLayoutFrames);
  expect(after.localizedLayoutFrames).toBe(before.localizedLayoutFrames + 1);
  expect(after.reusedLayoutFrames).toBe(before.reusedLayoutFrames);
  expect(after.fullRasterFrames).toBe(before.fullRasterFrames);
  expect(after.incrementalRasterFrames).toBe(before.incrementalRasterFrames + 1);
  expect(after.lastRepaintedRows).toBe(repaintedRows);
  expect(after.repaintedRows).toBe(before.repaintedRows + repaintedRows);
  expect(incremental).toEqual(host.render(true));
}

function expectDiagnosticSums(host: ReturnType<typeof createPocketTuiHost>): void {
  const diagnostics = host.diagnostics;
  expect(diagnostics.renderedFrames).toBe(
    diagnostics.fullLayoutFrames +
      diagnostics.localizedLayoutFrames +
      diagnostics.cachedLayoutFrames +
      diagnostics.reusedLayoutFrames,
  );
  expect(diagnostics.layoutPasses).toBe(
    diagnostics.fullLayoutFrames +
      diagnostics.localizedLayoutFrames +
      diagnostics.cachedLayoutFrames,
  );
  expect(diagnostics.renderedFrames).toBe(
    diagnostics.fullRasterFrames + diagnostics.incrementalRasterFrames,
  );
  expect(diagnostics.fullLayoutFrames).toBe(diagnostics.fullRasterFrames);
  expect(diagnostics.incrementalRasterFrames).toBe(
    diagnostics.localizedLayoutFrames +
      diagnostics.cachedLayoutFrames +
      diagnostics.reusedLayoutFrames,
  );
}

function styleTable(): Uint8Array {
  const bytes = new Uint8Array(STYLE_HEADER_BYTES + 1 + 3 * 7);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, STYLE_MAGIC, true);
  view.setUint16(4, STYLE_VERSION, true);
  view.setUint16(6, 1, true);
  let offset = STYLE_HEADER_BYTES;
  bytes[offset++] = STYLE_BASE | STYLE_FOCUS | STYLE_ACTIVE;
  for (const color of [0xffff_ffff, 0xff00_ff00, 0xffff_8800]) {
    bytes[offset++] = 1;
    bytes[offset++] = PROP.textColor;
    bytes[offset++] = 0;
    view.setUint32(offset, color, true);
    offset += 4;
  }
  return bytes;
}
