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

  constructor(public size: TuiViewportSize = { columns: 30, rows: 12 }) {}

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

describe("PocketJS retained paint-index Host integration", () => {
  test("accounts full, incremental, and semantic-reuse index frames independently", () => {
    const surface = new RecordingSurface({ columns: 14, rows: 6 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const panel = view(host, ROOT_ID);
    size(host, panel, 8, 3);
    host.ops.setProp(panel, PROP.bgColor, 0xff20_3040);

    host.render();
    expect(host.diagnostics).toMatchObject({
      fullPaintIndexFrames: 1,
      incrementalPaintIndexFrames: 0,
      reusedPaintIndexFrames: 0,
      lastPaintIndexNodes: 2,
      lastPaintIndexRoots: 1,
      lastRasterCandidates: 1,
    });

    const beforePaint = host.diagnostics;
    host.ops.setProp(panel, PROP.bgColor, 0xff40_3020);
    host.render();
    expect(host.diagnostics).toMatchObject({
      fullPaintIndexFrames: beforePaint.fullPaintIndexFrames,
      incrementalPaintIndexFrames: beforePaint.incrementalPaintIndexFrames + 1,
      reusedPaintIndexFrames: beforePaint.reusedPaintIndexFrames,
      lastPaintIndexNodes: 1,
      lastPaintIndexRoots: 1,
      lastRasterCandidates: 1,
    });

    // Gap affects layout semantics, but on a childless fixed-size view it
    // changes neither geometry nor any retained paint record.
    const beforeReuse = host.diagnostics;
    host.ops.setProp(panel, PROP.gap, 2);
    const reused = host.render();
    expect(reused).toBe(host.frame);
    expect(host.diagnostics).toMatchObject({
      fullPaintIndexFrames: beforeReuse.fullPaintIndexFrames,
      incrementalPaintIndexFrames: beforeReuse.incrementalPaintIndexFrames,
      reusedPaintIndexFrames: beforeReuse.reusedPaintIndexFrames + 1,
      lastPaintIndexNodes: 0,
      lastPaintIndexRoots: 0,
      lastRasterCandidates: 0,
    });

    const beforeForce = host.diagnostics;
    host.render(true);
    expect(host.diagnostics).toMatchObject({
      fullPaintIndexFrames: beforeForce.fullPaintIndexFrames + 1,
      incrementalPaintIndexFrames: beforeForce.incrementalPaintIndexFrames,
      reusedPaintIndexFrames: beforeForce.reusedPaintIndexFrames,
      lastPaintIndexNodes: 2,
      lastPaintIndexRoots: 1,
    });
    expectPaintIndexDiagnosticSums(host);
  });

  test("patches z-order, clipping, and inherited opacity with exact hit-test semantics", () => {
    const incrementalSurface = new RecordingSurface({ columns: 16, rows: 9 });
    const oracleSurface = new RecordingSurface(incrementalSurface.size);
    const incremental = createPocketTuiHost({
      surface: incrementalSurface,
      colorMode: "truecolor",
    });
    const oracle = createPocketTuiHost({ surface: oracleSurface, colorMode: "truecolor" });
    const scene = overlapScene(incremental);
    const oracleScene = overlapScene(oracle);
    incremental.render();
    oracle.render(true);

    expect(incremental.ops.hitTest(4, 3)).toBe(scene.second);
    const beforeZ = incremental.diagnostics;
    setBoth(incremental, oracle, scene.first, oracleScene.first, PROP.zIndex, 7);
    expectIncrementalOracle(incremental, oracle, incrementalSurface.size);
    expect(incremental.ops.hitTest(4, 3)).toBe(scene.first);
    expect(incremental.diagnostics).toMatchObject({
      fullPaintIndexFrames: beforeZ.fullPaintIndexFrames,
      incrementalPaintIndexFrames: beforeZ.incrementalPaintIndexFrames + 1,
      lastPaintIndexRoots: 1,
      lastPaintIndexNodes: 4,
    });

    // The spill intersects the panel but extends below it. Retained hit tests
    // deliberately preserve the existing raw-rect behavior outside the clip.
    expect(incremental.ops.hitTest(9, 7)).toBe(scene.spill);
    setBoth(
      incremental,
      oracle,
      scene.panel,
      oracleScene.panel,
      PROP.overflow,
      ENUM.overflowHidden,
    );
    expectIncrementalOracle(incremental, oracle, incrementalSurface.size);
    expect(incremental.ops.hitTest(9, 7)).toBe(scene.spill);

    setBoth(incremental, oracle, scene.panel, oracleScene.panel, PROP.opacity, 0);
    expectIncrementalOracle(incremental, oracle, incrementalSurface.size);
    expect(incremental.ops.hitTest(4, 3)).toBe(0);
    expect(incremental.ops.hitTest(9, 7)).toBe(0);
    expect(incremental.diagnostics.fullPaintIndexFrames).toBe(1);
    expect(incremental.diagnostics.incrementalPaintIndexFrames).toBe(3);
    expectPaintIndexDiagnosticSums(incremental);
  });

  test("commits an index only after present and retains reentrant z-order work", () => {
    const surface = new RecordingSurface({ columns: 14, rows: 7 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const scene = overlapScene(host);
    host.render();
    expect(host.ops.hitTest(4, 3)).toBe(scene.second);

    host.ops.setProp(scene.first, PROP.zIndex, 10);
    const committedFrame = host.frame;
    const beforeFailure = host.diagnostics;
    surface.failNextPresent = new Error("paint index present failed");
    expect(() => host.render()).toThrow("paint index present failed");

    expect(host.frame).toBe(committedFrame);
    expect(host.diagnostics).toEqual(beforeFailure);
    expect(host.ops.hitTest(4, 3)).toBe(scene.second);
    expect(host.renderPending).toBe(true);

    host.render();
    expect(host.ops.hitTest(4, 3)).toBe(scene.first);
    expect(host.renderPending).toBe(false);

    host.ops.setProp(scene.second, PROP.zIndex, 20);
    surface.onPresent = () => host.ops.setProp(scene.first, PROP.zIndex, 30);
    const beforeFirst = host.diagnostics;
    host.render();

    expect(host.ops.hitTest(4, 3)).toBe(scene.second);
    expect(host.renderPending).toBe(true);
    expect(host.diagnostics.incrementalPaintIndexFrames).toBe(
      beforeFirst.incrementalPaintIndexFrames + 1,
    );

    const beforeSecond = host.diagnostics;
    const second = host.render();
    expect(host.ops.hitTest(4, 3)).toBe(scene.first);
    expect(host.renderPending).toBe(false);
    expect(host.diagnostics.incrementalPaintIndexFrames).toBe(
      beforeSecond.incrementalPaintIndexFrames + 1,
    );
    const hits = hitTestGrid(host, surface.size);
    expect(second).toEqual(host.render(true));
    expect(hitTestGrid(host, surface.size)).toEqual(hits);
    expectPaintIndexDiagnosticSums(host);
  });

  test("matches an independent force-only Host across retained mixed mutations", () => {
    const size = { columns: 30, rows: 12 };
    const incrementalSurface = new RecordingSurface(size);
    const oracleSurface = new RecordingSurface(size);
    const incremental = createPocketTuiHost({
      surface: incrementalSurface,
      colorMode: "truecolor",
    });
    const oracle = createPocketTuiHost({ surface: oracleSurface, colorMode: "truecolor" });
    const scene = randomizedScene(incremental);
    const oracleScene = randomizedScene(oracle);
    expect(scene.all).toEqual(oracleScene.all);
    incremental.render();
    oracle.render(true);

    let random = 0x51a7_cafe;
    const next = (): number => {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      return random;
    };
    const displays = scene.overlays.map(() => ENUM.displayFlex);
    const opacities = scene.overlays.map(() => 1);
    let overflow = ENUM.overflowVisible;
    let direction = ENUM.flexRow;

    for (let step = 0; step < 96; step += 1) {
      const kind = next() % 12;
      if (kind === 0) {
        const index = next() % scene.labels.length;
        const value = `step-${step}-${next() % 97}-界`;
        incremental.ops.setText(scene.labels[index]!, value);
        oracle.ops.setText(oracleScene.labels[index]!, value);
      } else if (kind === 1) {
        const index = next() % scene.labels.length;
        setBoth(
          incremental,
          oracle,
          scene.labels[index]!,
          oracleScene.labels[index]!,
          PROP.width,
          5 + (next() % 7),
        );
      } else if (kind === 2) {
        const index = next() % scene.panels.length;
        setBoth(
          incremental,
          oracle,
          scene.panels[index]!,
          oracleScene.panels[index]!,
          PROP.gap,
          next() % 3,
        );
      } else if (kind === 3) {
        const index = next() % scene.overlays.length;
        setBoth(
          incremental,
          oracle,
          scene.overlays[index]!,
          oracleScene.overlays[index]!,
          PROP.bgColor,
          0xff00_0000 + (next() & 0x00ff_ffff),
        );
      } else if (kind === 4) {
        const index = next() % scene.overlays.length;
        const values = [0, 0.35, 0.7, 1] as const;
        opacities[index] = values[next() % values.length]!;
        setBoth(
          incremental,
          oracle,
          scene.overlays[index]!,
          oracleScene.overlays[index]!,
          PROP.opacity,
          opacities[index]!,
        );
      } else if (kind === 5) {
        overflow = overflow === ENUM.overflowVisible ? ENUM.overflowHidden : ENUM.overflowVisible;
        setBoth(
          incremental,
          oracle,
          scene.panels[0]!,
          oracleScene.panels[0]!,
          PROP.overflow,
          overflow,
        );
      } else if (kind === 6) {
        const index = next() % scene.overlays.length;
        setBoth(
          incremental,
          oracle,
          scene.overlays[index]!,
          oracleScene.overlays[index]!,
          PROP.zIndex,
          (next() % 7) - 3,
        );
      } else if (kind === 7) {
        const index = next() % scene.overlays.length;
        displays[index] =
          displays[index] === ENUM.displayFlex ? ENUM.displayNone : ENUM.displayFlex;
        setBoth(
          incremental,
          oracle,
          scene.overlays[index]!,
          oracleScene.overlays[index]!,
          PROP.display,
          displays[index]!,
        );
      } else if (kind === 8) {
        const index = next() % scene.overlays.length;
        setBoth(
          incremental,
          oracle,
          scene.overlays[index]!,
          oracleScene.overlays[index]!,
          PROP.insetL,
          next() % 8,
        );
      } else if (kind === 9) {
        direction = direction === ENUM.flexRow ? ENUM.flexColumn : ENUM.flexRow;
        setBoth(
          incremental,
          oracle,
          scene.shell,
          oracleScene.shell,
          PROP.flexDir,
          direction,
        );
      } else if (kind === 10) {
        const index = next() % scene.labels.length;
        setBoth(
          incremental,
          oracle,
          scene.labels[index]!,
          oracleScene.labels[index]!,
          PROP.tracking,
          next() % 3,
        );
      } else {
        const index = next() % scene.panels.length;
        const width = next() % 2;
        setBoth(
          incremental,
          oracle,
          scene.panels[index]!,
          oracleScene.panels[index]!,
          PROP.borderWidth,
          width,
        );
        setBoth(
          incremental,
          oracle,
          scene.panels[index]!,
          oracleScene.panels[index]!,
          PROP.borderColor,
          width === 0 ? 0 : 0xff80_d0ff,
        );
      }

      const frame = incremental.render();
      const oracleFrame = oracle.render(true);
      expect({ step, frame }).toEqual({ step, frame: oracleFrame });
      expect({ step, geometry: geometrySnapshot(incremental) }).toEqual({
        step,
        geometry: geometrySnapshot(oracle),
      });
      expect({ step, hits: hitTestGrid(incremental, size) }).toEqual({
        step,
        hits: hitTestGrid(oracle, size),
      });
    }

    expect(incremental.diagnostics.fullPaintIndexFrames).toBe(1);
    expect(incremental.diagnostics.incrementalPaintIndexFrames).toBeGreaterThan(0);
    expect(incremental.diagnostics.reusedPaintIndexFrames).toBeGreaterThan(0);
    expectPaintIndexDiagnosticSums(incremental);
  });
});

function overlapScene(host: ReturnType<typeof createPocketTuiHost>) {
  const panel = view(host, ROOT_ID);
  absoluteRect(host, panel, 1, 1, 11, 5);
  host.ops.setProp(panel, PROP.bgColor, 0xff18_1008);
  host.ops.setProp(panel, PROP.overflow, ENUM.overflowVisible);

  const first = view(host, panel);
  const second = view(host, panel);
  absoluteRect(host, first, 1, 1, 5, 3);
  absoluteRect(host, second, 1, 1, 5, 3);
  host.ops.setProp(first, PROP.bgColor, 0xff20_60ff);
  host.ops.setProp(second, PROP.bgColor, 0xffff_4020);

  const spill = host.ops.createNode(NODE.text);
  host.ops.insertBefore(panel, spill, 0);
  absoluteRect(host, spill, 7, 4, 4, 3);
  host.ops.setText(spill, "SPILL");
  host.ops.setProp(spill, PROP.textColor, 0xff80_ffff);
  return { panel, first, second, spill };
}

function randomizedScene(host: ReturnType<typeof createPocketTuiHost>) {
  const shell = view(host, ROOT_ID);
  size(host, shell, 28, 10);
  host.ops.setProp(shell, PROP.flexDir, ENUM.flexRow);
  host.ops.setProp(shell, PROP.gap, 1);

  const panels = [view(host, shell), view(host, shell)];
  for (const [index, panel] of panels.entries()) {
    size(host, panel, 13, 9);
    host.ops.setProp(panel, PROP.bgColor, index === 0 ? 0xff18_2430 : 0xff30_2018);
    host.ops.setProp(panel, PROP.overflow, ENUM.overflowVisible);
    host.ops.setProp(panel, PROP.gap, 1);
  }

  const labels = [
    text(host, panels[0]!, "alpha界"),
    text(host, panels[0]!, "beta"),
    text(host, panels[1]!, "gamma🙂"),
  ];
  for (const label of labels) size(host, label, 9, 2);

  const spill = text(host, panels[0]!, "tail界");
  absoluteRect(host, spill, 9, 7, 6, 2);

  const overlays = [view(host, panels[1]!), view(host, panels[1]!)];
  for (const [index, overlay] of overlays.entries()) {
    absoluteRect(host, overlay, 2, 3, 7, 3);
    host.ops.setProp(overlay, PROP.bgColor, index === 0 ? 0xc0ff_2040 : 0xc040_80ff);
    host.ops.setProp(overlay, PROP.zIndex, index);
  }
  return {
    shell,
    panels,
    labels,
    spill,
    overlays,
    all: [shell, ...panels, ...labels, spill, ...overlays],
  };
}

function expectIncrementalOracle(
  incremental: ReturnType<typeof createPocketTuiHost>,
  oracle: ReturnType<typeof createPocketTuiHost>,
  size: TuiViewportSize,
): void {
  const frame = incremental.render();
  const oracleFrame = oracle.render(true);
  expect(frame).toEqual(oracleFrame);
  expect(geometrySnapshot(incremental)).toEqual(geometrySnapshot(oracle));
  expect(hitTestGrid(incremental, size)).toEqual(hitTestGrid(oracle, size));
}

function setBoth(
  left: ReturnType<typeof createPocketTuiHost>,
  right: ReturnType<typeof createPocketTuiHost>,
  leftId: number,
  rightId: number,
  property: number,
  value: number,
): void {
  left.ops.setProp(leftId, property, value);
  right.ops.setProp(rightId, property, value);
}

function view(host: ReturnType<typeof createPocketTuiHost>, parent: number): number {
  const id = host.ops.createNode(NODE.view);
  host.ops.insertBefore(parent, id, 0);
  return id;
}

function text(
  host: ReturnType<typeof createPocketTuiHost>,
  parent: number,
  value: string,
): number {
  const id = host.ops.createNode(NODE.text);
  host.ops.insertBefore(parent, id, 0);
  host.ops.setText(id, value);
  return id;
}

function size(
  host: ReturnType<typeof createPocketTuiHost>,
  id: number,
  width: number,
  height: number,
): void {
  host.ops.setProp(id, PROP.width, width);
  host.ops.setProp(id, PROP.height, height);
}

function absoluteRect(
  host: ReturnType<typeof createPocketTuiHost>,
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  host.ops.setProp(id, PROP.posType, ENUM.absolute);
  host.ops.setProp(id, PROP.insetL, x);
  host.ops.setProp(id, PROP.insetT, y);
  size(host, id, width, height);
}

function geometrySnapshot(host: ReturnType<typeof createPocketTuiHost>) {
  return host
    .snapshot()
    .map(({ id, rect }) => ({ id, rect: rect === undefined ? undefined : { ...rect } }))
    .sort((left, right) => left.id - right.id);
}

function hitTestGrid(
  host: ReturnType<typeof createPocketTuiHost>,
  size: TuiViewportSize,
): number[] {
  const result: number[] = [];
  for (let y = 0; y < size.rows; y += 1) {
    for (let x = 0; x < size.columns; x += 1) result.push(host.ops.hitTest(x, y));
  }
  return result;
}

function expectPaintIndexDiagnosticSums(
  host: ReturnType<typeof createPocketTuiHost>,
): void {
  const diagnostics = host.diagnostics;
  expect(diagnostics.renderedFrames).toBe(
    diagnostics.fullPaintIndexFrames +
      diagnostics.incrementalPaintIndexFrames +
      diagnostics.reusedPaintIndexFrames,
  );
  expect(diagnostics.paintIndexNodes).toBeGreaterThanOrEqual(diagnostics.lastPaintIndexNodes);
  expect(diagnostics.rasterCandidates).toBeGreaterThanOrEqual(
    diagnostics.lastRasterCandidates,
  );
}
