// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import type {
  CanvasFrame,
  CursorPacketOptions,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import { createPocketTuiHost, type PocketTuiSurface } from "../src/index.js";
import { ENUM, NODE, PROP, ROOT_ID, SIZE_FULL } from "../src/spec.js";

class RecordingSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  failNextPresent: Error | undefined;
  onPresent: ((frame: CanvasFrame) => void) | undefined;

  constructor(public size: TuiViewportSize = { columns: 34, rows: 12 }) {}

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

describe("PocketJS cached Flex layout", () => {
  test("reflows nested row/column Flex from intrinsic text and translates clean siblings", () => {
    const surface = new RecordingSurface();
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const shell = view(host, ROOT_ID);
    size(host, shell, 32, 10);
    host.ops.setProp(shell, PROP.paddingL, 1);
    host.ops.setProp(shell, PROP.paddingR, 1);
    host.ops.setProp(shell, PROP.paddingT, 1);
    host.ops.setProp(shell, PROP.gap, 1);

    const row = view(host, shell);
    host.ops.setProp(row, PROP.flexDir, ENUM.flexRow);
    host.ops.setProp(row, PROP.align, ENUM.alignStart);
    host.ops.setProp(row, PROP.height, 3);
    host.ops.setProp(row, PROP.gap, 1);
    const left = view(host, row);
    const leftLabel = text(host, left, "A");
    text(host, left, "left-tail");
    const right = view(host, row);
    const rightLabel = text(host, right, "stable");
    text(host, right, "right-tail");
    const footer = text(host, shell, "footer stays put");

    host.render();
    const beforeRight = requiredRect(host, right);
    const beforeRightLabel = requiredRect(host, rightLabel);
    const beforeFooter = requiredRect(host, footer);

    assertCachedOracle(host, surface, () => host.ops.setText(leftLabel, "alphabet界🙂"), () => {
      const afterRight = requiredRect(host, right);
      const afterRightLabel = requiredRect(host, rightLabel);
      expect(afterRight.x).toBeGreaterThan(beforeRight.x);
      expect(afterRight.x - beforeRight.x).toBe(afterRightLabel.x - beforeRightLabel.x);
      expect(requiredRect(host, footer)).toEqual(beforeFooter);
      expect(host.diagnostics.lastReusedLayoutNodes).toBeGreaterThanOrEqual(3);
      expect(host.diagnostics.lastLayoutNodes).toBeLessThan(host.diagnostics.liveNodes);
    });
  });

  test("keeps Flex geometry mutations on the cached root solver", () => {
    const surface = new RecordingSurface({ columns: 36, rows: 10 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const row = view(host, ROOT_ID);
    size(host, row, 34, 8);
    host.ops.setProp(row, PROP.flexDir, ENUM.flexRow);
    host.ops.setProp(row, PROP.align, ENUM.alignStart);
    host.ops.setProp(row, PROP.paddingL, 1);
    host.ops.setProp(row, PROP.paddingR, 1);
    host.ops.setProp(row, PROP.paddingT, 1);
    host.ops.setProp(row, PROP.gap, 1);

    const first = labeledPanel(host, row, "first");
    const second = labeledPanel(host, row, "second");
    const third = labeledPanel(host, row, "third");
    for (const panel of [first.panel, second.panel, third.panel]) {
      host.ops.setProp(panel, PROP.basis, 5);
      host.ops.setProp(panel, PROP.grow, 1);
    }
    host.render();

    const mutations = [
      ["grow", () => host.ops.setProp(first.panel, PROP.grow, 3)],
      ["basis", () => host.ops.setProp(second.panel, PROP.basis, 9)],
      [
        "shrink",
        () => {
          host.ops.setProp(row, PROP.width, 17);
          host.ops.setProp(third.panel, PROP.shrink, 0);
        },
      ],
      ["padding", () => host.ops.setProp(row, PROP.paddingL, 2)],
      ["gap", () => host.ops.setProp(row, PROP.gap, 2)],
      ["display:none", () => host.ops.setProp(second.panel, PROP.display, ENUM.displayNone)],
      ["display:flex", () => host.ops.setProp(second.panel, PROP.display, ENUM.displayFlex)],
      [
        "relative:absolute",
        () => {
          host.ops.setProp(third.panel, PROP.posType, ENUM.absolute);
          host.ops.setProp(third.panel, PROP.insetL, 4);
          host.ops.setProp(third.panel, PROP.insetT, 4);
        },
      ],
      [
        "absolute:relative",
        () => host.ops.setProp(third.panel, PROP.posType, ENUM.relative),
      ],
    ] as const;

    for (const [property, mutate] of mutations) {
      assertCachedOracle(host, surface, mutate, () => {
        expect(host.diagnostics.lastMeasuredNodes, property).toBeGreaterThan(0);
      });
    }
  });

  test("invalidates a hidden descendant measurement before its parent is shown", () => {
    const cachedSurface = new RecordingSurface({ columns: 28, rows: 8 });
    const oracleSurface = new RecordingSurface(cachedSurface.size);
    const cached = hiddenScene(cachedSurface);
    const oracle = hiddenScene(oracleSurface);
    cached.host.render();
    oracle.host.render(true);

    setBoth(cached.host, oracle.host, cached.hidden, oracle.hidden, PROP.display, ENUM.displayNone);
    assertTwinRender(cached, oracle, cachedSurface, oracleSurface);
    const hiddenSiblingX = requiredRect(cached.host, cached.sibling).x;
    expect(cached.host.nodeRect(cached.hiddenLabel)).toBeUndefined();

    cached.host.ops.setText(cached.hiddenLabel, "new value 界🙂");
    oracle.host.ops.setText(oracle.hiddenLabel, "new value 界🙂");
    setBoth(cached.host, oracle.host, cached.middle, oracle.middle, PROP.width, 15);
    assertTwinRender(cached, oracle, cachedSurface, oracleSurface);
    expect(cached.host.nodeRect(cached.hiddenLabel)).toBeUndefined();
    expect(requiredRect(cached.host, cached.sibling).x).toBe(hiddenSiblingX);

    setBoth(cached.host, oracle.host, cached.hidden, oracle.hidden, PROP.display, ENUM.displayFlex);
    assertTwinRender(cached, oracle, cachedSurface, oracleSurface);
    expect(requiredRect(cached.host, cached.hiddenLabel).width).toBeGreaterThan(3);
    expect(requiredRect(cached.host, cached.sibling).x).toBeGreaterThan(hiddenSiblingX);
  });

  test("keys measurement reuse by the exact available width and height", () => {
    const cachedSurface = new RecordingSurface({ columns: 24, rows: 9 });
    const oracleSurface = new RecordingSurface(cachedSurface.size);
    const cached = constraintScene(cachedSurface);
    const oracle = constraintScene(oracleSurface);
    cached.host.render();
    oracle.host.render(true);

    const wide = requiredRect(cached.host, cached.label);
    setBoth(cached.host, oracle.host, cached.blocker, oracle.blocker, PROP.basis, 12);
    assertTwinRender(cached, oracle, cachedSurface, oracleSurface);
    const narrow = requiredRect(cached.host, cached.label);
    expect(narrow.width).toBeLessThan(wide.width);
    expect(cached.host.diagnostics.lastMeasuredNodes).toBeGreaterThan(0);

    setBoth(cached.host, oracle.host, cached.blocker, oracle.blocker, PROP.basis, 4);
    assertTwinRender(cached, oracle, cachedSurface, oracleSurface);
    expect(requiredRect(cached.host, cached.label).width).toBeGreaterThan(narrow.width);

    setBoth(cached.host, oracle.host, cached.wrapping, oracle.wrapping, PROP.grow, 0);
    setBoth(cached.host, oracle.host, cached.wrapping, oracle.wrapping, PROP.maxW, 8);
    assertTwinRender(cached, oracle, cachedSurface, oracleSurface);
    expect(requiredRect(cached.host, cached.wrapping).width).toBeLessThanOrEqual(8);

    setBoth(cached.host, oracle.host, cached.row, oracle.row, PROP.height, 4);
    assertTwinRender(cached, oracle, cachedSurface, oracleSurface);
  });

  test("repaints a fixed text rect when line height changes without moving it", () => {
    const surface = new RecordingSurface({ columns: 20, rows: 7 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const row = view(host, ROOT_ID);
    size(host, row, 18, 5);
    host.ops.setProp(row, PROP.flexDir, ENUM.flexRow);
    const label = text(host, row, "one two three four");
    size(host, label, 8, 4);
    text(host, row, "tail");
    host.render();
    const rect = requiredRect(host, label);

    assertCachedOracle(host, surface, () => host.ops.setProp(label, PROP.lineHeight, 2), () => {
      expect(requiredRect(host, label)).toEqual(rect);
      expect(host.diagnostics.lastRepaintedRows).toBeGreaterThan(0);
    });
  });

  test("refreshes paint inside a reused subtree during same-frame Flex reflow", () => {
    const surface = new RecordingSurface({ columns: 30, rows: 8 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const row = view(host, ROOT_ID);
    size(host, row, 28, 6);
    host.ops.setProp(row, PROP.flexDir, ENUM.flexRow);
    host.ops.setProp(row, PROP.align, ENUM.alignStart);
    host.ops.setProp(row, PROP.gap, 1);
    const changing = text(host, row, "x");
    const stable = view(host, row);
    const stableLabel = text(host, stable, "paint me");
    host.ops.setProp(stable, PROP.bgColor, 0xff20_2020);
    host.render();

    const before = requiredRect(host, stable);
    assertCachedOracle(
      host,
      surface,
      () => {
        host.ops.setText(changing, "a much wider 界 value");
        host.ops.setProp(stableLabel, PROP.textColor, 0xffff_8844);
        host.ops.setProp(stable, PROP.bgColor, 0xff20_4060);
      },
      () => {
        expect(requiredRect(host, stable).x).toBeGreaterThan(before.x);
        expect(host.diagnostics.incrementalRasterFrames).toBeGreaterThan(0);
      },
    );
    assertCachedOracle(
      host,
      surface,
      () => {
        host.ops.setProp(stableLabel, PROP.textColor, 0xff55_ff99);
        host.ops.setProp(stable, PROP.bgColor, 0xff40_2040);
        host.ops.setText(changing, "short again");
      },
      () => expect(host.diagnostics.lastMeasuredNodes).toBeGreaterThan(0),
    );
  });

  test("commits cached layout only after present and retries failed work exactly", () => {
    const surface = new RecordingSurface({ columns: 26, rows: 8 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const row = view(host, ROOT_ID);
    size(host, row, 24, 6);
    host.ops.setProp(row, PROP.flexDir, ENUM.flexRow);
    host.ops.setProp(row, PROP.align, ENUM.alignStart);
    const changing = text(host, row, "short");
    text(host, row, "stable");
    host.render();

    const committedFrame = host.frame;
    const committedGeometry = geometrySnapshot(host);
    host.ops.setText(changing, "long enough to reflow");
    const beforeFailure = host.diagnostics;
    surface.failNextPresent = new Error("cached present failed");
    expect(() => host.render()).toThrow("cached present failed");
    expect(host.frame).toBe(committedFrame);
    expect(geometrySnapshot(host)).toEqual(committedGeometry);
    expect(host.diagnostics).toEqual(beforeFailure);
    expect(host.renderPending).toBe(true);

    const retry = host.render();
    expect(host.renderPending).toBe(false);
    expect(host.diagnostics).toMatchObject({
      cachedLayoutFrames: beforeFailure.cachedLayoutFrames + 1,
      fullLayoutFrames: beforeFailure.fullLayoutFrames,
    });
    const geometry = geometrySnapshot(host);
    const hits = hitTestGrid(host, surface.size);
    const oracle = host.render(true);
    expect(retry).toEqual(oracle);
    expect(geometrySnapshot(host)).toEqual(geometry);
    expect(hitTestGrid(host, surface.size)).toEqual(hits);
  });

  test("retains a second Flex mutation created reentrantly during present", () => {
    const surface = new RecordingSurface({ columns: 28, rows: 8 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const row = view(host, ROOT_ID);
    size(host, row, 26, 6);
    host.ops.setProp(row, PROP.flexDir, ENUM.flexRow);
    host.ops.setProp(row, PROP.align, ENUM.alignStart);
    const changing = text(host, row, "x");
    const sibling = text(host, row, "tail");
    host.render();

    host.ops.setText(changing, "first");
    surface.onPresent = () => host.ops.setText(changing, "second mutation is wider");
    const beforeFirst = host.diagnostics;
    host.render();
    const firstSiblingX = requiredRect(host, sibling).x;
    expect(host.renderPending).toBe(true);
    expect(host.diagnostics.cachedLayoutFrames).toBe(beforeFirst.cachedLayoutFrames + 1);

    const beforeSecond = host.diagnostics;
    const second = host.render();
    expect(host.renderPending).toBe(false);
    expect(requiredRect(host, sibling).x).toBeGreaterThan(firstSiblingX);
    expect(host.diagnostics.cachedLayoutFrames).toBe(beforeSecond.cachedLayoutFrames + 1);
    const geometry = geometrySnapshot(host);
    const hits = hitTestGrid(host, surface.size);
    expect(second).toEqual(host.render(true));
    expect(geometrySnapshot(host)).toEqual(geometry);
    expect(hitTestGrid(host, surface.size)).toEqual(hits);
  });

  test("matches the full frame, every rect, and every hit across mixed nested Flex mutations", () => {
    const surface = new RecordingSurface({ columns: 30, rows: 12 });
    const oracleSurface = new RecordingSurface(surface.size);
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const fullHost = createPocketTuiHost({ surface: oracleSurface, colorMode: "truecolor" });
    const scene = oracleScene(host);
    const fullScene = oracleScene(fullHost);
    host.render();
    fullHost.render(true);
    let random = 0x71e5_cafe;
    const next = (): number => {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      return random;
    };
    const directions = [...scene.directions];
    const displays = scene.leaves.map(() => ENUM.displayFlex);
    const positions = scene.containers.map(() => ENUM.relative);

    for (let step = 0; step < 96; step += 1) {
      const kind = next() % 8;
      if (kind === 0) {
        const index = next() % scene.leaves.length;
        const value = `step-${step}-${next() % 100}-界`;
        host.ops.setText(scene.leaves[index]!, value);
        fullHost.ops.setText(fullScene.leaves[index]!, value);
      } else if (kind === 1) {
        const index = next() % scene.containers.length;
        const value = next() % 3;
        setBoth(host, fullHost, scene.containers[index]!, fullScene.containers[index]!, PROP.paddingL, value);
      } else if (kind === 2) {
        const index = next() % scene.containers.length;
        const value = next() % 3;
        setBoth(host, fullHost, scene.containers[index]!, fullScene.containers[index]!, PROP.gap, value);
      } else if (kind === 3) {
        const index = next() % scene.containers.length;
        const direction = directions[index] === ENUM.flexRow ? ENUM.flexColumn : ENUM.flexRow;
        directions[index] = direction;
        setBoth(host, fullHost, scene.containers[index]!, fullScene.containers[index]!, PROP.flexDir, direction);
      } else if (kind === 4) {
        const index = 1 + (next() % (scene.containers.length - 1));
        const value = 1 + (next() % 3);
        setBoth(host, fullHost, scene.containers[index]!, fullScene.containers[index]!, PROP.grow, value);
      } else if (kind === 5) {
        const index = 1 + (next() % (scene.containers.length - 1));
        const value = 1 + (next() % 7);
        setBoth(host, fullHost, scene.containers[index]!, fullScene.containers[index]!, PROP.basis, value);
      } else if (kind === 6) {
        const index = next() % scene.leaves.length;
        const display = displays[index] === ENUM.displayNone ? ENUM.displayFlex : ENUM.displayNone;
        displays[index] = display;
        setBoth(host, fullHost, scene.leaves[index]!, fullScene.leaves[index]!, PROP.display, display);
      } else {
        const index = 1 + (next() % (scene.containers.length - 1));
        const position = positions[index] === ENUM.absolute ? ENUM.relative : ENUM.absolute;
        positions[index] = position;
        setBoth(host, fullHost, scene.containers[index]!, fullScene.containers[index]!, PROP.posType, position);
        if (position === ENUM.absolute) {
          const left = next() % 8;
          const top = next() % 5;
          setBoth(host, fullHost, scene.containers[index]!, fullScene.containers[index]!, PROP.insetL, left);
          setBoth(host, fullHost, scene.containers[index]!, fullScene.containers[index]!, PROP.insetT, top);
        }
      }

      const before = host.diagnostics;
      const cached = host.render();
      const after = host.diagnostics;
      const geometry = geometrySnapshot(host);
      const hits = hitTestGrid(host, surface.size);
      expect({ step, full: after.fullLayoutFrames }).toEqual({
        step,
        full: before.fullLayoutFrames,
      });
      expect(
        after.cachedLayoutFrames + after.localizedLayoutFrames,
        `incremental frame ${step}`,
      ).toBe(before.cachedLayoutFrames + before.localizedLayoutFrames + 1);
      expect(after.lastLayoutNodes).toBeGreaterThan(0);

      const oracle = fullHost.render(true);
      expect({ step, cached }).toEqual({ step, cached: oracle });
      expect(geometrySnapshot(fullHost)).toEqual(geometry);
      expect(hitTestGrid(fullHost, oracleSurface.size)).toEqual(hits);
      expectDiagnosticSums(host);
    }
  });
});

function assertCachedOracle(
  host: ReturnType<typeof createPocketTuiHost>,
  surface: RecordingSurface,
  mutate: () => void,
  inspect?: () => void,
): void {
  const before = host.diagnostics;
  mutate();
  expect(host.renderPending).toBe(true);
  const cached = host.render();
  const after = host.diagnostics;
  const geometry = geometrySnapshot(host);
  const hits = hitTestGrid(host, surface.size);

  expect(after).toMatchObject({
    renderedFrames: before.renderedFrames + 1,
    layoutPasses: before.layoutPasses + 1,
    fullLayoutFrames: before.fullLayoutFrames,
    localizedLayoutFrames: before.localizedLayoutFrames,
    cachedLayoutFrames: before.cachedLayoutFrames + 1,
    reusedLayoutFrames: before.reusedLayoutFrames,
    fullRasterFrames: before.fullRasterFrames,
    incrementalRasterFrames: before.incrementalRasterFrames + 1,
  });
  expect(after.lastLayoutNodes).toBeGreaterThan(0);
  expect(after.lastMeasuredNodes).toBeGreaterThan(0);
  expectDiagnosticSums(host);
  inspect?.();

  const oracle = host.render(true);
  expect(cached).toEqual(oracle);
  expect(geometrySnapshot(host)).toEqual(geometry);
  expect(hitTestGrid(host, surface.size)).toEqual(hits);
  expectDiagnosticSums(host);
}

function oracleScene(host: ReturnType<typeof createPocketTuiHost>): {
  containers: number[];
  leaves: number[];
  directions: number[];
} {
  const outer = view(host, ROOT_ID);
  size(host, outer, 28, 10);
  host.ops.setProp(outer, PROP.paddingL, 1);
  host.ops.setProp(outer, PROP.paddingT, 1);
  host.ops.setProp(outer, PROP.gap, 1);
  const containers = [outer];
  const directions = [ENUM.flexColumn];
  const leaves: number[] = [];
  for (let branch = 0; branch < 3; branch += 1) {
    const column = view(host, outer);
    containers.push(column);
    directions.push(ENUM.flexColumn);
    host.ops.setProp(column, PROP.grow, 1);
    host.ops.setProp(column, PROP.gap, 1);
    for (let row = 0; row < 3; row += 1) {
      const line = view(host, column);
      containers.push(line);
      directions.push(ENUM.flexRow);
      host.ops.setProp(line, PROP.flexDir, ENUM.flexRow);
      host.ops.setProp(line, PROP.grow, 1);
      host.ops.setProp(line, PROP.gap, 1);
      for (let cell = 0; cell < 2; cell += 1) {
        const leaf = text(host, line, `${branch}${row}${cell}`);
        host.ops.setProp(leaf, PROP.grow, 1);
        leaves.push(leaf);
      }
    }
  }
  return { containers, leaves, directions };
}

function hiddenScene(surface: RecordingSurface) {
  const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
  const row = view(host, ROOT_ID);
  size(host, row, 26, 6);
  host.ops.setProp(row, PROP.flexDir, ENUM.flexRow);
  host.ops.setProp(row, PROP.align, ENUM.alignStart);
  host.ops.setProp(row, PROP.gap, 1);
  const hidden = view(host, row);
  const middle = view(host, hidden);
  const hiddenLabel = text(host, middle, "old");
  const sibling = text(host, row, "sibling");
  return { host, row, hidden, middle, hiddenLabel, sibling };
}

function constraintScene(surface: RecordingSurface) {
  const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
  const row = view(host, ROOT_ID);
  size(host, row, 20, 7);
  host.ops.setProp(row, PROP.flexDir, ENUM.flexRow);
  host.ops.setProp(row, PROP.align, ENUM.alignStart);
  const wrapping = view(host, row);
  host.ops.setProp(wrapping, PROP.grow, 1);
  host.ops.setProp(wrapping, PROP.shrink, 1);
  host.ops.setProp(wrapping, PROP.minW, 4);
  host.ops.setProp(wrapping, PROP.maxW, 18);
  const label = text(host, wrapping, "abcdefghij界klmnopqrstuv");
  host.ops.setProp(label, PROP.width, SIZE_FULL);
  const blocker = view(host, row);
  host.ops.setProp(blocker, PROP.basis, 6);
  host.ops.setProp(blocker, PROP.shrink, 0);
  host.ops.setProp(blocker, PROP.height, 2);
  host.ops.setProp(blocker, PROP.bgColor, 0xff33_6688);
  return { host, row, wrapping, label, blocker };
}

function setBoth(
  cached: ReturnType<typeof createPocketTuiHost>,
  oracle: ReturnType<typeof createPocketTuiHost>,
  cachedNode: number,
  oracleNode: number,
  property: number,
  value: number,
): void {
  cached.ops.setProp(cachedNode, property, value);
  oracle.ops.setProp(oracleNode, property, value);
}

function assertTwinRender(
  cached: { host: ReturnType<typeof createPocketTuiHost> },
  oracle: { host: ReturnType<typeof createPocketTuiHost> },
  cachedSurface: RecordingSurface,
  oracleSurface: RecordingSurface,
): void {
  const before = cached.host.diagnostics;
  const incremental = cached.host.render();
  const full = oracle.host.render(true);
  expect(cached.host.diagnostics).toMatchObject({
    fullLayoutFrames: before.fullLayoutFrames,
    cachedLayoutFrames: before.cachedLayoutFrames + 1,
  });
  expect(incremental).toEqual(full);
  expect(geometrySnapshot(cached.host)).toEqual(geometrySnapshot(oracle.host));
  expect(hitTestGrid(cached.host, cachedSurface.size)).toEqual(
    hitTestGrid(oracle.host, oracleSurface.size),
  );
}

function labeledPanel(
  host: ReturnType<typeof createPocketTuiHost>,
  parent: number,
  value: string,
): { panel: number; label: number } {
  const panel = view(host, parent);
  const label = text(host, panel, value);
  host.ops.setProp(panel, PROP.paddingL, 1);
  host.ops.setProp(panel, PROP.paddingR, 1);
  return { panel, label };
}

function view(host: ReturnType<typeof createPocketTuiHost>, parent: number): number {
  const node = host.ops.createNode(NODE.view);
  host.ops.insertBefore(parent, node, 0);
  return node;
}

function text(
  host: ReturnType<typeof createPocketTuiHost>,
  parent: number,
  value: string,
): number {
  const node = host.ops.createNode(NODE.text);
  host.ops.insertBefore(parent, node, 0);
  host.ops.setText(node, value);
  return node;
}

function size(
  host: ReturnType<typeof createPocketTuiHost>,
  node: number,
  width: number,
  height: number,
): void {
  host.ops.setProp(node, PROP.width, width);
  host.ops.setProp(node, PROP.height, height);
}

function requiredRect(host: ReturnType<typeof createPocketTuiHost>, id: number) {
  const rect = host.nodeRect(id);
  expect(rect).toBeDefined();
  return rect!;
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
  const hits: number[] = [];
  for (let y = 0; y < size.rows; y += 1) {
    for (let x = 0; x < size.columns; x += 1) hits.push(host.ops.hitTest(x, y));
  }
  return hits;
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
}
