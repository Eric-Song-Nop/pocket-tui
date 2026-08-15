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

const VIEWPORT = { columns: 96, rows: 40 } as const;
const BRANCHING = 4;
const DEPTH = 4;
const ACTIVE_FRAMES = 64;

class WorkloadSurface implements PocketTuiSurface {
  size: TuiViewportSize = VIEWPORT;
  lastFrame: CanvasFrame | undefined;

  viewportSize(): TuiViewportSize {
    return this.size;
  }

  present(frame: CanvasFrame): void {
    this.lastFrame = frame;
  }

  setCursor(_options: CursorPacketOptions): void {}

  pollInput(): TuiInputEvent[] {
    return [];
  }

  start(): void {}

  flush(): void {}

  close(): void {}
}

describe("PocketJS cached Flex workload", () => {
  test("recomputes only a narrow ancestor path in a balanced retained tree", () => {
    const surface = new WorkloadSurface();
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const tree = host.ops.createNode(NODE.view);
    host.ops.insertBefore(ROOT_ID, tree, 0);
    host.ops.setProp(tree, PROP.width, VIEWPORT.columns);
    host.ops.setProp(tree, PROP.height, VIEWPORT.rows);
    const leaves: number[] = [];
    buildBalancedTree(host, tree, DEPTH, 0, leaves);

    host.render();
    const mounted = host.diagnostics;
    const fullNodeCount = mounted.lastLayoutNodes;
    expect(fullNodeCount).toBe(mounted.liveNodes);
    expect(leaves).toHaveLength(BRANCHING ** DEPTH);
    expect(mounted).toMatchObject({
      fullLayoutFrames: 1,
      localizedLayoutFrames: 0,
      cachedLayoutFrames: 0,
      lastReusedLayoutNodes: 0,
      lastMeasuredNodes: fullNodeCount - 1,
    });

    for (let frame = 0; frame < ACTIVE_FRAMES; frame += 1) {
      const index = (frame * 73 + 19) % leaves.length;
      const leaf = leaves[index]!;
      // Keep intrinsic cell width stable so this measures cache traversal,
      // while dedicated correctness tests cover size-changing text reflow.
      const value = String.fromCharCode(65 + (frame % 26));
      host.ops.setText(leaf, value);
      const before = host.diagnostics;
      host.render();
      const after = host.diagnostics;
      expect({ frame, full: after.fullLayoutFrames }).toEqual({
        frame,
        full: mounted.fullLayoutFrames,
      });
      expect({ frame, cached: after.cachedLayoutFrames }).toEqual({
        frame,
        cached: before.cachedLayoutFrames + 1,
      });
      expect(after.lastLayoutNodes).toBeGreaterThan(0);
      expect(after.lastLayoutNodes).toBeLessThan(fullNodeCount * 0.2);
      expect(after.lastMeasuredNodes).toBeLessThan(fullNodeCount * 0.2);
      expect(after.lastReusedLayoutNodes).toBeGreaterThan(fullNodeCount * 0.7);
    }

    const active = host.diagnostics;
    const laidOut = active.layoutNodes - mounted.layoutNodes;
    const measured = active.measuredNodes - mounted.measuredNodes;
    const reused = active.reusedLayoutNodes - mounted.reusedLayoutNodes;
    const totalPossible = ACTIVE_FRAMES * fullNodeCount;
    expect(active.cachedLayoutFrames - mounted.cachedLayoutFrames).toBe(ACTIVE_FRAMES);
    expect(active.fullLayoutFrames).toBe(mounted.fullLayoutFrames);
    expect(laidOut / totalPossible).toBeLessThan(0.12);
    expect(measured / totalPossible).toBeLessThan(0.12);
    expect(reused / totalPossible).toBeGreaterThan(0.75);
  });
});

function buildBalancedTree(
  host: ReturnType<typeof createPocketTuiHost>,
  parent: number,
  remainingDepth: number,
  ordinal: number,
  leaves: number[],
): void {
  if (remainingDepth === 0) {
    const leaf = host.ops.createNode(NODE.text);
    host.ops.insertBefore(parent, leaf, 0);
    host.ops.setText(leaf, `${ordinal % 10}`);
    host.ops.setProp(leaf, PROP.grow, 1);
    leaves.push(leaf);
    return;
  }

  host.ops.setProp(
    parent,
    PROP.flexDir,
    remainingDepth % 2 === 0 ? ENUM.flexRow : ENUM.flexColumn,
  );
  host.ops.setProp(parent, PROP.gap, 1);
  for (let index = 0; index < BRANCHING; index += 1) {
    const branch = host.ops.createNode(NODE.view);
    host.ops.insertBefore(parent, branch, 0);
    host.ops.setProp(branch, PROP.grow, 1);
    buildBalancedTree(
      host,
      branch,
      remainingDepth - 1,
      ordinal * BRANCHING + index,
      leaves,
    );
  }
}
